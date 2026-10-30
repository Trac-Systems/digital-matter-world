// Read-only preflights. Approval/sign/send promises must never enter readFunds().
const requireValue = (ok, message) => { if (!ok) throw Error(message); };
const integer = value => {
  requireValue(typeof value === 'bigint' && value >= 0n || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) || Number.isSafeInteger(value) && value >= 0, 'invalid integer amount');
  return BigInt(value);
};
const decimalsFor = value => {
  const n = Number(value);
  requireValue((typeof value === 'number' || typeof value === 'string') && /^(0|[1-9][0-9]*)$/.test(String(value)) && Number.isInteger(n) && n <= 18, 'invalid token decimals');
  return n;
};
export function atomicAmount(value, decimals) {
  decimals = decimalsFor(decimals);
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value), 'invalid token amount');
  const [whole, fraction = ''] = value.split('.');
  requireValue(fraction.length <= decimals, 'token amount exceeds its decimals');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
export function displayAmount(value, decimals = 0) {
  const digits = integer(value).toString().padStart(decimals + 1, '0');
  if (!decimals) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const tail = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (tail ? '.' + tail : '');
}
const reason = error => String(error?.message || 'read unavailable').replace(/\s+/g, ' ').slice(0, 240);
const refuse = message => { throw Object.assign(Error(message), { code: 'wallet_funds', display: true }); };

// A timeout only stops waiting for a READ. Its late result can never trigger a send.
export async function readFunds(label, address, read, timeoutMs = 10000) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('read timed out')); }, timeoutMs); }),
    ]);
  } catch (error) {
    refuse(`Could not check your ${label} (${reason(error)}). Nothing was sent for this step; try again. Wallet: ${address}.`);
  } finally { clearTimeout(timer); }
}

async function jsonRead(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { redirect: 'error', cache: 'no-store', signal });
  requireValue(response.ok, `balance or fee reader returned HTTP ${response.status}`);
  return response.json();
}

// The reader's overall/transferable values are atomic strings (an empty
// transferableBalance is its documented no-transfer representation).
async function tapBalances({ address, ticks, network, fetchImpl, readerPath }, signal) {
  requireValue(['mainnet', 'regtest'].includes(network), 'TAP balance reader is unavailable for this Bitcoin network');
  const base = network === 'mainnet' ? 'https://reader.tapscope.io' : readerPath ?? '/web-api/tap-reader';
  requireValue(network === 'mainnet' || /^\/(?!\/)[a-z/-]+$/.test(base), 'invalid local TAP reader path');
  const account = encodeURIComponent(address), rows = new Map();
  for (let offset = 0; network === 'mainnet'; offset += 100) {
    const page = (await jsonRead(fetchImpl, `${base}/getAccountTokensBalance/${account}?offset=${offset}&max=100`, signal))?.data;
    requireValue(Array.isArray(page?.list) && Number.isSafeInteger(page.total) && page.total >= 0 && page.list.length <= 100, 'invalid TAP balance response');
    for (const row of page.list) {
      requireValue(typeof row?.ticker === 'string' && !rows.has(row.ticker.toLowerCase()), 'invalid or duplicate TAP ticker');
      rows.set(row.ticker.toLowerCase(), row);
    }
    if (ticks.every(tick => rows.has(tick)) || offset + page.list.length >= page.total) break;
    requireValue(page.list.length === 100 && offset < 9900, 'incomplete TAP balance response');
  }
  const balances = new Map();
  for (const tick of ticks) {
    const encoded = encodeURIComponent(tick);
    const [deployment, locked, obligation] = await Promise.all([
      jsonRead(fetchImpl, `${base}/getDeployment/${encoded}`, signal),
      jsonRead(fetchImpl, `${base}/getLockedBalance/${account}/${encoded}`, signal),
      jsonRead(fetchImpl, `${base}/getObligationLockedBalance/a/${account}/${encoded}`, signal),
    ]);
    requireValue(deployment?.result?.tick?.toLowerCase() === tick, 'token deployment does not match ticker');
    const decimals = decimalsFor(deployment.result.dec);
    requireValue(tick !== 'tap' || decimals === 18, 'invalid TAP decimals');
    if (network === 'regtest') {
      const [overall, transferable] = await Promise.all([
        jsonRead(fetchImpl, `${base}/getBalance/${account}/${encoded}`, signal),
        jsonRead(fetchImpl, `${base}/getTransferable/${account}/${encoded}`, signal),
      ]);
      requireValue(Object.hasOwn(overall, 'result') && Object.hasOwn(transferable, 'result'), 'invalid local TAP balance response');
      rows.set(tick, { overallBalance: overall.result ?? '0', transferableBalance: transferable.result ?? '0' });
    }
    const row = rows.get(tick), overall = row ? integer(row.overallBalance) : 0n;
    const held = row ? integer(row.transferableBalance === '' ? '0' : row.transferableBalance) : 0n;
    const lockedAmount = integer(locked?.result) + integer(obligation?.result);
    const available = overall - held - lockedAmount;
    balances.set(tick, { decimals, held, locked: lockedAmount, available: available > 0n ? available : 0n });
  }
  return balances;
}

