import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { diskSpace } from '../lib/check.mjs';
import { temp } from './helpers.mjs';

test('disk budget checks the destination filesystem with a write-sized reserve instead of 100 GB', async t => {
  const directory = await temp(t), output = join(directory, 'headers.bin'), expected = 78_000_000;
  const available = 800n * 1024n * 1024n, calls = [];
  const statfsImpl = async (path, options) => { calls.push([path, options]); return { bavail: available, bsize: 1n }; };
  const result = await diskSpace(output, expected, { statfsImpl });
  assert.deepEqual(calls, [[directory, { bigint: true }]]);
  assert.equal(result.needed, 512n * 1024n * 1024n + 85_800_000n);
  await assert.rejects(diskSpace(output, expected, { statfsImpl: async () => ({ bavail: 10n, bsize: 1024n * 1024n }) }), error =>
    error.message.includes(directory) && /need 594 MiB, available 10 MiB/.test(error.message));
  await assert.rejects(diskSpace(output, -1), /write size/);
  await assert.rejects(diskSpace(output, Number.MAX_SAFE_INTEGER + 1), /write size/);
});
