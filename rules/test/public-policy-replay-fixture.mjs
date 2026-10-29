// Deterministic pre-public-policy discovery, claim closure and settlement.
export function historicalPublicPolicyReplay(r) {
  const document = r.settingsRevision({ network: 'replay', effectiveBatch: '1', effectiveBitcoinWindow: '1', values: { ...r.SETTINGS_PROFILE } });
  const settings = r.batchSettings({ document }), agent = r.hash('replay-agent'), salt = r.hash('replay-salt');
  const proposal = { name: 'dmwreplay', pat: '[0-9]', fld: 4, dt: 'n' };
  const history = { get: height => ({ height: Number(height), hash: r.hash(height) }) };
  const anchor = { height: '100', hash: r.hash('100') };
  const matches = ['1', '10', '11'].map(height => ({ height, hash: r.hash(height), count: String(height.length) }));
  const commitment = r.namedCommitment({ agent, proposal, salt, anchor, matches, settings: document });
  const committed = r.commitNamedDiscovery(r.emptyNamedDiscovery(), { agent, commitment, tip: '100', receiptPosition: '1', settings: document });
  const revealed = r.revealNamedDiscovery(committed, { agent, commitmentId: commitment, proposal, salt, anchor, matches, witnessRoot: r.witnessRoot(matches),
    tip: '102', counted: '102', receiptPosition: '2', history, settings: document });
  const state = {}, event = { ...r.claimRound('110', r.hash('110'), '110', { root: r.namedStateRoot(revealed.state), nextNumber: '1', revision: revealed.state.catalogRevision }),
    policy: { settingsHash: r.hashObject(document), finderWindow: document.values.finderWindow, claimWindowBlocks: document.values.claimWindowTips, claimsPerWindow: document.values.claimsPerWindow } };
  const patterns = { '0': revealed.record };
  r.enterClaims({ state, event, settings, agent, patterns, history, plots: [{ block: '1', patterns: ['0'] }, { block: '10', patterns: ['0'] }] });
  r.enterClaims({ state, event, settings, agent: r.hash('competitor'), patterns, history, plots: [{ block: '10', patterns: ['0'] }] });
  event.headerSenders = [agent];
  const closure = r.freezeClaimWindow({ state, event, settings, decidingHash: r.hash('112'), counted: '112' }), pages = [];
  while (BigInt(event.cursor) < BigInt(event.pages)) pages.push(r.takeSettlementPage({ state, event, height: '115', budget: new r.CreditBudget(settings) }));
  const find = r.recordGet(state.finds, r.findIdV2('1', '0'));
  return { document: r.hashObject(document), discovery: r.namedStateRoot(revealed.state), closure: r.hashObject(closure),
    settlement: r.merkleRoot(pages.map(r.encodeBinary)), state: r.hashObject(state),
    finder: r.mintRight({ find, owner: agent, counted: '115' }), holder: r.mintRight({ find, owner: r.hash('unit-holder'), counted: '1200' }) };
}
