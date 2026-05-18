/**
 * Display-name normalization for uniqueness comparisons.
 *
 * Used by:
 *   - InviteService.createInvite — to compare incoming names against existing
 *     user.name values AND against the `name` field of active (unredeemed,
 *     unexpired) invites.
 *   - UserMutationService.registerUser — defensive uniqueness check at
 *     registration time (catches a race past the invite layer).
 *   - scanForDuplicateNames — boot-time duplicate scan.
 *
 * Contract:
 *   - Trims surrounding whitespace.
 *   - Lower-cases via the locale-aware path (so "İ" → "i" with a Turkish locale,
 *     etc. — matches how findByName comparisons are done elsewhere).
 *   - Returns the normalized comparison key. The ORIGINAL-case input is what
 *     gets persisted; only the comparison goes through this function.
 */
export function normalizeDisplayName(raw: string): string {
	return raw.trim().toLocaleLowerCase();
}
