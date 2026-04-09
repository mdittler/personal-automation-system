import { describe, expect, it, vi } from 'vitest';
import {
	slugifyGuestName,
	loadGuests,
	saveGuests,
	addGuest,
	removeGuest,
	findGuestByName,
	formatGuestProfile,
	formatGuestList,
	getGuestsWithRestriction,
} from '../services/guest-profiles.js';
import type { GuestProfile } from '../types.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeGuest(overrides: Partial<GuestProfile> = {}): GuestProfile {
	return {
		name: 'Sarah Johnson',
		slug: 'sarah-johnson',
		dietaryRestrictions: ['vegetarian'],
		allergies: ['tree nuts'],
		notes: 'Prefers spicy food',
		createdAt: '2026-04-08T10:00:00.000Z',
		updatedAt: '2026-04-08T10:00:00.000Z',
		...overrides,
	};
}

const GUESTS_YAML = `- name: Sarah Johnson
  slug: sarah-johnson
  dietaryRestrictions:
    - vegetarian
  allergies:
    - tree nuts
  notes: Prefers spicy food
  createdAt: "2026-04-08T10:00:00.000Z"
  updatedAt: "2026-04-08T10:00:00.000Z"
- name: Mike Chen
  slug: mike-chen
  dietaryRestrictions:
    - gluten-free
  allergies: []
  createdAt: "2026-04-08T10:00:00.000Z"
  updatedAt: "2026-04-08T10:00:00.000Z"`;

