/**
 * Re-export of the shared `@core/utils/atomic-write` helper so existing
 * regression imports (`./atomic-write.js`) continue to resolve.
 *
 * REQ-REG-GUI-V2-002.
 */

export { atomicWriteJson, type AtomicWriteOptions } from '@core/utils/atomic-write.js';
