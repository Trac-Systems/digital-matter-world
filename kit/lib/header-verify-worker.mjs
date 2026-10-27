import { parentPort, workerData } from 'node:worker_threads';
import { loadHistory, loadRegtestHistory, historyProof } from './headers.mjs';

try {
  const load = workerData.network === 'regtest' ? loadRegtestHistory : loadHistory;
  const history = await load(workerData.path, { onProgress: progress => parentPort.postMessage({ progress }) });
  parentPort.postMessage({ bytes: history.bytes, proof: historyProof(history) }, [history.bytes.buffer]);
} catch (error) { parentPort.postMessage({ error: { message: error.message, code: error.code } }); }
