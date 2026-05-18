/**
 * Shared helpers for GUI auth tests. Currently exposes cookie unsigning so
 * tests can assert on the canonical session payload without duplicating the
 * 10-line @fastify/cookie call.
 */

export interface AuthCookie {
	name: string;
	value: string;
}

export function extractAuthCookie(res: {
	cookies: Array<{ name: string; value: string }>;
}): AuthCookie | undefined {
	return res.cookies.find((c) => c.name === 'pas_auth');
}

/** Unsigns the cookie and returns the userId field from its JSON payload. */
export async function getCookieUserId(rawValue: string, authToken: string): Promise<string> {
	const { unsign } = await import('@fastify/cookie');
	const result = unsign(rawValue, authToken);
	if (!result.valid || !result.value) {
		throw new Error('Cookie failed to unsign');
	}
	const payload = JSON.parse(result.value) as { userId: string };
	return payload.userId;
}
