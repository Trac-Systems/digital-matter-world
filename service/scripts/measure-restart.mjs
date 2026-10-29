import { performance } from 'node:perf_hooks';
import { start } from '../run.mjs';
import { restartFixture } from '../test/restart-fixture.mjs';

const fixture = await restartFixture();
let service;
try {
  const started = performance.now();
  service = await start(fixture.config, { background: true });
  const listeningMs = performance.now() - started;
  await service.ready;
  const initializedMs = performance.now() - started;
  await fixture.polling;
  const closing = performance.now(); await service.close();
  console.log(JSON.stringify({ fixture: 'loopback synthetic delays; real gateway/v2/store', listeningMs, initializedMs,
    closeMs: performance.now() - closing, phases: fixture.events }, null, 2));
} finally { await service?.close(); await fixture.close(); }
