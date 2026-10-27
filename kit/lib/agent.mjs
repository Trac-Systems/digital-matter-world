import { encodeTracAddress, decodeTracAddress, publicIdentities, wireIdentities } from '../../rules/src/trac-address.js';
import { stableJSON, validatePayload, patternCount, compound, patternProperties, patternAsset, pendingId, claimWindow, acceptMintRequest, evaluateDiscovery, discoveryCommitment, DISCOVERY_LIMITS, verifyRootAttestations, linkId, CLAIM_DEFAULTS } from '../../rules/src/index.js';
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

export class Agent {
  constructor({ wallet, network, service, trac, journal, bitcoinWallet, dryRun = true, puzzleBits = 12, powLimitBits = 0x1d00ffff, work = {}, paymentOrigin, owner = {}, bitcoinNetwork = powLimitBits === 0x207fffff ? 'regtest' : 'mainnet' } = {}) {
    check(wallet && service && trac && journal && typeof network === 'string', 'Signer, local clients and journal required');
    check(service.network === network && trac.network === network, 'Client network mismatch');
    if (paymentOrigin) gatewayOrigin(paymentOrigin, service?.mode ?? 'regtest');
    Object.assign(this, { wallet, network, service, trac, journal, dryRun, puzzleBits, powLimitBits, work, paymentOrigin });
    check(['regtest', 'mainnet'].includes(bitcoinNetwork), 'Invalid Bitcoin network');
    this.bitcoinNetwork = bitcoinNetwork;
    this.bitcoinWallet = bitcoinWallet;
    this.playerMint = new PlayerMint({ service, journal, wallet: bitcoinWallet, owner: encodeTracAddress(publicKey(wallet)), dryRun });
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
    if (!row || ['prepared', 'accepted', 'rejected'].includes(row.state)) return;
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
      const matches = p => ['name', 'pat', 'fld', 'dt'].every(k => p[k] === row.body.proposal[k]);
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
        this.journal.observe(id, 'accepted', { source: 'public_catalog', asset: patternAsset(found) });
      }
    } else if (row.body.t) {
      const proof = await this.service.inclusion(row.body, { receipt: row.result ?? undefined, hashAt: h => this.trac.hashAt(h) });
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
    const actions = this.journal.recent().map(row => {
      const kind = row.id.split('/')[0], digest = { mint: pendingId, link: linkId }[kind];
      const evidence = this.journal.evidence(row.id);
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
  block(height, options = {}) { return this.service.block(height, options); }
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
    check(typeof asset === 'string' && /^[0-9a-z]{1,24}$/.test(asset), 'Invalid asset');
    return { asset, ...amountView(await this.trac.balance(this.owner, asset), { currency: asset, denomination: 'unit', decimals: 0 }) };
  }
  async hunting(options) {
    const head = await this.trac.head(), page = this.journal.hunting(options), items = [];
    for (const row of page.items) {
      if (row.type === 'discovery') {
        items.push({ ...row, phase: row.revealState ? 'check_reveal' : row.receiptTip === null ? 'receipt_unknown' : head.tip.height < row.revealFrom ? 'sealed' : head.tip.height > row.revealUntil ? 'expired' : 'reveal_window' });
        continue;
      }
      let settlement = this.journal.evidence(row.id).settlement;
      if (row.type === 'header') {
        try {
          const block = settlement ?? await this.service.block(row.headerBlock);
          const window = row.headerBlock;
          check(integer(window), 'Header claim window unavailable');
          Object.assign(row, { window, closesAt: window + 2, drawAt: window + 2, settlesWhenCounted: window + 2, settlesAt: window + 2 });
        } catch { items.push({ ...row, phase: 'check_settlement' }); continue; }
      }
      const tracked = row.plots.map(p => ({ ...p }));
      if (row.headerBlock !== null && row.headerBlock !== undefined && !tracked.some(p => p.block === row.headerBlock)) tracked.push({ block: row.headerBlock, patterns: [] });
      let phase = head.tip.height < row.closesAt ? 'claim_window' : head.tip.height < row.drawAt ? 'awaiting_draw' : head.counted < row.settlesWhenCounted ? 'awaiting_counted_draw' : 'check_settlement';
      if (!settlement && phase === 'check_settlement') {
        const plots = [];
        try {
          for (const plot of tracked) {
            const page = await this.service.block(plot.block, { collection: 'draws', window: row.window, limit: 200 });
            const draw = page.draws.find(d => d.window === row.window && Number.isSafeInteger(d.settledAt));
            if (!draw) break;
            const winners = [...draw.winners];
            let cursor = draw.pages?.winners?.next;
            while (cursor) { const more = await this.service.readPage(draw.pages.winners.route, { cursor, limit: 200 }); winners.push(...more.items); cursor = more.next; }
            const won = draw.void ? [] : winners.filter(w => w.block === plot.block && w.winner === this.address && (plot.patterns.includes(w.pattern) || w.source === 'header' && row.headerBlock === plot.block));
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
    const rows = [], cursors = new Set(); let cursor, total;
    do {
      const page = await this.service.patterns({ cursor, sort: 'number', order: 'asc' });
      check(integer(page.total) && page.total <= 100000, 'Invalid catalog size');
      total ??= page.total;
      check(page.total === total && Array.isArray(page.patterns) && integer(page.limit) && page.limit >= 1 && page.limit <= 200 &&
        page.patterns.length <= page.limit && (page.next === null || typeof page.next === 'string' && page.next.length > 0), 'Invalid catalog page');
      rows.push(...page.patterns);
      check(rows.length <= total && (page.next === null || page.patterns.length > 0 && !cursors.has(page.next)), 'Catalog changed during read');
      cursor = page.next; if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    check(rows.length === total && rows.every(p => integer(p.number)) && new Set(rows.map(p => p.number)).size === rows.length, 'Catalog changed during read'); return rows;
  }
  async sendMove(id, type, payload, { intent = payload, validate = async () => {} } = {}) {
    validatePayload(type, payload);
    const old = this.journal.get(id);
    if (old) check(old.fingerprint === sha256(stableJSON(intent)), 'Conflicting action refused; use the saved intent');
    if (!this.dryRun && old && ['received', 'accepted', 'rejected'].includes(old.state)) return { state: old.state, receipt: old.result, inclusion: old.state === 'received' ? 'unverified' : 'witnessed', replayed: true };
    const head = await this.trac.head(); await validate(head);
    if (this.dryRun) return { state: 'dry-run', action: type, payload, tip: head.tip, signed: false };
    let row = old;
    if (!row) {
      const move = await signMove(this.wallet, { network: this.network, type, payload, tip: head.tip }, { puzzleBits: this.puzzleBits, ...this.work });
      const fresh = await this.trac.head();
      check(fresh.tip.height === head.tip.height && fresh.tip.hash === head.tip.hash, 'Tip changed while solving; retry with fresh context');
      await validate(fresh); row = this.journal.reserve(id, intent, move);
    }
    const move = row.body;
    await this.journal.waitTurn(async () => {
      const fresh = await this.trac.head(); await validate(fresh);
      check(move.b <= fresh.tip.height && move.b >= fresh.tip.height - 2 && await this.trac.hashAt(move.b) === move.h, 'Saved move is stale; retain its receipt history and wait for another event');
      if (type === 'claim') check(claimWindow(move.p.window, fresh.tip.height), 'Claim window is closed');
      return fresh;
    });
    this.journal.mark(id, 'sending');
    try {
      const receipt = await this.service.submit(move, { hashAt: h => this.trac.hashAt(h) }); this.journal.mark(id, 'received', receipt);
      return { state: 'received', receipt, inclusion: 'unverified' };
    } catch (e) { this.journal.mark(id, 'unknown'); throw e; } finally { this.journal.finishTurn(); }
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
        const budget = (await this.trac.settings()).claimsPerWindow ?? CLAIM_DEFAULTS.claimsPerWindow;
        check(plots.reduce((n, q) => n + q.patterns.length, 0) <= budget, 'Claim budget exceeded');
        for (const q of plots) {
          check(q.block <= (event.claimableHeight ?? head.counted) || q.block === event.window, 'Claim block is not counted');
          const h = checkedHeader(history.raw(q.block), q.block, history.get(q.block).hash, { powLimitBits: this.powLimitBits });
          await assertHeaderChain({ history, height: q.block, hash: h.hash, trac: this.trac, head });
          for (const n of q.patterns) { const p = patterns.find(p => p.number === n); check(p && patternCount(p, h) > 0, 'Claimed pattern does not match'); }
        }
      } });
    });
  }
  async claimInclusion({ window, publication, commitment }) {
    check(integer(window), 'Invalid claim window');
    const saved = this.journal.get(`claim/${window}`); check(saved, 'No saved claim');
    return this.service.inclusion(saved.body, { publication, commitment, receipt: saved.result ?? undefined, hashAt: h => this.trac.hashAt(h) });
  }
  discoveryAnalysis(proposal, history, patterns, head) {
    const analysis = checkProposal({ proposal, history, tip: head.tip, existing: patterns, owner: this.owner });
    evaluateDiscovery({ proposal, discoverer: this.owner, history: { length: head.counted + 1, field: (...a) => history.field(...a), get: h => history.get(h) }, existing: patterns, number: analysis.record.number });
    return analysis.record;
  }
  propose({ actionId, proposal, history, patterns }) {
    return this.exclusive(async () => {
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
  reveal({ actionId, publication, history, patterns }) {
    return this.exclusive(async () => {
      this.actionId(actionId); const id = `discovery/${actionId}`, saved = this.journal.get(id), committed = this.journal.get(`${id}/commit`);
      check(saved && committed, 'No saved discovery commitment');
      const payload = { proposal: saved.body.proposal, salt: saved.body.salt };
      check(discoveryCommitment(payload.proposal, payload.salt, this.owner) === committed.body.p.commitment, 'Saved discovery commitment mismatch');
      const old = this.journal.get(`${id}/reveal`);
      if (!this.dryRun && old && ['received', 'accepted', 'rejected'].includes(old.state)) return { state: old.state, receipt: old.result, inclusion: old.state === 'received' ? 'unverified' : 'witnessed', phase: 'reveal', actionId, replayed: true };
      let certificate = saved.result;
      if (!certificate) {
        certificate = await this.service.inclusion(committed.body, { publication, receipt: committed.result ?? undefined, hashAt: h => this.trac.hashAt(h) });
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
      this.actionId(actionId); check(kind === 'link' && integer(height), 'Invalid plot request');
      payer = bitcoinAddress(payer ?? this.ownerConfig.payer.tap, this.bitcoinNetwork, 'payer');
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
  actionId(id) { check(typeof id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(id), 'Choose a stable action ID (1–64 letters, numbers, dot, dash or underscore)'); }
  transaction({ actionId, op, value }) {
    return this.exclusive(async () => {
      this.actionId(actionId); check(op === 'tf', 'Only transfers are permitted');
      value = { ...value, to: decodeTracAddress(value.to) }; transactionCommand(op, value);
      const id = `tx/${actionId}`, intent = { op, value }, old = this.journal.get(id);
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
      if (quote.deploymentNeeded) return { ...quote, next: [{ tool: 'inscribe_deployment', arguments: { asset } }], signed: false };
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
        const page = await this.service.readPage(`/patterns/${patternAsset(pattern)}/blocks`, { found: true, limit: 200, cursor });
        check(Array.isArray(page.rows) && (page.next === null || typeof page.next === 'string' && page.next.length > 0), 'Invalid found index page');
        for (const row of page.rows) { check(integer(row.block) && (row.found || row.minted), 'Invalid found index row'); blocks.add(row.block); }
        cursor = page.next; check(!cursor || !cursors.has(cursor), 'Repeated found index cursor'); cursors.add(cursor);
      } while (cursor);
      taken[pattern.number] = blocks;
    }
    return taken;
  }
  async runOnce({ history, source, strategy = chooseClaims }) {
    const head = await this.trac.head(), patterns = await this.catalog();
    const sendHeader = () => this.postHeader({ height: head.tip.height, history, source });
    if (!patterns.length) return { state: 'discovery_needed', message: 'The table is empty. Search, propose and reveal the first pattern before claiming.',
      next: [{ tool: 'search_patterns', arguments: {} }, { tool: 'propose_pattern' }, { tool: 'reveal_pattern' }], header: await sendHeader() };
    // Headers can be sent immediately while the archive needed for the all-history
    // hunt is still loading. Never mistake a handful of headers for full history.
    if (!history) return { ...await sendHeader(), claimState: 'history_downloading', message: 'The history archive is needed to hunt all matching blocks.' };
    let publication;
    try { publication = await this.service.latest(); } catch (e) { if (e.status === 404) return sendHeader(); throw e; }
    const summary = await this.service.publication(publication.summary);
    if (claimWindow(summary.tip, head.tip.height) && summary.tipHash === await this.trac.hashAt(summary.tip)) {
      if (summary.tip >= history.length || history.get(summary.tip).hash !== summary.tipHash)
        return { ...await sendHeader(), claimState: 'history_downloading' };
      const event = { window: summary.tip, claimableHeight: summary.height ?? head.counted, hash: summary.tipHash };
      const bytes = history.raw(summary.tip), raw = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('hex');
      const saved = this.journal.get(`claim/${event.window}`), settings = await this.trac.settings();
      const plots = saved?.body.p.plots ?? await strategy({ history, patterns: publicIdentities(patterns), owner: this.address,
        taken: await this.takenSlots(patterns), claimsPerWindow: settings.claimsPerWindow ?? CLAIM_DEFAULTS.claimsPerWindow, claimableHeight: event.claimableHeight, window: event.window });
      if (plots.length) return { ...await this.claim({ event, plots, history, patterns, header: saved?.body.p.header ?? { height: summary.tip, raw } }), window: event.window, plots, patterns: [...new Set(plots.flatMap(p => p.patterns))].sort((a, b) => a - b) };
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
