import { mintSenderError } from './src/mint-sender-errors.mjs';
import { supportedNode } from '../node-version.mjs';
import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { check } from './src/util.mjs';
import { mintSenderSettings } from './src/mint-sender-settings.mjs';
import { readMintSeed, fundingAmount, payoutFloatKey, refundBudget } from './src/mint-sender-keys.mjs';
import { senderToken, senderKeyId } from './src/mint-sender-view.mjs';
import { MintSenderJournal } from './src/mint-sender-journal.mjs';
import { MintSender } from './src/mint-sender.mjs';
import { SenderHTTP, MintSenderGateway, createMintSenderBitcoin } from './src/mint-sender-source.mjs';

export async function startMinter(config, { signal, log, initialize = false } = {}) {
  check(supportedNode(), 'node_version');
  const settings = mintSenderSettings(config.mintSender), network = config.mode === 'regtest' ? 'regtest' : 'mainnet';
  check(['regtest', 'prod'].includes(config.mode) && isAbsolute(config.data ?? '') && settings.seedFile && settings.directory && settings.bitcoinApiUrlFile, 'mint_sender_config');
  check(resolve(settings.directory) !== resolve(config.data) && !resolve(settings.directory).startsWith(resolve(config.data) + '/'), 'mint_sender_separate_store');
  check(config.listen?.host === '127.0.0.1' && Number.isSafeInteger(config.listen.port) && config.listen.port > 0, 'mint_sender_gateway_loopback');
  if (!initialize) check(existsSync(join(settings.directory, 'sender.sqlite')) && existsSync(join(settings.directory, 'identity.json')), 'mint_sender_journal_missing');
  fundingAmount(settings); // Validate the configured reserve and combined quote cap before signing.
  const seed = await readMintSeed(settings.seedFile);
  let journal;
  try {
    journal = new MintSenderJournal(settings.directory, { keyId: senderKeyId(seed, network), network });
    if (initialize) { journal.close(); seed.fill(0); return null; }
    const gateway = new MintSenderGateway({ http: new SenderHTTP({ origin: `http://127.0.0.1:${config.listen.port}`, settings, signal }), token: senderToken(seed, network) });
    const bitcoin = await createMintSenderBitcoin({ config, settings, network, signal });
    return new MintSender({ seed, network, settings, journal, gateway, bitcoin, log });
  } catch (error) { seed.fill(0); journal?.close(); throw Error(mintSenderError(error)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(); let sender, heartbeat;
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const initialize = process.argv[2] === '--initialize', createRefundAuthority = process.argv[2] === '--create-refund-authority';
    const createPayoutAuthority = process.argv[2] === '--create-payout-authority', payoutAddress = process.argv[2] === '--payout-address';
    const filename = process.argv[initialize || createRefundAuthority || createPayoutAuthority || payoutAddress ? 3 : 2]; check(isAbsolute(filename ?? '') && await realpath(filename) === filename, 'mint_sender_config_path');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    if (payoutAddress) {
      check(supportedNode() && ['regtest', 'prod'].includes(config.mode), 'mint_sender_config');
      const settings = mintSenderSettings(config.mintSender), seed = await readMintSeed(settings.seedFile);
      try {
        const key = payoutFloatKey(seed, config.mode === 'regtest' ? 'regtest' : 'mainnet');
        try { console.log(JSON.stringify({ address: key.address, path: key.path, conservativeFundingSatsPerPayout: refundBudget(settings), maxFeeSats: settings.maxFeeSats })); }
        finally { key.privateKey.fill(0); }
      } finally { seed.fill(0); }
    } else {
      sender = await startMinter(config, { signal: controller.signal, initialize });
      if (initialize) console.log('mint_sender_journal_initialized');
      else if (createPayoutAuthority) console.log(JSON.stringify({ event: 'mint_payout_authority', ...await sender.payouts.createAuthority() }));
      else if (createRefundAuthority) console.log(JSON.stringify({ event: 'mint_refund_authority', ...await sender.refunds.createAuthority() }));
      else {
        // Health is independent of discovery and per-request network work.
        heartbeat = setInterval(() => { try { sender.health(true); } catch { console.error('mint_sender_health_write_failed'); } }, sender.settings.healthMs);
        while (!controller.signal.aborted) {
          try { await sender.tick(); } catch { console.error('mint_sender_loop_retry'); }
          await sleep(sender.settings.pollMs, undefined, { signal: controller.signal });
        }
      }
    }
  } catch (error) { if (!controller.signal.aborted) { console.error(JSON.stringify({ event: 'mint_sender_startup_or_loop_failed', code: mintSenderError(error) })); process.exitCode = 1; } }
  finally {
    clearInterval(heartbeat);
    try { await sender?.close(); } catch { console.error('mint_sender_shutdown_failed'); process.exitCode = 1; }
  }
}
