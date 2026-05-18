/**
 * Batch 2C: Shared lock key for display-name uniqueness.
 *
 * Both InviteService.createInvite and UserMutationService.registerUser must
 * acquire this same key (via withMultiFileLock alongside their own store path)
 * so a concurrent create/register cannot interleave between the uniqueness
 * check and the persist. Single-process only — for cross-process protection a
 * filesystem flock would be required (out of scope for the local-first
 * single-process PAS deployment target).
 */
export const DISPLAY_NAME_LOCK_KEY = 'display-name:uniqueness';
