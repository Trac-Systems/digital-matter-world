import test from 'node:test';
import { v2StackFixture } from './v2-stack-fixture.mjs';

test('eight kit journals, five HTTP policies, targeted evidence and imported notary settle 800 claims',
  { timeout: 180000 }, t => v2StackFixture(t));
