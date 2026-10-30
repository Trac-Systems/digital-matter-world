// Offline comparison against the amount assignments in the pinned ord-tap.
// Usage: node rules/scripts/check-field-value-tap.mjs ORD_TAP_CHECKOUT HEADERS_BIN
// Requires rustc. This exercises the numeric branches, not the full indexer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HeaderHistory, hash, patternAmount } from '../src/index.js';

const [checkout, archive] = process.argv.slice(2);
assert(checkout && archive, 'Provide the local ord-tap checkout and frozen header archive');
const versions = JSON.parse(await readFile(new URL('../../local/versions.json', import.meta.url)));
const path = 'src/index/updater/inscription_updater/tap/ops/dmt_mint.rs';
const source = execFileSync('git', ['-C', resolve(checkout), 'show', `${versions.ordTap}:${path}`], { encoding: 'utf8' });
const statements = [
  /amount = match Self::js_bigint_string_to_i128\(&blk_js_str\) \{[\s\S]*?\};/,
  /amount = hdr\.nonce as i128;/,
  /amount = hdr\.bits as i128;/
].map(expression => { const found = source.match(expression); assert(found, 'Pinned TAP amount branch changed'); return found[0]; });
const bytes = await readFile(archive), history = new HeaderHistory(bytes);
assert(history.length > 0 && bytes.length % 80 === 0, 'Expected complete raw Bitcoin headers starting at genesis');
const directory = await mkdtemp(join(tmpdir(), 'dmw-tap-amount-'));
try {
  const rust = join(directory, 'amount.rs'), binary = join(directory, 'amount');
  // Canonical nonnegative decimal heights are the only strings DMW emits.
  // Rust parse is sufficient for that subset of TAP's JS BigInt parser.
  await writeFile(rust, `use std::{env,fs,io::{self,Write}};
struct Header { nonce:u32, bits:u32 }
struct Oracle;
impl Oracle {
 fn js_bigint_string_to_i128(s:&str)->Option<i128> { s.parse().ok() }
 fn emit(h:usize,hdr:Header,out:&mut impl Write) {
  let blk_js_str=h.to_string(); let mut amount:i128;
  ${statements.map(statement => statement + '\n out.write_all(&(amount as u64).to_le_bytes()).unwrap();').join('\n')}
 }
}
fn main() {
 let bytes=fs::read(env::args().nth(1).unwrap()).unwrap(); assert_eq!(bytes.len()%80,0);
 let mut out=io::BufWriter::new(io::stdout().lock());
 for (h,b) in bytes.chunks_exact(80).enumerate() {
  Oracle::emit(h,Header {nonce:u32::from_le_bytes(b[76..80].try_into().unwrap()),bits:u32::from_le_bytes(b[72..76].try_into().unwrap())},&mut out);
 }
}
`);
  execFileSync('rustc', ['--edition=2021', '-O', rust, '-o', binary]);
  const expected = execFileSync(binary, [resolve(archive)], { maxBuffer: history.length * 24 + 1024 });
  assert.equal(expected.length, history.length * 24);
  let comparisons = 0;
  const modes = [[4, 'n', 0], [10, 'n', 8], [11, 'n', 16], [11, 'h', 16]];
  for (let height = 0; height < history.length; height++) {
    const header = history.get(height);
    for (const [fld, dt, offset] of modes) {
      const proposal = { fld, dt, pat: dt === 'h' ? '[0-9a-f]' : '[0-9]', amountMode: 'field-value' };
      assert.equal(patternAmount(proposal, header), String(expected.readBigUInt64LE(height * 24 + offset)), `Block ${height}, field ${fld}, dt ${dt}`);
      comparisons++;
    }
  }
  console.log(JSON.stringify({ pass: true, node: process.version, rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
    ordTap: versions.ordTap, sourceSha256: hash(source), archiveSha256: hash(bytes), headers: history.length,
    tip: history.get(history.length - 1).hash, comparisons }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