describe('guest-profiles', () => {
	// ─── slugifyGuestName ─────────────────────────────────────
	describe('slugifyGuestName', () => {
		it('lowercases and replaces spaces with hyphens', () => {
			expect(slugifyGuestName('Sarah Johnson')).toBe('sarah-johnson');
		});

		it('strips special characters', () => {
			expect(slugifyGuestName("Mary O'Brien")).toBe('mary-obrien');
		});

		it('trims whitespace', () => {
			expect(slugifyGuestName('  Bob  ')).toBe('bob');
		});

		it('collapses multiple hyphens', () => {
			expect(slugifyGuestName('Jean - Pierre')).toBe('jean-pierre');
		});
	});

	// ─── loadGuests ───────────────────────────────────────────
	describe('loadGuests', () => {
		it('returns empty array when no file exists', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const result = await loadGuests(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array for empty file', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue('') });
			const result = await loadGuests(store as never);
			expect(result).toEqual([]);
		});

		it('parses YAML guest list', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(GUESTS_YAML),
			});
			const result = await loadGuests(store as never);
			expect(result).toHaveLength(2);
			expect(result[0]!.name).toBe('Sarah Johnson');
			expect(result[1]!.name).toBe('Mike Chen');
		});

		it('strips frontmatter before parsing', async () => {
			const withFm = `---\ntitle: Guests\n---\n${GUESTS_YAML}`;
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(withFm),
			});
			const result = await loadGuests(store as never);
			expect(result).toHaveLength(2);
		});
	});

	// ─── saveGuests ───────────────────────────────────────────
	describe('saveGuests', () => {
		it('writes YAML with frontmatter', async () => {
			const store = createMockScopedStore();
			const guests = [makeGuest()];
			await saveGuests(store as never, guests);
			expect(store.write).toHaveBeenCalledOnce();
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('---');
			expect(written).toContain('Sarah Johnson');
		});

		it('writes empty array as empty list', async () => {
			const store = createMockScopedStore();
			await saveGuests(store as never, []);
			expect(store.write).toHaveBeenCalledOnce();
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('[]');
		});
	});

	// ─── addGuest ─────────────────────────────────────────────
	describe('addGuest', () => {
		it('adds guest to empty list', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			await addGuest(store as never, makeGuest());
			expect(store.write).toHaveBeenCalledOnce();
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('Sarah Johnson');
		});

		it('appends guest to existing list', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(GUESTS_YAML),
			});
			const newGuest = makeGuest({ name: 'Emma Davis', slug: 'emma-davis' });
			await addGuest(store as never, newGuest);
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('Sarah Johnson');
			expect(written).toContain('Emma Davis');
		});

		it('rejects duplicate slug', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(GUESTS_YAML),
			});
			const dupe = makeGuest({ name: 'Sarah Johnson', slug: 'sarah-johnson' });
			await expect(addGuest(store as never, dupe)).rejects.toThrow(/already exists/i);
		});
	});

	// ─── removeGuest ──────────────────────────────────────────
	describe('removeGuest', () => {
		it('removes guest by slug', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(GUESTS_YAML),
			});
			const removed = await removeGuest(store as never, 'sarah-johnson');
			expect(removed).toBe(true);
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).not.toContain('Sarah Johnson');
			expect(written).toContain('Mike Chen');
		});

		it('returns false if slug not found', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(GUESTS_YAML),
			});
			const removed = await removeGuest(store as never, 'nobody');
			expect(removed).toBe(false);
			expect(store.write).not.toHaveBeenCalled();
		});
	});

	// ─── findGuestByName ──────────────────────────────────────
	describe('findGuestByName', () => {
		const guests = [
			makeGuest({ name: 'Sarah Johnson', slug: 'sarah-johnson' }),
			makeGuest({ name: 'Mike Chen', slug: 'mike-chen', dietaryRestrictions: ['gluten-free'] }),
		];

		it('finds exact match', () => {
			expect(findGuestByName(guests, 'Sarah Johnson')?.slug).toBe('sarah-johnson');
		});

		it('finds case-insensitive match', () => {
			expect(findGuestByName(guests, 'sarah johnson')?.slug).toBe('sarah-johnson');
		});

		it('finds partial match (first name)', () => {
			expect(findGuestByName(guests, 'Sarah')?.slug).toBe('sarah-johnson');
		});

		it('returns null when no match', () => {
			expect(findGuestByName(guests, 'Bob')).toBeNull();
		});
	});

	// ─── formatGuestProfile ───────────────────────────────────
	describe('formatGuestProfile', () => {
		it('formats a guest with all fields', () => {
			const result = formatGuestProfile(makeGuest());
			expect(result).toContain('Sarah Johnson');
			expect(result).toContain('vegetarian');
			expect(result).toContain('tree nuts');
			expect(result).toContain('Prefers spicy food');
		});

		it('formats a guest with no restrictions', () => {
			const guest = makeGuest({ dietaryRestrictions: [], allergies: [], notes: undefined });
			const result = formatGuestProfile(guest);
			expect(result).toContain('Sarah Johnson');
			expect(result).toContain('No restrictions');
		});
	});

	// ─── formatGuestList ──────────────────────────────────────
	describe('formatGuestList', () => {
		it('formats multiple guests', () => {
			const guests = [
				makeGuest(),
				makeGuest({ name: 'Mike Chen', slug: 'mike-chen', dietaryRestrictions: ['gluten-free'], allergies: [] }),
			];
			const result = formatGuestList(guests);
			expect(result).toContain('Sarah Johnson');
			expect(result).toContain('Mike Chen');
		});

		it('returns message for empty list', () => {
			const result = formatGuestList([]);
			expect(result).toMatch(/no guest/i);
		});
	});

	// ─── getGuestsWithRestriction ─────────────────────────────
	describe('getGuestsWithRestriction', () => {
		const guests = [
			makeGuest({ name: 'Sarah', slug: 'sarah', dietaryRestrictions: ['vegetarian'] }),
			makeGuest({ name: 'Mike', slug: 'mike', dietaryRestrictions: ['gluten-free'] }),
			makeGuest({ name: 'Emma', slug: 'emma', dietaryRestrictions: ['vegetarian', 'dairy-free'] }),
		];

		it('filters by restriction', () => {
			const result = getGuestsWithRestriction(guests, 'vegetarian');
			expect(result).toHaveLength(2);
			expect(result.map(g => g.slug)).toEqual(['sarah', 'emma']);
		});

		it('returns empty for unknown restriction', () => {
			expect(getGuestsWithRestriction(guests, 'vegan')).toEqual([]);
		});

		it('matches case-insensitively', () => {
			const result = getGuestsWithRestriction(guests, 'Vegetarian');
			expect(result).toHaveLength(2);
		});
	});

	// ─── Security & Validation ───────────────────────────────
	describe('security', () => {
		it('rejects empty guest name', async () => {
			const store = createMockScopedStore();
			const guest = makeGuest({ name: '', slug: '' });
			await expect(addGuest(store as never, guest)).rejects.toThrow(/cannot be empty/);
		});

		it('rejects guest name exceeding max length', async () => {
			const store = createMockScopedStore();
			const longName = 'A'.repeat(101);
			const guest = makeGuest({ name: longName, slug: 'aaaa' });
			await expect(addGuest(store as never, guest)).rejects.toThrow(/too long/);
		});

		it('slugifies names with special characters safely', () => {
			expect(slugifyGuestName('../etc/passwd')).toBe('etcpasswd');
			expect(slugifyGuestName('<script>alert(1)</script>')).toBe('scriptalert1script');
			expect(slugifyGuestName('  Normal Name  ')).toBe('normal-name');
		});
	});
});
