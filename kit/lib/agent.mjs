import { makeFinancialLink } from './financial-link.mjs';
import { assertClaimOpen } from '../../rules/src/public-mint.js';
import { submitFinancialCredit } from './financial-credit.mjs';
import { claimFinancialCustody } from './financial-custody.mjs';
import { encodeTracAddress, decodeTracAddress, publicIdentities, wireIdentities } from '../../rules/src/trac-address.js';
import { stableJSON, validatePayload, patternAmount, compound, patternProperties, patternAsset, claimWindow, acceptMintRequest, evaluateDiscovery, discoveryCommitment, DISCOVERY_LIMITS, verifyRootAttestations, linkId, CLAIM_DEFAULTS, moveId } from '../../rules/src/index.js';
import { financialMintId as pendingId } from '../../rules/src/financial-mint.js';
import { makeFinancialMint } from './financial-mint.mjs';
import { craftNamed, refineCompoundNamed } from './craft-v2.mjs';
import { transferNamed } from './transfer-v2.mjs';
import { check, sha256, nonce, integer, hex32, gatewayOrigin } from './check.mjs';
import { publicKey } from './keyring.mjs';
import { signMove, signOwnerRequest, signPaymentIntent, signPlotRequest, mintExpiry, paymentPayer } from './signing.mjs';
import { checkedHeader, assertHeaderChain, loadClaimHeaders } from './headers.mjs';
import { checkProposal } from './search.mjs';
import { chooseClaims } from '../strategies/default.mjs';
import { transactionCommand } from './trac.mjs';
import { amountView } from './reads.mjs';
import { bitcoinAddress } from './addresses.mjs';
import { bindingMessage, bindingId, payoutAddress, verifyBinding } from '../../rules/src/payout-bindings.mjs';
import { signBytes } from './signing.mjs';
import { PlayerMint } from './player-mint.mjs';
import { proposeNamed, revealNamed, addNamedOccurrences, sendNamedMove } from './named-discovery.mjs';
import { validateSettingsDocument, hashObject, activationManifest, moveIdV2, RESOURCE_PROFILE, validateResources, safeNumberV2 } from '../../rules/src/index.js';
import { requireKitVersion, resumeLegacyFinancial } from './upgrade.mjs';
import { readInteger, patternId, nextCursor, claimSelection, isAsset } from './api-values.mjs';
import { tnkBalance, prepareTnkTransfer, sendTnkTransfer, tnkTransferStatus } from './tnk.mjs';

