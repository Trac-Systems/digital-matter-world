import { parseHeader } from './headers.js';
import { uintV2 } from './integers-v2.js';

// Header-internal fields retain Bitcoin's wire widths. The chain height is
// metadata, not a uint32 field in those 80 bytes.
export function parseHeaderV2(raw, height) { uintV2(height); return { ...parseHeader(raw, 0), height }; }
export function headerByteOffsetV2(height) { return String(BigInt(uintV2(height)) * 80n); }
