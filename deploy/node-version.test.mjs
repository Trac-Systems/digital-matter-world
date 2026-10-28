import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedNode } from '../node-version.mjs';

test('runtime accepts the supported Node 24 security floor and later 24.x releases', () => {
  for (const version of ['24.22.1', '24.22.2', '24.23.0', '24.100.0']) assert.equal(supportedNode(version), true, version);
  for (const version of ['22.22.1', '23.11.1', '24.0.0', '24.21.9', '24.22.0', '25.0.0',
    '24.22.1-rc.1', 'v24.22.1', '24.22', 'garbage']) assert.equal(supportedNode(version), false, version);
});

