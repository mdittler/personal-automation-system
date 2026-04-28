import { randomBytes } from 'node:crypto';

const HEX8_RE = /^[0-9a-f]{8}$/;

export function mintSessionId(now: Date, rng: () => string = () => randomBytes(4).toString('hex')): string {
	const hex = rng();
	if (!HEX8_RE.test(hex)) {
		throw new Error(`mintSessionId: rng must return exactly 8 lowercase hex chars, got ${JSON.stringify(hex)}`);
	}
	const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
	const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(now.getUTCDate()).padStart(2, '0');
	const hh = String(now.getUTCHours()).padStart(2, '0');
	const mi = String(now.getUTCMinutes()).padStart(2, '0');
	const ss = String(now.getUTCSeconds()).padStart(2, '0');
	return `${yyyy}${mm}${dd}_${hh}${mi}${ss}_${hex}`;
}
