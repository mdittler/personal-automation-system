import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { WasteLogEntry } from '../../types.js';
import {
	appendWaste,
	formatWasteSummary,
	loadWasteLog,
} from '../../services/waste-store.js';

function makeWasteEntry(overrides: Partial<WasteLogEntry> = {}): WasteLogEntry {
	return {
		name: 'Chicken',
		quantity: '1 lb',
		reason: 'expired',
		source: 'pantry',
		date: '2026-04-01',
		...overrides,
	};
}

function mockStore(readResult: string | null = null) {
	return {
		read: vi.fn().mockResolvedValue(readResult),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

describe('waste-store', () => {
	// ── loadWasteLog ─────────────────────────────────────────────

	describe('loadWasteLog', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadWasteLog(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('waste-log.yaml');
		});

		it('parses { entries: [...] } object format', async () => {
			const entries: WasteLogEntry[] = [makeWasteEntry({ name: 'Milk' })];
			const store = mockStore(stringify({ entries }));
			const result = await loadWasteLog(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Milk');
		});

		it('parses array format', async () => {
			const entries: WasteLogEntry[] = [makeWasteEntry({ name: 'Bread' })];
			const store = mockStore(stringify(entries));
			const result = await loadWasteLog(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Bread');
		});

		it('strips frontmatter before parsing', async () => {
			const entries: WasteLogEntry[] = [makeWasteEntry({ name: 'Butter' })];
			const yaml = stringify({ entries });
			const withFm = `---\ntitle: Food Waste Log\ndate: 2026-04-01\n---\n${yaml}`;
			const store = mockStore(withFm);
			const result = await loadWasteLog(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Butter');
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::not valid yaml{{{');
			const result = await loadWasteLog(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when object has no entries array', async () => {
			const store = mockStore(stringify({ something: 'else' }));
			const result = await loadWasteLog(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when data is a non-array/non-object', async () => {
			const store = mockStore('just a string');
			const result = await loadWasteLog(store as never);
			expect(result).toEqual([]);
		});
	});

	// ── appendWaste ──────────────────────────────────────────────

	describe('appendWaste', () => {
		it('writes entry when log is empty', async () => {
			const store = mockStore(null);
			const entry = makeWasteEntry();
			await appendWaste(store as never, entry);
			expect(store.write).toHaveBeenCalledTimes(1);
			const [path, content] = store.write.mock.calls[0] as [string, string];
			expect(path).toBe('waste-log.yaml');
			expect(content).toContain('Chicken');
		});

		it('appends entry to existing log', async () => {
			const existing: WasteLogEntry[] = [makeWasteEntry({ name: 'Milk' })];
			const store = mockStore(stringify({ entries: existing }));
			const newEntry = makeWasteEntry({ name: 'Eggs' });
			await appendWaste(store as never, newEntry);
			const [, content] = store.write.mock.calls[0] as [string, string];
			expect(content).toContain('Milk');
			expect(content).toContain('Eggs');
		});

		it('writes frontmatter in the output', async () => {
			const store = mockStore(null);
			await appendWaste(store as never, makeWasteEntry());
			const [, content] = store.write.mock.calls[0] as [string, string];
			expect(content).toMatch(/^---\n/);
			expect(content).toContain('title: Food Waste Log');
			expect(content).toContain('hearthstone');
		});

		it('writes entries key in YAML body', async () => {
			const store = mockStore(null);
			await appendWaste(store as never, makeWasteEntry());
			const [, content] = store.write.mock.calls[0] as [string, string];
			expect(content).toContain('entries:');
		});

		it('preserves existing entries when appending', async () => {
			const existing: WasteLogEntry[] = [
				makeWasteEntry({ name: 'Milk', reason: 'spoiled' }),
				makeWasteEntry({ name: 'Bread', reason: 'expired' }),
			];
			const store = mockStore(stringify({ entries: existing }));
			await appendWaste(store as never, makeWasteEntry({ name: 'Cheese' }));
			const [, content] = store.write.mock.calls[0] as [string, string];
			expect(content).toContain('Milk');
			expect(content).toContain('Bread');
			expect(content).toContain('Cheese');
		});
	});

	// ── formatWasteSummary ───────────────────────────────────────

	describe('formatWasteSummary', () => {
		it('returns no-waste message for empty entries', () => {
			const result = formatWasteSummary([], 7);
			expect(result).toBe('No food waste logged.');
		});

		it('shows expired entries with clock emoji', () => {
			const entries = [makeWasteEntry({ name: 'Milk', reason: 'expired' })];
			const result = formatWasteSummary(entries, 7);
			expect(result).toContain('⏰');
			expect(result).toContain('Milk');
		});

		it('shows spoiled entries with sick emoji', () => {
			const entries = [makeWasteEntry({ name: 'Chicken', reason: 'spoiled' })];
			const result = formatWasteSummary(entries, 7);
			expect(result).toContain('🤢');
			expect(result).toContain('Chicken');
		});

		it('shows discarded entries with wastebasket emoji', () => {
			const entries = [makeWasteEntry({ name: 'Leftovers', reason: 'discarded' })];
			const result = formatWasteSummary(entries, 7);
			expect(result).toContain('🗑');
			expect(result).toContain('Leftovers');
		});

		it('lists all entries', () => {
			const entries = [
				makeWasteEntry({ name: 'Milk', reason: 'expired' }),
				makeWasteEntry({ name: 'Cheese', reason: 'spoiled' }),
				makeWasteEntry({ name: 'Soup', reason: 'discarded' }),
			];
			const result = formatWasteSummary(entries, 7);
			expect(result).toContain('Milk');
			expect(result).toContain('Cheese');
			expect(result).toContain('Soup');
		});

		it('includes quantity in the output', () => {
			const entries = [makeWasteEntry({ name: 'Rice', quantity: '2 cups' })];
			const result = formatWasteSummary(entries, 7);
			expect(result).toContain('2 cups');
		});
	});
});