export async function cardinalCoins(provider, address, { timeoutMs } = {}) {
  return readFunds('Bitcoin balance', address, async () => {
    requireValue(typeof provider?.getBitcoinUtxos === 'function', 'wallet cannot read cardinal Bitcoin coins');
    const coins = await provider.getBitcoinUtxos();
    requireValue(Array.isArray(coins) && coins.length <= 10000, 'invalid Bitcoin coin list');
    const seen = new Set();
    return coins.filter(c => !c.isUserSpendable && !c.isSpent && Array.isArray(c.inscriptions) && c.inscriptions.length === 0 && c.height > 0).map(c => {
      requireValue(Number.isSafeInteger(c.satoshi) && c.satoshi > 0 && /^[0-9a-f]{64}$/.test(c.txid) && Number.isSafeInteger(c.vout) && c.vout >= 0, 'invalid Bitcoin coin');
      const outpoint = `${c.txid}:${c.vout}`;
      requireValue(!seen.has(outpoint), 'duplicate Bitcoin coin'); seen.add(outpoint);
      return c;
    });
  }, timeoutMs);
}

export async function checkBitcoinFunds({ provider, address, requiredSats, estimated = false, inputs, timeoutMs, coins }) {
  coins ??= await cardinalCoins(provider, address, { timeoutMs });
  const available = coins.reduce((sum, coin) => sum + BigInt(coin.satoshi), 0n), needed = integer(requiredSats);
  if (available < needed) refuse(`Not enough Bitcoin for fees: this step needs ${estimated ? 'about ' : ''}${displayAmount(needed)} sats, your wallet has ${displayAmount(available)} sats spendable. Wallet: ${address}. Nothing was sent.${estimated ? ' This includes estimated miner fees, postage and any Bitcoin set-aside.' : ''}`);
  if (inputs && !inputs.every(input => coins.some(c => c.txid === input.txid && c.vout === input.vout)))
    refuse(`The Bitcoin coins selected for this inscription are no longer spendable. Wallet: ${address}. Nothing was sent; refresh the inscription plan before trying again.`);
  return { available, needed, coins };
}

export async function bitcoinFeeRate(fetchImpl = fetch, signal) {
  const fees = await jsonRead(fetchImpl, 'https://mempool.space/api/v1/fees/recommended', signal);
  requireValue(Number.isFinite(fees?.halfHourFee) && fees.halfHourFee >= 1 && fees.halfHourFee <= 1000, 'invalid Bitcoin fee estimate');
  return fees.halfHourFee;
}

// TAP Wallet creates a funding transaction, then an inscriber commit/reveal.
// Budget all cardinal inputs, P2TR outputs, postage, and generous signed JSON
// overhead. Round UP to whole sat/vB and retain the wallet's initial 5 sat/vB.
export function tapBitcoinEstimate({ message, coins, feeRate, extraOutputs = [], postage = 546 }) {
  requireValue(Number.isFinite(feeRate) && feeRate >= 1 && feeRate <= 1000, 'invalid Bitcoin fee estimate');
  const payloadBytes = new TextEncoder().encode(JSON.stringify(message)).length + 1024;
  const fundingVbytes = 12 + Math.max(1, coins.length) * 58 + (2 + extraOutputs.length) * 43;
  const commitVbytes = 12 + 58 + 2 * 43;
  const revealVbytes = 200 + Math.ceil(payloadBytes / 4);
  return BigInt(fundingVbytes + commitVbytes + revealVbytes) * BigInt(Math.ceil(Math.max(5, feeRate)))
    + integer(postage) + extraOutputs.reduce((sum, out) => sum + integer(out.satoshis), 0n);
}

