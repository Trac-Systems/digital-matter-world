// Bound the response time without dropping the in-flight accounting or
// releasing a mutation's lock before its durable work has actually finished.
export function responseBudget(req, res, timeoutMs) {
  let expired = false;
  const methods = ['setHeader', 'writeHead', 'write', 'end'];
  const original = Object.fromEntries(methods.map(name => [name, res[name]]));
  for (const name of methods) res[name] = function (...args) {
    if (expired) return name === 'write' ? false : this;
    return original[name].apply(this, args);
  };
  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return;
    const mutation = req.method === 'POST';
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: mutation ? 'request_pending' : 'read_not_ready', retryable: true,
      message: mutation ? 'Processing is still pending. Retry the identical request to retrieve its state.' : 'The current state is not ready. Retry shortly.' }));
    expired = true;
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}
