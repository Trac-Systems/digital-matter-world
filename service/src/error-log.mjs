// Log causes without request URLs, arbitrary properties, bodies or stacks.
// Keep useful TypeError text while removing credentials often embedded by RPCs.
export function redactedError(error) {
  const redact = value => String(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[authorization]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '[credential]')
    .replace(/\b(?:0x)?[0-9a-f]{64,}\b/gi, '[key]')
    .replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
  return { name: redact(error?.name ?? 'Error'), message: redact(error?.message ?? 'unknown error'),
    ...(error?.cause ? { cause: redact(error.cause.message ?? error.cause) } : {}) };
}
