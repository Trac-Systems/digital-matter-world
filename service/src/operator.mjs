import { mkdir, readdir, readFile, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { check, atomicWrite } from './util.mjs';
import { rules } from './rules.mjs';
import { createProvisioner } from './provisioning.mjs';
import { currentFee } from './fees.mjs';

export async function createOperator({ config, store, files, reads, committee }) {
  const provisioner = await createProvisioner({ config, store, reads });
  const inbox = join(config.data, 'operator-inbox'), outbox = join(config.data, 'operator-results');
  await mkdir(inbox, { recursive: true, mode: 0o700 }); await mkdir(outbox, { recursive: true, mode: 0o700 });
  const status = async () => {
    const fee = currentFee(await reads.registry());
    const jobs = store.list('provisioning', { limit: 4096 }).map(({ value: j }) => ({ asset: j.asset, displayLabel: j.displayLabel, state: j.state, reason: j.reason ?? null,
      actualTicker: j.entry?.tick ?? null, deploymentId: j.entry?.id ?? null, generation: j.generation, attempts: j.attempts.length, spentSats: j.spentSats, nextRetry: j.nextRetry ?? null }));
    return { network: config.network, provisioning: jobs, payment: 'player_paid_direct',
      feePolicy: { baseFee: fee.baseFee, feeSettings: fee.feeSettings ?? rules.FEE_DEFAULTS, revision: fee.id, unit: rules.TAP_UNIT },
      committee: { healthy: (await committee.healthy()).map(s => s.id), threshold: 3, total: 5, members: config.committee.map(s => s.peer), rosterHistory: config.rosterHistory ?? [], transitions: config.rosterTransitions ?? [] },
      inscription: { payer: 'player', mode: 'wallet_content' } };
  };
  const deployments = async () => { const registry = await reads.registry(); return { network: config.network, assets: registry.assets, generations: registry.generations ?? {} }; };
  return { status, deployments, provisioner, async tick() {
    await provisioner?.tick();
    for (const file of (await readdir(inbox)).filter(f => /^[0-9a-f-]{36}\.json$/.test(f)).slice(0, 16)) {
      const path = join(inbox, file), stat = await lstat(path);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.size <= 4096, 'operator_command_file');
      let result;
      try {
        const request = JSON.parse(await readFile(path, 'utf8'));
        if (request.action === 'provision') {
          check(provisioner, 'provisioning_unconfigured');
          if (request.asset) {
            const definition = (store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === request.asset) ?? store.get('types', request.asset);
            check(definition, 'asset_unknown'); result = await provisioner.request(request.asset, definition);
          } else { await provisioner.tick(); result = await status(); }
        } else if (request.action === 'status') result = await status();
        else throw Error('operator_action');
      } catch (e) { result = { error: /^[a-z][a-z0-9_]{0,80}$/.test(e.message) ? e.message : 'operator_dependency' }; }
      await atomicWrite(join(outbox, file), JSON.stringify(result)); await unlink(path);
    }
  } };
}
