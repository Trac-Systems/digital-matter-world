import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLegacyLink } from './financial-rehearsal.mjs';
import { FinancialLinks } from '../src/financial-links.mjs';
import { serve } from '../src/http.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { rules as r } from '../src/rules.mjs';
import { edPublic } from '../src/util.mjs';

const network = 'dmw-regtest', secret = r.hashBytes('hf1-legacy-probe');
const request = { owner: edPublic(secret), height: 1, nonce: r.hash('hf1-link'), until: 100 };

for (const mode of ['enabled', 'missing', 'unavailable', 'accepted', 'mutated']) test(`legacy link probe requires exact refusal without writes: ${mode}`, async () => {
  const store = { sequence: 0 };
  const links = mode === 'enabled' ? new FinancialLinks({ network, store }) : mode === 'missing' ? null : {
    request() {
      if (mode === 'accepted') return { accepted: true };
      if (mode === 'mutated') store.sequence++;
      throw Object.assign(Error(mode === 'mutated' ? 'financial_link_signature' : 'source_unavailable'), { status: mode === 'mutated' ? 400 : 503 });
    }
  };
  const http = await serve({ intake: { store }, links, files: { serve: async () => false }, web: { handle: async () => false } });
  try {
    const service = new ServiceClient({ origin: http.url, network });
    const probe = () => probeLegacyLink({ service, store, network, request, secret, payer: 'regtest-payer' });
    if (mode === 'enabled') assert.deepEqual(await probe(), { status: 400, code: 'financial_link_signature', writes: 0,
      scope: 'new legacy-format packet refused after v2 activation; retained pre-activation jobs are tested separately' });
    else await assert.rejects(probe());
  } finally { await http.close(); }
});
