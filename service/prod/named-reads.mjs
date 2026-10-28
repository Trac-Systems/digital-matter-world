import { check } from '../src/util.mjs';

const segment = value => encodeURIComponent(String(value));
const inscription = id => typeof id === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(id);
export function installNamedReads(reads, indexer) {
  const exact = async (path, id, locator, { immutable = false } = {}) => {
    check(inscription(id), 'source_item_id');
    check(locator?.id === id && Number.isSafeInteger(locator.offset) && locator.offset >= 0, 'source_locator_required');
    const url = `${path}?offset=${locator.offset}&max=1`;
    const rows = await (immutable ? indexer.indexedRow(url) : indexer.tap(url));
    check(Array.isArray(rows) && rows.length === 1 && rows[0].ins === id, 'source_locator_changed');
    return rows[0];
  };
  reads.sourcePolicy = indexer.policy;
  reads.namedSources = true;
  reads.indexedDeployment = tick => indexer.indexedRow('getDeployment/' + segment(tick));
  reads.element = (id, locator) => exact('getDmtElementsList', id, locator, { immutable: true });
  reads.privilegeAuthority = (id, locator) => exact('getPrivilegeAuthList', id, locator, { immutable: true });
  reads.paymentAuthority = (payer, id, locator) => exact('getAccountAuthList/' + segment(payer), id, locator, { immutable: true });
  const transactionRows = async (kind, id) => {
    const tx = id.slice(0, 64), count = Number(await indexer.tap(kind + 'Length/' + tx));
    check(Number.isSafeInteger(count) && count >= 0 && count <= indexer.policy.pageSize, 'transaction_locators_required');
    const rows = await indexer.indexedRow(kind + '/' + tx + '?offset=0&max=' + indexer.policy.pageSize);
    check(Array.isArray(rows) && rows.length === count, 'source_transaction_changed');
    return rows;
  };
  reads.mintedItem = async (id, locator) => locator ? exact('getMintedList/' + id.slice(0, 64), id, locator, { immutable: true })
    : (await transactionRows('getMintedList', id)).find(row => row.ins === id) ?? null;
  reads.paymentTransfers = async (id, locators) => {
    if (!locators) return (await transactionRows('getTransferredList', id)).map((transfer, index) => ({ index, transfer })).filter(({ transfer }) => transfer.ins === id);
    check(Array.isArray(locators) && locators.length > 0 && locators.length <= indexer.policy.maxItems, 'payment_locators_required');
    check(new Set(locators.map(l => l.offset)).size === locators.length, 'payment_locator_duplicate');
    const rows = [];
    for (const locator of locators) rows.push({ index: locator.offset, transfer: await exact('getTransferredList/' + id.slice(0, 64), id, locator, { immutable: true }) });
    return rows;
  };
  return reads;
}
