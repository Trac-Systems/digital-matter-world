// Same square spiral as the rules library: block 0 at the centre, consecutive blocks touch.
export function heightToPlot(height) {
  if (!height) return { x: 0, y: 0 };
  const r = Math.floor((Math.floor(Math.sqrt(height)) + 1) / 2), side = 2 * r;
  const d = (2 * r + 1) ** 2 - 1 - height;
  if (d < side) return { x: r - d, y: -r };
  if (d < 2 * side) return { x: -r, y: -r + d - side };
  if (d < 3 * side) return { x: -r + d - 2 * side, y: r };
  return { x: r, y: r - (d - 3 * side) };
}
export function plotToHeight(x, y) {
  const r = Math.max(Math.abs(x), Math.abs(y));
  if (!r) return 0;
  const side = 2 * r;
  const d = y === -r ? r - x : x === -r ? side + y + r : y === r ? 2 * side + x + r : 3 * side + r - y;
  return (2 * r + 1) ** 2 - 1 - d;
}
export const ringOf = height => Math.floor((Math.floor(Math.sqrt(height)) + 1) / 2);