export class Agent {
  tnkBalance() { return tnkBalance(this); }
  prepareTnkTransfer(args) { return prepareTnkTransfer(this, args); }
  sendTnkTransfer(args) { return sendTnkTransfer(this, args); }
  tnkTransferStatus(actionId) { return tnkTransferStatus(this, actionId); }
  useCredit(args) { return this.exclusive(() => submitFinancialCredit(this, args)); }
  transferCredit(args) { return this.exclusive(() => submitFinancialCredit(this, args)); }
  claimCustody(args) { return this.exclusive(() => claimFinancialCustody(this, args)); }
  constructor({ wallet, network, service, trac, journal, bitcoinWallet, dryRun = true, puzzleBits = 12, powLimitBits = 0x1d00ffff, work = {}, resources = RESOURCE_PROFILE, paymentOrigin, owner = {}, bitcoinNetwork = powLimitBits === 0x207fffff ? 'regtest' : 'mainnet' } = {}) {
    check(wallet && service && trac && journal && typeof network === 'string', 'Signer, local clients and journal required');
    check(service.network === network && trac.network === network, 'Client network mismatch');
    if (paymentOrigin) gatewayOrigin(paymentOrigin, service?.mode ?? 'regtest');
    Object.assign(this, { wallet, network, service, trac, journal, dryRun, puzzleBits, powLimitBits, work, paymentOrigin });
    this.resources = Object.freeze(structuredClone(validateResources(resources)));
    check(['regtest', 'mainnet'].includes(bitcoinNetwork), 'Invalid Bitcoin network');
    this.bitcoinNetwork = bitcoinNetwork;
    this.bitcoinWallet = bitcoinWallet;
    this.playerMint = new PlayerMint({ service, journal, wallet: bitcoinWallet, owner: encodeTracAddress(publicKey(wallet)), dryRun });
    this.playerLink = new PlayerMint({ service: { mintStatus: id => service.linkStatus(id), mintPaymentPlan: id => service.linkStatus(id), reportMintPayment: value => service.reportLinkPayment(value) },
      journal, wallet: bitcoinWallet, owner: encodeTracAddress(publicKey(wallet)), dryRun });
    this.ownerConfig = Object.freeze({ receiver: Object.freeze({ ...owner.receiver }), payer: Object.freeze({ ...owner.payer }) });
    this.owner = publicKey(wallet); this.address = encodeTracAddress(this.owner); this.tail = Promise.resolve();
  }
  exclusive(fn) {
    const result = this.tail.then(fn).then(publicIdentities);
    this.tail = result.catch(() => {});
    return result;
  }
  async reconcileAction(id) {
    const row = this.journal.get(id);
    if (id.startsWith('tnk/')) { await tnkTransferStatus(this, id.slice(4)); return; }
    if (!row || ['prepared', 'refused', 'accepted', 'rejected'].includes(row.state)) return;
    if (row.body.version === 2 && !row.body.t || id.endsWith('/witnesses-v2')) return;
    if (id.startsWith('payout/')) {
      const value = wireIdentities(await this.service.payoutBinding(this.address, row.body.request.rail));
      if (value.binding) {
        verifyBinding(value.binding, { network: this.network, bitcoinNetwork: this.bitcoinNetwork, members: this.service.receiptSigners });
        check(value.binding.request.agent === this.owner && value.binding.request.rail === row.body.request.rail, 'Payout binding mismatch');
        if (value.binding.id === bindingId(this.network, this.bitcoinNetwork, row.body.request)) this.journal.mark(id, 'accepted', { ...row.result, binding: value.binding });
      }
      return;
    }
    if (id.startsWith('discovery/') && !row.body.t) {
      const reveal = this.journal.get(id + '/reveal');
      if (!reveal) return;
      const commitment = discoveryCommitment(row.body.proposal, row.body.salt, this.owner);
      const matches = p => ['name', 'pat', 'fld', 'dt'].every(k => p[k] === row.body.proposal[k]) &&
        (p.amountMode ?? 'count') === (row.body.proposal.amountMode ?? 'count');
      const found = (await this.catalog()).find(p => p.discoverer === this.address && matches(p));
      let cursor; const seen = new Set();
      do {
        const page = await this.events({ type: 'discovery', order: 'desc', limit: 200, cursor });
        const rejection = page.events.find(e => e.data?.commitment === commitment && e.data.state === 'rejected');
        if (rejection) { this.journal.observe(id, 'rejected', { source: 'public_events', sequence: rejection.sequence, reason: rejection.data.reason, provenance: rejection.provenance }); return; }
        cursor = page.next;
        check(!cursor || !seen.has(cursor), 'Repeated discovery event cursor'); seen.add(cursor);
      } while (cursor);
      if (found) {
        // A second commitment for the same definition may still be queued;
        // wait for that evaluation before attributing the accepted catalog row.
        let cursor; const seen = new Set();
        do {
          const page = await this.profile(this.address, { collection: 'discoveries', state: 'revealed', limit: 200, cursor });
          if (page.discoveries.some(matches)) return;
          cursor = page.next; check(!cursor || !seen.has(cursor), 'Repeated discovery cursor'); seen.add(cursor);
        } while (cursor);
        this.journal.observe(id, 'accepted', { source: 'public_catalog', asset: patternId(found) });
      }
    } else if (row.body.t) {
      if (row.body.v === 2) throw Object.assign(new Error('V2 accepted batch inclusion verifier required; saved packet retained'), { code: 'v2_batch_verifier_required' });
      const proof = await this.receiptInclusion(row.body, { receipt: row.result ?? undefined });
      const state = proof.reportedOutcome === 'accepted' ? 'accepted' : 'rejected';
      const evidence = { source: 'witnessed_audit', reason: proof.reportedOutcome, publication: proof.publication, contractCommitted: proof.contractCommitted };
      if (!row.result) this.journal.mark(id, row.state, proof.receipt);
      this.journal.observe(id, state, evidence);
      if (row.body.t === 'discovery-reveal' && state === 'rejected') this.journal.observe(id.slice(0, -7), state, evidence);
    } else if (id.startsWith('tx/') && row.body.tx && this.trac.transactionStatus) {
      const result = await this.trac.transactionStatus(row.body.tx);
      if (['accepted', 'rejected'].includes(result.state)) this.journal.observe(id, result.state, { source: 'transaction_status', tx: row.body.tx, state: result.state, reason: result.reason ?? null });
    }
  }
  async reconcileActions(ids) {
    const unavailable = [];
    for (const id of ids) {
      try { await this.reconcileAction(id); }
      catch (error) { unavailable.push({ id, reason: error.code ?? 'public_outcome_unavailable' }); }
    }
    return unavailable;
  }
  async status() {
    const reconciliationPending = await this.reconcileActions(this.journal.recent().map(row => row.id));
    const actions = this.journal.recent().filter(row => !row.id.endsWith('/reservation-v2')).map(row => {
      const kind = row.id.split('/')[0], digest = { mint: pendingId, link: linkId }[kind];
      const evidence = this.journal.evidence(row.id);
      const savedMove = this.journal.get(row.id);
      if (kind === 'tnk') return { ...row, ...evidence, tx: savedMove.body.packet?.tx ?? null,
        statusTool: { name: 'tnk_transfer_status', arguments: { actionId: row.id.slice(4) } } };
      if (savedMove.body.t && ['unknown', 'refused'].includes(row.state)) return { ...row, ...evidence, move: (savedMove.body.v === 2 ? moveIdV2 : moveId)(savedMove.body),
        ...(row.state === 'refused' ? { refusal: savedMove.result, retry: 'Retry the original action ID and intent; the kit will refresh the refused packet.' } : {}) };
      if (kind.startsWith('bitcoin-')) {
        const saved = this.journal.get(row.id), plan = saved.body.plan, deploy = kind === 'bitcoin-deploy';
        return { ...row, ...evidence, requestId: saved.body.requestId, ...(deploy ? { asset: saved.body.asset } : {}),
          inscriptionId: plan.inscriptionId, receiver: plan.receiver, feeSats: plan.feeSats,
          resumeTool: { name: deploy ? 'inscribe_deployment' : kind === 'bitcoin-pay' ? 'pay_mint' : 'inscribe_mint',
            arguments: { ...(deploy ? { asset: saved.body.asset } : { id: saved.body.requestId }), maxFeeSats: plan.feeSats } } };
      }
      if (!digest) return { ...row, ...evidence };
      const saved = this.journal.get(row.id), requestId = digest(this.network, saved.body.request);
      return { ...row, ...evidence, requestId, requestState: saved.result?.request?.state ?? null,
        paymentLink: this.service.paymentLink(requestId, this.paymentOrigin, kind),
        ...(kind === 'mint' ? { statusTool: { name: 'mint_status', arguments: { id: requestId } } } : {}) };
    });
    return { address: this.address, dryRun: this.dryRun, head: await this.trac.head(), actions, reconciliationPending,
      note: 'Accepted/rejected states come from public outcomes; delivery states remain until evidence is available. Witnessed audit outcomes are not contract proofs. Payment requests require their own service progress.' };
  }
  block(height, options = {}) { return this.service.block(height, { ...(options.collection === 'mintRights' ? { owner: this.address } : {}), ...options }); }
  async mintStatus(id) {
    if (!hex32(id)) {
      check(typeof id === 'string' && id.startsWith('mint/'), 'Use a mint request ID or the mint/actionId from status');
      const row = this.journal.get(id); check(row?.body.request, 'Mint action is absent from this signer journal');
      id = pendingId(this.network, row.body.request);
    }
    return this.service.mintStatus(id);
  }
  mintRights(options) { return this.service.mintRights(this.address, options); }
  mintQuote(args) { return this.service.mintQuote(args); }
  bindPayoutWallet({ actionId, rail, address }) {
    return this.exclusive(async () => {
      this.actionId(actionId);
      address = address ?? this.ownerConfig.payer[rail];
      if (rail === 'ethereum' && typeof address === 'string') address = address.toLowerCase();
      payoutAddress(rail, address, this.bitcoinNetwork);
      const id = 'payout/' + actionId, intent = { rail, address }, old = this.journal.get(id);
      if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting payout action ID');
      if (!this.dryRun && old?.result) return { ...old.result, replayed: true };
      let request = old?.body.request;
      if (!request) {
        const current = wireIdentities((await this.service.payoutBinding(this.address, rail)).binding);
        if (current) {
          verifyBinding(current, { network: this.network, bitcoinNetwork: this.bitcoinNetwork, members: this.service.receiptSigners });
          check(current.request.agent === this.owner && current.request.rail === rail, 'Payout binding mismatch');
        }
        const next = BigInt(current?.request.nonce ?? '0') + 1n, now = Date.now();
        request = { agent: this.owner, rail, address, nonce: (next > BigInt(now) ? next : BigInt(now)).toString(), expiry: now + 3600000 };
      }
      if (this.dryRun) return { state: 'dry-run', request, signed: false };
      const body = old?.body ?? { request, agentSignature: signBytes(this.wallet, Buffer.from(bindingMessage(this.network, this.bitcoinNetwork, request))) };
      this.journal.reserve(id, intent, body); this.journal.mark(id, 'sending');
      try {
        const pending = wireIdentities(await this.service.requestPayoutBinding(body)), expected = bindingId(this.network, this.bitcoinNetwork, request);
        check(pending.id === expected && stableJSON(pending.request) === stableJSON(request), 'Payout request mismatch');
        const result = { state: 'awaiting_wallet', request: pending, bindingLink: this.service.origin + '/bind-payout/' + expected };
        this.journal.mark(id, 'submitted', result); return result;
      } catch (error) { this.journal.mark(id, 'unknown'); throw error; }
    });
  }
  events(options) { return this.service.events(options); }
  results(options) { return this.service.results(options); }
  agents(options) { return this.service.agents(options); }
  profile(owner = this.address, options) { return this.service.profile(owner, options); }
  async balance(asset) {
    check(isAsset(asset), 'Invalid asset');
    return { asset, ...amountView(await this.trac.balance(this.owner, asset), { currency: asset, denomination: 'unit', decimals: 0 }) };
  }
  async hunting(options) {
    const head = await this.trac.head(), page = this.journal.hunting(options), items = [];
    for (const row of page.items) {
      if (row.type === 'discovery') {
        items.push({ ...row, phase: row.revealState && row.revealState !== 'refused' ? 'check_reveal' : row.receiptTip === null ? 'receipt_unknown' : head.tip.height < row.revealFrom ? 'sealed' : head.tip.height > row.revealUntil ? 'expired' : 'reveal_window' });
        continue;
      }
      let settlement = this.journal.evidence(row.id).settlement;
      if (row.type === 'header') {
        try {
          const block = settlement ?? await this.service.block(row.headerBlock);
          const window = row.headerBlock;
          check(integer(window), 'Header claim window unavailable');
          Object.assign(row, { window, closesAt: window + 2, drawAt: window + 2, settlesWhenCounted: window + 2, settlesAt: row.ruleset === 'dmw-v2' ? null : window + 2 });
        } catch { items.push({ ...row, phase: 'check_settlement' }); continue; }
      }
      const tracked = row.plots.map(p => ({ ...p }));
      if (row.headerBlock !== null && row.headerBlock !== undefined && !tracked.some(p => p.block === row.headerBlock)) tracked.push({ block: row.headerBlock, patterns: [] });
      let phase = head.tip.height < row.closesAt ? 'claim_window' : head.tip.height < row.drawAt ? 'awaiting_draw' : head.counted < row.settlesWhenCounted ? 'awaiting_counted_draw' : 'check_settlement';
      if (!settlement && phase === 'check_settlement') {
        const plots = [];
        try {
          if (row.ruleset === 'dmw-v2') {
            // V3 draws are individual winner rows, not v1 aggregate rounds.
            // Empty pages cannot prove a loss while deferred awards exist.
            const observedWins = [];
            for (const plot of tracked) {
              let cursor; const seen = new Set();
              do {
                const page = await this.service.block(plot.block, { collection: 'draws', window: row.window, limit: 50, cursor });
                check(page.v === 3 && Array.isArray(page.draws), 'Invalid v2 draw page');
                for (const winner of page.draws) if (readInteger(winner.window) === row.window && readInteger(winner.block) === plot.block &&
                  winner.winner === this.address && (plot.patterns.includes(readInteger(winner.pattern)) || winner.source === 'header' && row.headerBlock === plot.block)) observedWins.push(winner);
                cursor = nextCursor(page); check(!cursor || !seen.has(cursor), 'Repeated draw cursor'); seen.add(cursor);
              } while (cursor);
            }
            items.push({ ...row, phase: observedWins.length ? 'won_pending_settlement' : 'check_settlement', observedWins, settlementComplete: false,
              next: { tool: 'window_eligibility', arguments: { window: row.window } } });
            continue;
          }
          for (const plot of tracked) {
            const page = await this.service.block(plot.block, { collection: 'draws', window: row.window, limit: 200 });
            const draw = page.draws.find(d => readInteger(d.window) === row.window && d.settledAt != null && integer(readInteger(d.settledAt)));
            if (!draw) break;
            const winners = [...draw.winners];
            let cursor = draw.pages?.winners?.next;
            while (cursor) { const more = await this.service.readPage(draw.pages.winners.route, { cursor, limit: 200 }); winners.push(...more.items); cursor = more.next; }
            const won = draw.void ? [] : winners.filter(w => readInteger(w.block) === plot.block && w.winner === this.address && (plot.patterns.includes(readInteger(w.pattern)) || w.source === 'header' && row.headerBlock === plot.block));
            plots.push({ block: plot.block, settledAt: draw.settledAt, void: !!draw.void, reason: draw.reason ?? null, wins: won.map(w => ({ asset: w.asset, pattern: w.pattern, count: w.count, source: w.source ?? 'claim' })), provenance: draw.provenance ?? null });
          }
          if (plots.length === tracked.length) {
            settlement = { window: row.window, phase: plots.some(p => p.wins.length) ? 'won' : 'lost', source: 'public_draws', plots };
            this.journal.settle(row.id, settlement);
          }
        } catch { /* Leave the explicit check_settlement phase until public evidence is available. */ }
      }
      items.push({ ...row, phase: settlement?.phase ?? phase, ...(settlement ? { settlement } : {}) });
    }
    return { ...page, items, owner: this.address, tip: head.tip.height, counted: head.counted, source: 'local-journal',
      note: 'Won/lost uses public settled draws. Other phases estimate timing; check block and verify_claim for evidence. A reorg never reopens a closed claim window.' };
  }
  async catalog() {
    const rows = [], cursors = new Set(); let cursor, total, version, revision, pages = 0;
    do {
      const page = await this.service.patterns({ cursor, sort: 'number', order: 'asc' });
      const bounded = page.v === 3, next = nextCursor(page);
      check(++pages <= 100000 && (bounded && page.total === null || integer(page.total) && page.total <= 100000), 'Invalid catalog size');
      if (pages === 1) { total = page.total; version = bounded; revision = page.revision; }
      check(bounded === version && (!bounded || typeof page.revision === 'string' && /^(0|[1-9][0-9]*)$/.test(page.revision) && page.revision === revision), 'Catalog changed during read');
      check(page.total === total && Array.isArray(page.patterns) && integer(page.limit) && page.limit >= 1 && page.limit <= 200 &&
        page.patterns.length <= page.limit, 'Invalid catalog page');
      rows.push(...page.patterns.map(p => bounded ? { ...p, number: safeNumberV2(p.number) } : p));
      check(rows.length <= 100000 && (total === null || rows.length <= total) &&
        (next === null || (bounded || page.patterns.length > 0) && !cursors.has(next)), 'Catalog changed during read');
      cursor = next; if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    check((total === null || rows.length === total) && rows.every(p => integer(p.number)) && new Set(rows.map(p => p.number)).size === rows.length, 'Catalog changed during read'); return rows;
  }
  async sendMove(id, type, payload, { intent = payload, validate = async () => {} } = {}) {
    if (['header', 'claim'].includes(type)) {
      const context = await this.namedContext();
      if (context) {
        const old = this.journal.get(id);
        check(!old || old.body.v === 2, 'Saved legacy action must be reconciled before a v2 submission');
        const header = h => ({ height: String(h.height), raw: h.raw });
        const value = type === 'header' ? header(payload) : { window: String(payload.window),
          plots: payload.plots.map(p => ({ block: String(p.block), patterns: p.patterns.map(String) })),
          ...(payload.header ? { header: header(payload.header) } : {}) };
        return sendNamedMove(this, id, type + '-v2', value, context.settings, validate);
      }
    }
    validatePayload(type, payload);
    const old = this.journal.get(id);
    if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting action refused; use the saved intent');
    if (!this.dryRun && old && ['received', 'accepted', 'rejected'].includes(old.state)) return { state: old.state, receipt: old.result, inclusion: old.state === 'received' ? 'unverified' : 'witnessed', replayed: true };
    const head = await this.trac.head(); await validate(head);
    if (this.dryRun) return { state: 'dry-run', action: type, payload, tip: head.tip, signed: false };
    let row = old;
    const prepare = async head => {
      const move = await signMove(this.wallet, { network: this.network, type, payload, tip: head.tip }, { puzzleBits: this.puzzleBits, ...this.work });
      const fresh = await this.trac.head();
      check(fresh.tip.height === head.tip.height && fresh.tip.hash === head.tip.hash, 'Tip changed while solving; retry with fresh context');
      await validate(fresh);
      row = row ? this.journal.renewMove(id, intent, move, row) : this.journal.reserve(id, intent, move);
    };
    if (!row || row.state === 'refused') await prepare(head);
    await this.journal.waitTurn(async () => {
      const fresh = await this.trac.head(); await validate(fresh);
      const move = row.body;
      if (!(move.b <= fresh.tip.height && move.b >= fresh.tip.height - 2 && await this.trac.hashAt(move.b) === move.h)) {
        check(row.state === 'prepared', 'Saved move is stale and its delivery is unknown; retain the journal and reconcile its receipt. Only a recorded refusal can be refreshed.');
        await prepare(fresh);
      }
      if (type === 'claim') check(claimWindow(row.body.p.window, fresh.tip.height), 'Claim window is closed');
      return fresh;
    });
    this.journal.mark(id, 'sending');
    try {
      const receipt = await this.service.submit(row.body, { hashAt: h => this.trac.hashAt(h) }); this.journal.mark(id, 'received', receipt);
      return { state: 'received', receipt, inclusion: 'unverified' };
    } catch (e) {
      // A refusal on a retry cannot settle an earlier ambiguous attempt.
      const refused = e.refusedBeforeAcceptance === true && row.state === 'prepared';
      const refusal = e.refusedBeforeAcceptance === true ? { status: e.status, code: e.code, source: 'gateway_response', move: moveId(row.body) } : null;
      this.journal.mark(id, refused ? 'refused' : 'unknown', refused ? refusal : null);
      if (refused) e.message += '; refused, not accepted by the gateway; retry the same action ID and intent with a fresh packet';
      throw e;
    } finally { this.journal.finishTurn(); }
  }
  recoverRefusedReveal({ actionId, move, status, code, confirmOriginalRefusal }) {
    return this.exclusive(async () => {
      this.actionId(actionId);
      check(status === 429 && code === 'reveal_capacity' && confirmOriginalRefusal === true,
        'Confirm the original HTTP 429 reveal_capacity response for this exact packet; never use recovery for a timeout or lost response');
      const id = `discovery/${actionId}/reveal`, row = this.journal.get(id);
      check(row?.body.t === 'discovery-reveal' && hex32(move) && moveId(row.body) === move, 'Saved reveal packet does not match the supplied move ID');
      const parent = this.journal.get(`discovery/${actionId}`), commit = this.journal.get(`discovery/${actionId}/commit`);
      check(parent && commit && stableJSON(row.body.p) === stableJSON(parent.body) &&
        discoveryCommitment(parent.body.proposal, parent.body.salt, this.owner) === commit.body.p.commitment, 'Saved discovery commitment mismatch');
      check(row.state === 'unknown' && !row.result && this.journal.moveHistory(id).length === 0,
        'Recovery requires a legacy unknown reveal without a receipt or recorded attempts');
      if (this.dryRun) return { state: 'dry-run', actionId, move, sent: false, changed: false };
      this.journal.recoverLegacyRefusal(id, row, { status, code, move, source: 'owner_confirmed_original_response' });
      return { state: 'refused', actionId, move, sent: false, next: { tool: 'reveal_pattern', arguments: { actionId } },
        message: 'Original packet and refusal record preserved. Retry reveal_pattern with this same action ID after the next Bitcoin block.' };
    });
  }
  headers({ height, raw, history }) {
    return this.exclusive(() => this.sendMove(`header/${height}`, 'header', { height, raw }, { validate: async head => {
      check(claimWindow(height, head.tip.height), 'Header window is closed');
      const expected = await this.trac.hashAt(height) ?? history?.get(height).hash;
      await assertHeaderChain({ history, height, hash: expected, trac: this.trac, head });
      checkedHeader(raw, height, expected, { powLimitBits: this.powLimitBits, previous: height ? await this.trac.hashAt(height - 1) : undefined });
    } }));
  }
  claim({ event, plots, history, patterns, header }) {
    return this.exclusive(async () => {
      check(event && integer(event.window) && hex32(event.hash), 'Invalid claim window');
      const payload = { window: event.window, plots, ...(header ? { header } : {}) };
      return this.sendMove(`claim/${event.window}`, 'claim', payload, { validate: async head => {
        check(claimWindow(event.window, head.tip.height) && await this.trac.hashAt(event.window) === event.hash, 'Claim event is closed or reorganized');
        if (header) {
          check(header.height === event.window, 'Header must belong to this claim window');
          const h = checkedHeader(header.raw, header.height, history.get(header.height).hash, { powLimitBits: this.powLimitBits });
          await assertHeaderChain({ history, height: header.height, hash: h.hash, trac: this.trac, head });
        }
        const settings = await this.trac.settings(), budget = settings.values?.claimsPerWindow ?? settings.claimsPerWindow ?? CLAIM_DEFAULTS.claimsPerWindow;
        check(plots.reduce((n, q) => n + q.patterns.length, 0) <= budget, 'Claim budget exceeded');
        for (const q of plots) {
          check(q.block <= (event.claimableHeight ?? head.counted) || q.block === event.window, 'Claim block is not counted');
          const h = checkedHeader(history.raw(q.block), q.block, history.get(q.block).hash, { powLimitBits: this.powLimitBits });
          await assertHeaderChain({ history, height: q.block, hash: h.hash, trac: this.trac, head });
          for (const n of q.patterns) {
            const p = patterns.find(p => String(p.number) === String(n)); check(p && patternAmount(p, h) !== '0', 'Claimed pattern does not match');
            assertClaimOpen({ pattern: p, block: q.block, height: head.tip.height, settings });
          }
        }
      } });
    });
  }
  receiptInclusion(move, options = {}) {
    const renewal = Object.fromEntries(['batchRoot', 'settingsByHash', 'renewalSlice']
      .filter(name => typeof this.trac[name] === 'function').map(name => [name, (...args) => this.trac[name](...args)]));
    return this.service.inclusion(move, { ...options, hashAt: h => this.trac.hashAt(h), renewal });
  }
  async claimInclusion({ window, publication, commitment }) {
    check(integer(window), 'Invalid claim window');
    const saved = this.journal.get(`claim/${window}`); check(saved, 'No saved claim');
    return this.receiptInclusion(saved.body, { publication, commitment, receipt: saved.result ?? undefined });
  }
  discoveryAnalysis(proposal, history, patterns, head) {
    const analysis = checkProposal({ proposal, history, tip: head.tip, existing: patterns, owner: this.owner });
    evaluateDiscovery({ proposal, discoverer: this.owner, history: { length: head.counted + 1, field: (...a) => history.field(...a), get: h => history.get(h) }, existing: patterns, number: analysis.record.number });
    return analysis.record;
  }
  async namedContext() {
    const active = await this.trac.settings();
    if (active.ruleset !== 'dmw-v2' && active.batchVersion !== 2) return null;
    check(typeof this.trac.rulesContext === 'function', 'upgrade_required: activated rules proof adapter required');
    const context = await this.trac.rulesContext(); validateSettingsDocument(context.settings);
    const manifest = activationManifest(context.manifest, context.manifestHash);
    requireKitVersion(manifest.minimumKitVersion);
    check(context.settings.network === this.network && manifest.network === this.network && hashObject(context.settings) === context.settingsHash, 'Activated settings mismatch');
    return context;
  }
  submitOccurrences(args) {
    return this.exclusive(async () => { const context = await this.namedContext(); check(context, 'upgrade_required: named occurrences require v2 activation'); return addNamedOccurrences(this, args, context); });
  }
  propose({ actionId, proposal, history, patterns, witnesses }) {
    return this.exclusive(async () => {
      const context = await this.namedContext(); if (context) return proposeNamed(this, { actionId, proposal, history, witnesses }, context);
      this.actionId(actionId); const id = `discovery/${actionId}`, old = this.journal.get(id);
      if (old) check(old.fingerprint === sha256(stableJSON(proposal)), 'Conflicting discovery action ID');
      if (this.dryRun || !old) this.discoveryAnalysis(proposal, history, patterns, await this.trac.head());
      if (this.dryRun) return { state: 'dry-run', action: 'discovery-commit', actionId, signed: false };
      // Persist the secret before any commitment can leave the process. A
      // competing signer connection must use the winning reservation's salt.
      const saved = old ?? this.journal.reserve(id, proposal, { proposal, salt: nonce() });
      const commitment = discoveryCommitment(saved.body.proposal, saved.body.salt, this.owner);
      const result = await this.sendMove(`${id}/commit`, 'discovery-commit', { commitment }, {
        validate: head => this.discoveryAnalysis(saved.body.proposal, history, patterns, head)
      });
      return { ...result, actionId, phase: 'commit', commitment, revealFrom: result.receipt.tip + 2, revealUntil: result.receipt.tip + DISCOVERY_LIMITS.lifetime };
    });
  }
  reveal({ actionId, publication, history, patterns, witnesses }) {
    return this.exclusive(async () => {
      const context = await this.namedContext(); if (context) return revealNamed(this, { actionId, history, witnesses }, context);
      this.actionId(actionId); const id = `discovery/${actionId}`, saved = this.journal.get(id), committed = this.journal.get(`${id}/commit`);
      check(saved && committed, 'No saved discovery commitment');
      const payload = { proposal: saved.body.proposal, salt: saved.body.salt };
      check(discoveryCommitment(payload.proposal, payload.salt, this.owner) === committed.body.p.commitment, 'Saved discovery commitment mismatch');
      const old = this.journal.get(`${id}/reveal`);
      if (!this.dryRun && old && ['received', 'accepted', 'rejected'].includes(old.state)) return { state: old.state, receipt: old.result, inclusion: old.state === 'received' ? 'unverified' : 'witnessed', phase: 'reveal', actionId, replayed: true };
      let certificate = saved.result;
      if (!certificate) {
        certificate = await this.receiptInclusion(committed.body, { publication, receipt: committed.result ?? undefined });
        check(certificate.reportedOutcome === 'accepted', 'Discovery commitment was not accepted in the observation');
        if (!this.dryRun) {
          this.journal.mark(`${id}/commit`, 'received', certificate.receipt);
          this.journal.mark(id, 'submitted', certificate);
        }
      }
      check(verifyRootAttestations(certificate.seal, certificate.attestations, this.service.receiptSigners), 'Invalid discovery witness quorum');
      const validate = async head => {
        check(head.tip.height >= certificate.receipt.tip + 2 && head.tip.height <= certificate.receipt.tip + DISCOVERY_LIMITS.lifetime, 'Discovery reveal window is closed or not yet open');
        check(await this.trac.hashAt(certificate.receipt.tip) === certificate.receipt.hash, 'Discovery commitment was reorganized');
        this.discoveryAnalysis(payload.proposal, history, patterns, head);
      };
      if (this.dryRun) { await validate(await this.trac.head()); return { state: 'dry-run', action: 'discovery-reveal', actionId, signed: false }; }
      const result = await this.sendMove(`${id}/reveal`, 'discovery-reveal', payload, { validate });
      return { ...result, phase: 'reveal', actionId };
    });
  }
  linkBitmap(args) { return this.plotRequest('link', args); }
  plotRequest(kind, { actionId, height, payer }) {
    return this.exclusive(async () => {
      this.actionId(actionId);
      payer = bitcoinAddress(payer ?? this.ownerConfig.payer.tap, this.bitcoinNetwork, 'payer');
      const context = await this.namedContext();
      if (context) return await resumeLegacyFinancial(this, 'link', actionId, { height, payer }) ?? makeFinancialLink(this, { actionId, height, payer }, context);
      check(kind === 'link' && integer(height), 'Invalid plot request');
      const id = `${kind}/${actionId}`, intent = { height, payer }, old = this.journal.get(id);
      if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting plot action ID');
      if (!this.dryRun && old && ['submitted', 'accepted', 'rejected'].includes(old.state)) return { ...old.result, state: old.state, replayed: true };
      const head = await this.trac.head(); check(height <= head.tip.height, 'Plot is ahead of Bitcoin tip');
      const request = old?.body.request ?? { owner: this.owner, height, nonce: nonce(), until: head.counted + 12 };
      const requestId = linkId(this.network, request), paymentLink = this.service.paymentLink(requestId, this.paymentOrigin, kind);
      if (this.dryRun) return { state: 'dry-run', action: kind, request, payer, signed: false };
      const body = old?.body ?? { request, sig: signPlotRequest(this.wallet, kind, this.network, request, head.counted), payer };
      const row = this.journal.reserve(id, intent, body);
      // An acknowledged-but-lost request can be recovered after its admission
      // deadline. Preserve its packet and let the service resolve that ID.
      await this.journal.waitTurn(() => this.trac.head());
      this.journal.mark(id, 'sending');
      try {
        const response = await this.service.requestLink(row.body);
        check(response.id === requestId && response.terms?.payer === payer, 'Plot request ID or payer mismatch');
        const result = { state: 'submitted', request: response, paymentLink };
        this.journal.mark(id, 'submitted', result); return result;
      } catch (e) { this.journal.mark(id, 'unknown'); throw e; } finally { this.journal.finishTurn(); }
    });
  }
  craft({ actionId, recipe = 'fusion', inputs, patterns, compounds = [] }) {
    return this.exclusive(async () => {
      const context = await this.namedContext(); if (context) return craftNamed(this, { actionId, recipe, inputs }, context);
      this.actionId(actionId); const id = `craft/${actionId}`, intent = { recipe, inputs };
      const old = this.journal.get(id), head = await this.trac.head();
      if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting craft action ID');
      const result = compound(recipe, inputs.map(([asset, amount]) => {
        const pattern = patterns.find(p => patternAsset(p) === asset), properties = pattern ? patternProperties(pattern) : compounds.find(c => c.id === asset)?.properties;
        return { asset, amount, properties };
      }), head.counted + 1);
      if (!old) for (const [asset, amount] of inputs) check(BigInt(await this.trac.balance(this.owner, asset)) >= BigInt(amount), 'Insufficient craft balance');
      const request = old?.body.p.request ?? { owner: this.owner, in: inputs, out: [[result.id, result.amount]], nonce: nonce(), until: head.counted + 12 };
      const payload = old?.body.p ?? { recipe, request, sig: this.dryRun ? '0'.repeat(128) : signOwnerRequest(this.wallet, 'xc', this.network, request, head.counted) };
      return { ...await this.sendMove(id, 'craft', payload, { intent }), compound: result };
    });
  }
  refineCompound(args) {
    return this.exclusive(async () => { const context = await this.namedContext(); check(context, 'upgrade_required: compound continuation requires v2'); return refineCompoundNamed(this, args, context); });
  }
  actionId(id) { check(typeof id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(id), 'Choose a stable action ID (1–64 letters, numbers, dot, dash or underscore)'); }
  transaction({ actionId, op, value }) {
    return this.exclusive(async () => {
      this.actionId(actionId); check(op === 'tf', 'Only transfers are permitted');
      const context = await this.namedContext(); if (context) return transferNamed(this, { actionId, value }, context);
      value = { ...value, to: decodeTracAddress(value.to) }; transactionCommand(op, value);
      const id = `tx/${actionId}`, intent = { op, value }, old = this.journal.get(id);
      check(!this.journal.get(`${id}/v2-intent`), 'transfer_v2_unavailable');
      if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting transaction action ID');
      if (!this.dryRun && old && ['submitted', 'accepted', 'rejected'].includes(old.state)) return { ...old.result, tx: old.body.tx, state: old.state, replayed: true };
      if (this.dryRun) { await this.trac.preflight(this.owner, op, value); return { state: 'dry-run', op, value, feeSource: this.owner, signed: false }; }
      const row = old ?? this.journal.reserve(id, intent, await this.trac.prepare(this.wallet, op, value));
      if (old && this.trac.transactionStatus) {
        const status = await this.trac.transactionStatus(row.body.tx);
        if (status.state === 'accepted') { const result = { tx: row.body.tx, state: 'accepted' }; this.journal.observe(id, 'accepted', { source: 'transaction_status', tx: row.body.tx, state: 'accepted' }); return result; }
        check(status.state !== 'rejected', 'Saved transaction was rejected; inspect its state before choosing a new action ID');
      }
      await this.journal.waitTurn(() => this.trac.preflight(this.owner, op, value));
      this.journal.mark(id, 'sending');
      try { const result = await this.trac.submit(row.body); this.journal.mark(id, 'submitted', result); return result; }
      catch (e) { this.journal.mark(id, 'unknown'); throw e; } finally { this.journal.finishTurn(); }
    });
  }
  paymentAddresses({ receiver, payer, kind = 'tap' }) {
    receiver = bitcoinAddress(receiver ?? this.ownerConfig.receiver.bitcoin, this.bitcoinNetwork, 'receiver');
    payer ??= this.ownerConfig.payer[kind];
    payer = kind === 'tap' ? bitcoinAddress(payer, this.bitcoinNetwork, 'payer') : paymentPayer(kind, payer);
    return { receiver, payer, kind };
  }
  makeReal({ actionId, asset, amount, block, receiver, payer, kind = 'tap', candidate, compound: isCompound = false }) {
    return this.exclusive(async () => {
      this.actionId(actionId); candidate = wireIdentities(candidate);
      ({ receiver, payer, kind } = this.paymentAddresses({ receiver, payer, kind }));
      const id = `mint/${actionId}`, intent = { asset, amount, ...(block === undefined ? {} : { block }), receiver, payer, kind, compound: isCompound }, old = this.journal.get(id);
      const context = await this.namedContext();
      if (context) return await resumeLegacyFinancial(this, 'mint', actionId, intent) ?? makeFinancialMint(this, intent, actionId, candidate, context);
      if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting mint action ID');
      if (!this.dryRun && old && ['submitted', 'accepted', 'rejected'].includes(old.state)) return { ...old.result, state: old.state, replayed: true };
      if (!this.dryRun && old) {
        const requestId = pendingId(this.network, old.body.request);
        try {
          const status = await this.service.mintStatus(requestId); check((status.requestId ?? status.id) === requestId, 'Mint request ID mismatch');
          const result = { state: 'submitted', request: status, paymentLink: this.service.paymentLink(requestId, this.paymentOrigin) };
          this.journal.mark(id, 'submitted', result); return { ...result, replayed: true };
        } catch (e) { if (e.status !== 404) throw e; }
      }
      const head = await this.trac.head(), balance = await this.trac.balance(this.owner, asset);
      const request = old?.body.request ?? { owner: this.owner, asset, amount, receive: sha256(receiver), ...(block === undefined ? {} : { block }), nonce: nonce(), until: head.counted + 12,
        expires: mintExpiry(head.counted, (await this.trac.settings()).pending_blocks) };
      check(isCompound ? block === undefined : candidate?.find?.finder && !candidate.void && !candidate.pending, 'Mint needs a found candidate, or a compound without a block');
      if (!isCompound) {
        check(candidate.find.asset === asset && candidate.find.block === block, 'Wrong mint candidate');
        check(amount === String(candidate.find.count), 'mint_count');
      }
      const quoteInput = { asset, amount, ...(block === undefined ? {} : { block }), kind };
      const quote = old?.body.feeQuote ? await this.service.quote({ ...quoteInput, feeQuote: old.body.feeQuote }) : await this.service.mintQuote(quoteInput);
      if (quote.deploymentNeeded) return { ...quote, deploymentLink: this.service.deploymentLink?.(asset, this.address, this.paymentOrigin),
        next: [{ tool: 'inscribe_deployment', arguments: { asset } }], signed: false };
      // Check schema/rights with a locally computed signature even for previews;
      // previews do not expose or send that signature.
      const signature = old?.body.signature ?? signOwnerRequest(this.wallet, 'rq', this.network, request, head.counted);
      const acceptance = acceptMintRequest({ request, sig: signature, network: this.network, counted: head.counted, balance, compound: isCompound,
        find: candidate?.find, link: candidate?.link, currentHolder: candidate?.currentHolder, minted: !!candidate?.minted });
      const link = this.service.paymentLink(acceptance.id, this.paymentOrigin);
      if (this.dryRun) return { state: 'dry-run', request, receiver, payer, quote, signatureExposed: false };
      const body = old?.body ?? { request, signature, receiver, payer, kind, feeQuote: quote.feeQuote, authorization: signPaymentIntent(this.wallet, this.network, { request, receiver, payer, kind, feeQuote: quote.feeQuote }) };
      const row = this.journal.reserve(id, intent, body);
      await this.journal.waitTurn(async () => {
        const fresh = await this.trac.head();
        acceptMintRequest({ request, sig: signature, network: this.network, counted: fresh.counted, balance: await this.trac.balance(this.owner, asset), compound: isCompound,
          find: candidate?.find, link: candidate?.link, currentHolder: candidate?.currentHolder, minted: !!candidate?.minted });
        return fresh;
      });
      this.journal.mark(id, 'sending');
      try {
        const response = await this.service.requestMint(row.body); check((response.requestId ?? response.id) === pendingId(this.network, row.body.request), 'Mint request ID mismatch');
        const requestId = response.requestId ?? response.id;
        const result = { state: 'submitted', request: response, quote, paymentLink: link,
          next: [{ tool: 'pay_mint', arguments: { id: requestId } }, { tool: 'poll_mint', arguments: { id: requestId } }, { tool: 'inscribe_mint', arguments: { id: requestId } }],
          note: 'Pay the fee items, wait for the permit, then inscribe from your own Bitcoin wallet. You pay the Bitcoin fees.' };
        this.journal.mark(id, 'submitted', result); return result;
      } catch (e) { this.journal.mark(id, 'unknown'); throw e; } finally { this.journal.finishTurn(); }
    });
  }
  async takenSlots(patterns) {
    const taken = {};
    for (const pattern of patterns) {
      const blocks = new Set(), cursors = new Set(); let cursor;
      do {
        // v2 serves the found index at /claimed-blocks (pages of up to 50) with decimal-string heights.
        const asset = patternId(pattern), v2 = asset.startsWith('p2:');
        const page = await this.service.readPage(`/patterns/${asset}/${v2 ? 'claimed-blocks' : 'blocks'}`, { found: true, limit: v2 ? 50 : 200, cursor });
        const next = nextCursor(page);
        check(Array.isArray(page.rows), 'Invalid found index page');
        for (const row of page.rows) { const block = readInteger(row.block);
          check(integer(block) && (row.found || row.minted), 'Invalid found index row'); blocks.add(block); }
        cursor = next; check(!cursor || !cursors.has(cursor), 'Repeated found index cursor'); cursors.add(cursor);
      } while (cursor);
      taken[pattern.number] = blocks;
    }
    return taken;
  }
  async runOnce({ history, source, strategy = chooseClaims }) {
    const head = await this.trac.head(), patterns = await this.catalog();
    const sendHeader = () => this.postHeader({ height: head.tip.height, history, source });
    if (!patterns.length) return { state: 'discovery_needed', message: 'No patterns have been accepted into the public table yet, so there is nothing to mine. Test a pattern against verified history, commit it, wait at least two Bitcoin blocks and for witnessed inclusion, then reveal it and wait for evaluation to accept it. A local search success or gateway receipt is not an accepted pattern. This pass can still submit a free header.',
      next: [{ tool: 'search_patterns', arguments: {} }, { tool: 'propose_pattern' }, { tool: 'reveal_pattern' }], header: await sendHeader() };
    // Headers can be sent immediately while the archive needed for the all-history
    // hunt is still loading. Never mistake a handful of headers for full history.
    if (!history) return { ...await sendHeader(), claimState: 'history_downloading', message: 'The history archive is needed to hunt all matching blocks.' };
    let publication;
    try { publication = await this.service.latest(); } catch (e) { if (e.status === 404) return sendHeader(); throw e; }
    const published = await this.service.publication(publication.summary);
    const summary = { ...published, tip: readInteger(published.tip), ...(published.height === undefined ? {} : { height: readInteger(published.height) }) };
    if (claimWindow(summary.tip, head.tip.height) && summary.tipHash === await this.trac.hashAt(summary.tip)) {
      if (summary.tip >= history.length || history.get(summary.tip).hash !== summary.tipHash)
        return { ...await sendHeader(), claimState: 'history_downloading' };
      const event = { window: summary.tip, claimableHeight: summary.height ?? head.counted, hash: summary.tipHash };
      const bytes = history.raw(summary.tip), raw = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('hex');
      const saved = this.journal.get(`claim/${event.window}`), selection = saved && claimSelection(saved.body.p), settings = await this.trac.settings();
      const plots = selection?.plots ?? await strategy({ history, patterns: publicIdentities(patterns), owner: this.address,
        taken: await this.takenSlots(patterns), claimsPerWindow: settings.values?.claimsPerWindow ?? settings.claimsPerWindow ?? CLAIM_DEFAULTS.claimsPerWindow, claimableHeight: event.claimableHeight, window: event.window });
      if (plots.length) return { ...await this.claim({ event, plots, history, patterns, header: selection?.header ?? { height: summary.tip, raw } }), window: event.window, plots, patterns: [...new Set(plots.flatMap(p => p.patterns))].sort((a, b) => a - b) };
      return this.headers({ height: summary.tip, raw, history });
    }
    return sendHeader();
  }
  async postHeader({ height, history, source }) {
    const head = await this.trac.head(); height ??= head.tip.height;
    check(integer(height) && height <= head.tip.height, 'Invalid claim header height');
    const anchor = history && Math.min(history.length - 1, head.tip.height);
    if (!history || height >= history.length || history.get(anchor).hash !== await this.trac.hashAt(anchor))
      history = await loadClaimHeaders({ heights: [height], source, trac: this.trac, head, powLimitBits: this.powLimitBits });
    const bytes = history.raw(height), raw = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('hex');
    return this.headers({ height, raw, history });
  }
}
