// Optional read order can improve source batching, but must not make an
// otherwise readable context exceed the operator's existing archive limit.
export function encodeReplayContext(context, limit) {
  const text = JSON.stringify(context);
  if (Buffer.byteLength(text) <= limit || !context.inputs?.some(input => input.claimReadHints !== undefined)) return text;
  return JSON.stringify({ ...context, inputs: context.inputs.map(input => {
    const { claimReadHints: _hints, ...rest } = input; return rest;
  }) });
}