export async function checkTapFunds({ provider, address, network, items = [], actions = [], message, extraOutputs = [], fetchImpl = fetch, timeoutMs, readerPath }) {
  // Lock actions consume the same available token balance as transfer items;
  // claims/refunds spend an existing lock, so only need Bitcoin fees here.
  const spends = [...items, ...actions.filter(a => a.op === 'lock')];
  const ticks = [...new Set(spends.map(item => {
    requireValue(typeof item.tick === 'string' && item.tick.length > 0, 'invalid payment ticker');
    return item.tick.toLowerCase();
  }))];
  if (ticks.length) {
    const totals = await readFunds(ticks.length === 1 ? `${ticks[0].toUpperCase()} balance` : 'TAP token balances', address, async signal => {
      const balances = await tapBalances({ address, ticks, network, fetchImpl, readerPath }, signal);
      return ticks.map(tick => {
        const balance = balances.get(tick);
        return { tick, ...balance, needed: spends.filter(i => i.tick.toLowerCase() === tick).reduce((sum, i) => sum + atomicAmount(i.amt, balance.decimals), 0n) };
      });
    }, timeoutMs);
    for (const { tick, decimals, held, locked, available, needed } of totals) {
      const label = tick.toUpperCase();
      if (available < needed) refuse(`Not enough ${label}: this payment needs ${displayAmount(needed, decimals)} ${label}, your wallet can spend ${displayAmount(available, decimals)} ${label}${held ? ` (${displayAmount(held, decimals)} ${label} is held in transfer inscriptions)` : ''}${locked ? ` (${displayAmount(locked, decimals)} ${label} is locked)` : ''}. Wallet: ${address}. Nothing was sent.`);
    }
  }
  const coins = await cardinalCoins(provider, address, { timeoutMs });
  const requiredSats = await readFunds('Bitcoin fee estimate', address, async signal => tapBitcoinEstimate({
    message: message ?? { items, actions }, coins, extraOutputs, feeRate: await bitcoinFeeRate(fetchImpl, signal),
  }), timeoutMs);
  return checkBitcoinFunds({ provider, address, coins, requiredSats, estimated: true });
}

const ethInteger = value => {
  requireValue(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'invalid Ethereum amount');
  return BigInt(value);
};
const addressWord = value => {
  requireValue(typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value), 'invalid Ethereum address');
  return value.slice(2).toLowerCase().padStart(64, '0');
};

export async function checkEthereumFunds({ provider, transaction, token, timeoutMs }) {
  const address = transaction.from;
  const rpc = (method, params) => provider.request({ method, params });
  if (token) {
    const balance = await readFunds('ERC-20 balance', address, async () => {
      const owner = addressWord(address); addressWord(token.address);
      const [raw, decimals] = await Promise.all([
        rpc('eth_call', [{ to: token.address, data: '0x70a08231' + owner }, 'latest']),
        rpc('eth_call', [{ to: token.address, data: '0x313ce567' }, 'latest']),
      ]);
      return { available: ethInteger(raw), decimals: decimalsFor(ethInteger(decimals).toString()), needed: integer(token.amount) };
    }, timeoutMs);
    const label = token.symbol ?? 'ERC-20 tokens';
    if (balance.available < balance.needed) refuse(`Not enough ${label}: this payment needs ${displayAmount(balance.needed, balance.decimals)} ${label}, your wallet has ${displayAmount(balance.available, balance.decimals)} ${label}. Token: ${token.address}. Wallet: ${address}. Nothing was sent for this step.`);
    if (token.requireAllowance) {
      const allowance = await readFunds('ERC-20 allowance', address, async () => ethInteger(await rpc('eth_call', [{ to: token.address,
        data: '0xdd62ed3e' + addressWord(address) + addressWord(token.spender) }, 'latest'])), timeoutMs);
      if (allowance < balance.needed) refuse(`Not enough ${label} allowance: this payment needs ${displayAmount(balance.needed, balance.decimals)} ${label}, the approved allowance is ${displayAmount(allowance, balance.decimals)} ${label}. Wallet: ${address}. Nothing was sent for this step; approve the payment amount first.`);
    }
  }
  const { available, needed } = await readFunds('Ethereum balance and gas', address, async () => {
    addressWord(address);
    const [rawBalance, rawGas, rawPrice] = await Promise.all([
      rpc('eth_getBalance', [address, 'pending']), rpc('eth_estimateGas', [transaction]),
      transaction.maxFeePerGas ?? transaction.gasPrice ?? rpc('eth_gasPrice', []),
    ]);
    const estimated = ethInteger(rawGas), limit = transaction.gas ? ethInteger(transaction.gas) : estimated;
    requireValue(estimated > 0n && ethInteger(rawPrice) > 0n, 'invalid Ethereum gas estimate');
    return { available: ethInteger(rawBalance), needed: ethInteger(transaction.value ?? '0x0') + (limit > estimated ? limit : estimated) * ethInteger(rawPrice) };
  }, timeoutMs);
  if (available < needed) refuse(`Not enough ETH for payment and gas: this step needs about ${displayAmount(needed, 18)} ETH, your wallet has ${displayAmount(available, 18)} ETH. Wallet: ${address}. Nothing was sent for this step. Gas is an estimate.`);
  return { available, needed };
}
