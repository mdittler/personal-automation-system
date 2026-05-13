/**
 * Deterministic palette assignment for the Trends tab charts
 * (REQ-REG-GUI-V2-014).
 *
 * Given a (tier, modelId) pair, returns the same color + shape slot every
 * page load. Across reloads operators compare overlapping lines and points
 * by color/shape — palette stability is therefore load-bearing UX.
 *
 * 8-slot palette; >8 models cycle. The cycling is also deterministic.
 */

export interface PaletteSlot {
	color: string;
	shape: 'circle' | 'triangle' | 'square' | 'diamond';
}

const PALETTE: readonly PaletteSlot[] = [
	{ color: '#6366f1', shape: 'circle' }, // indigo
	{ color: '#10b981', shape: 'triangle' }, // emerald
	{ color: '#f59e0b', shape: 'square' }, // amber
	{ color: '#ef4444', shape: 'diamond' }, // red
	{ color: '#0ea5e9', shape: 'circle' }, // sky
	{ color: '#8b5cf6', shape: 'triangle' }, // violet
	{ color: '#84cc16', shape: 'square' }, // lime
	{ color: '#ec4899', shape: 'diamond' }, // pink
];

/**
 * Stable djb2-style hash for the (tier, modelId) key. Same key → same slot
 * across reloads. Independent of Map iteration order or input ordering.
 */
function hashKey(key: string): number {
	let h = 5381;
	for (let i = 0; i < key.length; i++) {
		h = (h * 33 + key.charCodeAt(i)) >>> 0;
	}
	return h;
}

export function paletteSlotFor(tier: string, modelId: string): PaletteSlot {
	const idx = hashKey(`${tier}:${modelId}`) % PALETTE.length;
	return PALETTE[idx]!;
}

export function paletteSize(): number {
	return PALETTE.length;
}
