import { Contract } from 'trac-peer';

// A terminal subnet imports application state. The pinned runtime owns its
// own administrator, writer membership and transaction/message bookkeeping.
// Use that runtime's exact predicate rather than maintaining a second list.
export const isApplicationNotaryKey = key => typeof key === 'string' && !Contract.prototype.isReservedKey(key);
