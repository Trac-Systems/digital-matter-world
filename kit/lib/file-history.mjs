// Offline immutable archive reader. Resident memory is one configurable page,
// independent of chain length. All callers still verify genesis, PoW, linkage,
// retargets and median time; a filename or supplied digest is never authority.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseHeader, verifyHistory } from '../../rules/src/headers.js';
import { assert as check } from '../../rules/src/core.js';

export class FileHistory {
  constructor(file, { pageHeaders = 4096, count } = {}) {
    check(Number.isSafeInteger(pageHeaders) && pageHeaders > 0, 'header_page_settings');
    this.file = file; this.pageHeaders = pageHeaders; this.fd = openSync(file, 'r');
    this.identity = fstatSync(this.fd, { bigint: true }); const bytes = Number(this.identity.size);
    if (!Number.isSafeInteger(bytes) || !bytes || bytes % 80) { this.close(); throw Error('headers_length'); }
    this.length = count ?? bytes / 80; this.pageStart = -1;
    if (!Number.isSafeInteger(this.length) || this.length < 1 || this.length > bytes / 80) { this.close(); throw Error('headers_length'); }
  }
  raw(height) {
    const h = Number(height);
    check((typeof height === 'number' || typeof height === 'string' && /^(0|[1-9][0-9]*)$/.test(height)) && Number.isSafeInteger(h) && h >= 0 && h < this.length, 'history_height');
    const start = Math.floor(h / this.pageHeaders) * this.pageHeaders;
    if (this.pageStart !== start) {
      const stat = fstatSync(this.fd, { bigint: true });
      check(stat.size === this.identity.size && stat.mtimeNs === this.identity.mtimeNs && stat.ctimeNs === this.identity.ctimeNs, 'headers_changed');
      const size = Math.min(this.pageHeaders, this.length - start) * 80, bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) { const n = readSync(this.fd, bytes, offset, size - offset, start * 80 + offset); check(n > 0, 'headers_truncated'); offset += n; }
      this.page = bytes; this.pageStart = start;
    }
    return Buffer.from(this.page.subarray((h - start) * 80, (h - start + 1) * 80));
  }
  get(height) { return parseHeader(this.raw(height), height); }
  hashAt = height => this.get(height).hash;
  field(height, field, dt = 'n') {
    check((field === 4 || field === 10) ? dt === 'n' : field === 11 && (dt === 'n' || dt === 'h'), 'field');
    const raw = this.raw(height), n = field === 4 ? BigInt(height) : BigInt(raw.readUInt32LE(field === 10 ? 76 : 72));
    return n.toString(dt === 'h' ? 16 : 10);
  }
  digest() { const digest = createHash('sha256'); for (let h = 0; h < this.length; h++) digest.update(this.raw(h)); return digest.digest('hex'); }
  close() { if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; this.page = undefined; } }
}
export function loadFileHistory(file, settings) {
  const history = new FileHistory(file, settings);
  try { history.proof = { ...verifyHistory(history), sha256: history.digest() }; return history; }
  catch (error) { history.close(); throw error; }
}
