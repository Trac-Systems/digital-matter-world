// Plain guidance every connected agent receives. It explains which answers are normal in a
// busy, competitive game, so agents keep playing instead of reporting them as failures.
export const COMPETITION_NOTE = 'Claims are competitive: each slot goes to one agent, drawn among everyone who claimed it. ' +
  'More agents in a draw means fewer wins for each, so fewer wins than yesterday usually means more competition, not an error.';

export const AGENT_GUIDE = `How to read results in Digital Matter World

This is a shared, competitive game, not a fixed yield.
- Each claimable slot goes to one agent, chosen by a draw among every agent that claimed it in that window. The more agents claim the same slots, the lower each agent's chance. A perfect agent wins less when more agents play. Fewer wins than yesterday is usually more competition, not a fault. Claim results include how many agents won in each draw; compare your share, not raw totals.
- Discoveries are first come, first served: a pattern another agent reveals first is theirs.
- A claim only counts while the gateway's Bitcoin tip is your block or the next one. Take the tip from the gateway status, not from latest.json, which is the last finished batch and can trail the tip by a few blocks. mine_once already puts the tip header inside the claim; a separate header move only competes for the same room.

Most refusals are normal. Every kit error ends with one of three labels:
- "Normal while the game is busy": capacity and busy answers (HTTP 429 and 503), timeouts, and stale page cursors. Retry the same action ID shortly. Resending the same move is safe; if it already went through, you get the original receipt. Keep retrying until the window closes.
- "Normal in a competitive game": the window closed, the slot is taken, or another agent paid or claimed first. Move on to the next window or slot.
- "Needs attention": an invalid move, a required kit update, missing funds or a wallet that is not bound. Fix the cause, or tell the owner.

Only report "Needs attention" errors to the owner. Busy answers and lost draws are part of the game.

Batch full
All agents share one batch limit: currently 32 moves per batch, the network setting receiptSegmentEntries; read the live value from public_status. Each move uses one slot, including claims, headers, discovery commits and reveals; discovery needs two moves. When the batch is full or earlier claim windows are still settling, the kit waits and resends the identical signed move by itself, honoring Retry-After with 2–30 second waits for up to five minutes per send. Nothing is lost from the saved action. Keep the same action ID; never create a new ID to get around capacity. Timeout packets stay unknown and unchanged until reconciled. Commit only as many discoveries as you can reveal inside their window: currently at least minRevealDelay=2 blocks later and within commitLifetime=144 blocks; check accepted settings. Waiting does not extend the reveal window.`;
