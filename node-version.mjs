// Shared by Node entry points; keep package engines in sync with this range.
export function supportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 24 && (minor > 22 || (minor === 22 && patch >= 1));
}
