// The authenticated console forwards only this public, indexer-verified intake.
export async function forwardDeployment(engine, body) {
  if (!body || Object.keys(body).some(k => !['asset', 'phase', 'inscription'].includes(k))
    || !/^[a-z0-9]{1,24}$/.test(body.asset ?? '')
    || !/^[0-9a-f]{64}i[0-9]+$/.test(body.inscription ?? '')
    || body.phase !== undefined && !/^[a-z_]{1,32}$/.test(body.phase)) {
    throw Object.assign(Error('invalid_deployment_submission'), { status: 400 });
  }
  return engine.post('/mint/deployment', body);
}
// A wallet-broadcast inscription, which the gateway checks on Bitcoin before showing it as in flight.
export async function forwardInflight(engine, body) {
  if (!body || Object.keys(body).some(k => !['kind', 'ref', 'phase', 'attempt', 'commitTxid', 'revealTxid', 'inscriptionId'].includes(k))) {
    throw Object.assign(Error('invalid_inflight_report'), { status: 400 });
  }
  return engine.post('/mint/inflight', body);
}
