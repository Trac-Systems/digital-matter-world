import { rpc, randomHex, delay } from './tss.mjs';
import { attachPermit } from './signer/adapter.mjs';
import { ethereumSignature } from './signer/escrow.mjs';

export async function signProposal(signers, proposal, { epoch = 1, timeout = 180000 } = {}) {
  if (signers.length !== 3 || new Set(signers.map(s => s.id)).size !== 3) throw Error('three_signers_required');
  const id = randomHex(), ceremony = { id, epoch, peers: signers.map(s => s.peer) };
  try {
    const prepared = await Promise.allSettled(signers.map(s => rpc(s.url, s.token, '/prepare', { proposal, ceremony })));
    const failed = prepared.find(p => p.status === 'rejected'); if (failed) throw failed.reason;
    if (new Set(prepared.map(p => p.value.digest)).size !== 1) throw Error('policy_disagreement');
    const sessions = prepared.map(p => p.value.id);
    await Promise.all(signers.map((s, i) => prepared[i].value.recovered ? null : rpc(s.url, s.token, '/go', { id: sessions[i] })));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const states = await Promise.all(signers.map((s, i) => rpc(s.url, s.token, '/status', { id: sessions[i] })));
      if (states.some(s => s.status === 'aborted')) throw Error('signature_aborted');
      if (states.every(s => s.status === 'complete')) {
        if (new Set(states.map(s => JSON.stringify(s.signature))).size !== 1) throw Error('signature_disagreement');
        const { signature, result } = states[0];
        return { session: id, digest: prepared[0].value.digest, signature, ...(result.permit ? { payload: attachPermit(result.permit, signature), certificate: { domain: 'dmw-mint-result-v1', network: proposal.network, details: result.details, signature, attestations: states.map(s => s.result.attestation) } } : {}), ...(result.typedData ? { typedData: result.typedData, ethereumSignature: ethereumSignature(signature) } : {}) };
      }
      await delay(100);
    }
    throw Error('signature_timeout');
  } catch (error) {
    await Promise.allSettled(signers.map(s => rpc(s.url, s.token, '/abort', { id }, 1000))); throw error;
  }
}
