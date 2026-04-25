/**
 * In-memory pending edit proposals (userId → proposal).
 *
 * Single module-level Map shared by all callers so that the chatbot shim
 * and any future core call site see the same pending-edit slot per user.
 *
 * One pending edit per user. A new /edit call replaces any in-progress proposal;
 * the Confirm/Cancel flow re-fetches at confirm time to pick up whichever proposal
 * is current. TTL is enforced by the proposal's expiresAt field — checked in
 * EditService.confirmEdit().
 */

import type { EditProposal } from '../edit/index.js';

export const pendingEdits = new Map<string, EditProposal>();
