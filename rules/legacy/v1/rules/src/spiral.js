import { assert, integer } from './core.js';
function sqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
}
export function heightToPlot(height) {
  assert(integer(height, 0xffffffff), 'height');
  if (!height) return { x: 0, y: 0 };
  const n = BigInt(height), r = (sqrt(n) + 1n) / 2n, side = 2n * r;
  const d = (2n * r + 1n) ** 2n - 1n - n;
  let x, y;
  if (d < side) { x = r - d; y = -r; }
  else if (d < 2n * side) { x = -r; y = -r + d - side; }
  else if (d < 3n * side) { x = -r + d - 2n * side; y = r; }
  else { x = r; y = r - (d - 3n * side); }
  return { x: Number(x), y: Number(y) };
}
export function plotToHeight(x, y) {
  assert(Number.isSafeInteger(x) && Number.isSafeInteger(y) && Math.abs(x) <= 32768 && Math.abs(y) <= 32768, 'plot');
  const r = BigInt(Math.max(Math.abs(x), Math.abs(y)));
  if (!r) return 0;
  const a = BigInt(x), b = BigInt(y), side = 2n * r;
  const d = b === -r ? r - a : a === -r ? side + b + r : b === r ? 2n * side + a + r : 3n * side + r - b;
  const height = Number((2n * r + 1n) ** 2n - 1n - d);
  assert(integer(height, 0xffffffff), 'height');
  return height;
}
export function plotRegion(height) {
  assert(integer(height, 0xffffffff), 'height');
  return { halving: Number(BigInt(height) / 210000n), region: Number(BigInt(height) / 2016n),
    regionOffset: height % 2016, ...heightToPlot(height) };
}
