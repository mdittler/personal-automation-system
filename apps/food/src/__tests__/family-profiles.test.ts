import { describe, expect, it, vi } from 'vitest';
import {
	computeAgeDisplay,
	computeAgeMonths,
	deleteChildProfile,
	formatChildProfile,
	loadAllChildren,
	loadChildProfile,
	parseBirthDate,
	saveChildProfile,
	slugifyChildName,
} from '../services/family-profiles.js';
import type { ChildFoodLog, ChildProfile, FoodIntroduction } from '../types.js';

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

function makeProfile(overrides: Partial<ChildProfile> = {}): ChildProfile {
	return {
		name: 'Margot',
		slug: 'margot',
		birthDate: '2024-06-15',
		allergenStage: 'early-introduction',
		knownAllergens: ['milk', 'eggs'],
		avoidAllergens: [],
		dietaryNotes: 'Prefers soft textures',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeLog(
	profileOverrides: Partial<ChildProfile> = {},
	introductions: FoodIntroduction[] = [],
): ChildFoodLog {
	return {
		profile: makeProfile(profileOverrides),
		introductions,
	};
}

const MARGOT_YAML = `profile:
  name: Margot
  slug: margot
  birthDate: "2024-06-15"
  allergenStage: early-introduction
  knownAllergens:
    - milk
    - eggs
  avoidAllergens: []
  dietaryNotes: Prefers soft textures
  createdAt: "2026-01-01T00:00:00.000Z"
  updatedAt: "2026-01-01T00:00:00.000Z"
introductions:
  - food: scrambled eggs
    allergenCategory: eggs
    date: "2026-03-20"
    reaction: none
    accepted: true
    notes: Loved it`;

describe('family-profiles', () => {
	// ─── parseBirthDate ─────────────────────────────────────────
	describe('parseBirthDate', () => {
		it('parses ISO format', () => {
			expect(parseBirthDate('2024-06-15')).toBe('2024-06-15');
		});

		it('parses US format MM/DD/YYYY', () => {
			expect(parseBirthDate('6/15/2024')).toBe('2024-06-15');
		});

		it('parses US format with leading zeros', () => {
			expect(parseBirthDate('06/15/2024')).toBe('2024-06-15');
		});

		it('parses named month format', () => {
			const result = parseBirthDate('June 15 2024');
			expect(result).toBe('2024-06-15');
		});

		it('parses abbreviated month', () => {
			const result = parseBirthDate('Jun 15 2024');
			expect(result).toBe('2024-06-15');
		});

		it('returns null for invalid date', () => {
			expect(parseBirthDate('not-a-date')).toBeNull();
		});

		it('returns null for empty string', () => {
			expect(parseBirthDate('')).toBeNull();
		});

		it('returns null for invalid ISO date (Feb 30)', () => {
			expect(parseBirthDate('2024-02-30')).toBeNull();
		});

		it('handles whitespace', () => {
			expect(parseBirthDate('  2024-06-15  ')).toBe('2024-06-15');
		});

		it('handles leap year date', () => {
			expect(parseBirthDate('2024-02-29')).toBe('2024-02-29');
		});

		it('returns null for non-leap year Feb 29', () => {
			expect(parseBirthDate('2023-02-29')).toBeNull();
		});
	});

	// ─── slugifyChildName ────────────────────────────────────────
	describe('slugifyChildName', () => {
		it('lowercases and trims', () => {
			expect(slugifyChildName('Margot')).toBe('margot');
		});

		it('replaces spaces with hyphens', () => {
			expect(slugifyChildName('Baby Girl')).toBe('baby-girl');
		});

		it('strips non-alphanumeric characters except hyphens', () => {
			expect(slugifyChildName("O'Brien Jr.")).toBe('obrien-jr');
		});

		it('collapses multiple hyphens', () => {
			expect(slugifyChildName('  Ana  Maria  ')).toBe('ana-maria');
		});
	});

	// ─── computeAgeMonths ────────────────────────────────────────
	describe('computeAgeMonths', () => {
		it('computes months for a ~2 year old', () => {
			// Born 2024-06-15, today 2026-04-07 → 21 months (not 22 — April 7 is before June 15)
			expect(computeAgeMonths('2024-06-15', '2026-04-07')).toBe(21);
		});

		it('computes 0 months for newborn', () => {
			expect(computeAgeMonths('2026-04-01', '2026-04-07')).toBe(0);
		});

		it('computes exact months when day matches', () => {
			expect(computeAgeMonths('2025-01-15', '2026-01-15')).toBe(12);
		});
	});

	// ─── computeAgeDisplay ────────────────────────────────────────
	describe('computeAgeDisplay', () => {
		it('shows months for under 2 years', () => {
			expect(computeAgeDisplay('2024-06-15', '2026-04-07')).toBe('21 months');
		});

		it('shows years for 2+ years', () => {
			expect(computeAgeDisplay('2022-01-01', '2026-04-07')).toBe('4 years');
		});

		it('shows singular month', () => {
			expect(computeAgeDisplay('2026-03-01', '2026-04-07')).toBe('1 month');
		});

		it('shows singular year', () => {
			// 12 months = show "1 year" not "12 months" — but actually 12-23 months should still show months
			// Only >= 24 months switches to years
			expect(computeAgeDisplay('2025-04-01', '2026-04-07')).toBe('12 months');
		});
	});

	// ─── loadChildProfile ────────────────────────────────────────
	describe('loadChildProfile', () => {
		it('returns null for nonexistent profile', async () => {
			const store = createMockScopedStore();
			const result = await loadChildProfile(store as any, 'margot');
			expect(result).toBeNull();
		});

		it('parses YAML into ChildFoodLog', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(MARGOT_YAML),
			});
			const result = await loadChildProfile(store as any, 'margot');
			expect(result).not.toBeNull();
			expect(result?.profile.name).toBe('Margot');
			expect(result?.profile.slug).toBe('margot');
			expect(result?.profile.allergenStage).toBe('early-introduction');
			expect(result?.profile.knownAllergens).toEqual(['milk', 'eggs']);
			expect(result?.introductions).toHaveLength(1);
			expect(result?.introductions[0].food).toBe('scrambled eggs');
			expect(store.read).toHaveBeenCalledWith('children/margot.yaml');
		});

		it('returns null for corrupted YAML', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(':::invalid'),
			});
			const result = await loadChildProfile(store as any, 'margot');
			expect(result).toBeNull();
		});

		it('rejects slug with path traversal', async () => {
			const store = createMockScopedStore();
			const result = await loadChildProfile(store as any, '../etc/passwd');
			expect(result).toBeNull();
			expect(store.read).not.toHaveBeenCalled();
		});
	});

	// ─── saveChildProfile ────────────────────────────────────────
	describe('saveChildProfile', () => {
		it('writes YAML to children/<slug>.yaml', async () => {
			const store = createMockScopedStore();
			const log = makeLog();
			await saveChildProfile(store as any, log);
			expect(store.write).toHaveBeenCalledWith(
				'children/margot.yaml',
				expect.stringContaining('name: Margot'),
			);
		});
	});

	// ─── loadAllChildren ─────────────────────────────────────────
	describe('loadAllChildren', () => {
		it('returns empty array when no children exist', async () => {
			const store = createMockScopedStore();
			const result = await loadAllChildren(store as any);
			expect(result).toEqual([]);
		});

		it('loads all child profiles from children/ directory', async () => {
			const store = createMockScopedStore({
				list: vi.fn().mockResolvedValue(['children/margot.yaml', 'children/oliver.yaml']),
				read: vi.fn()
					.mockResolvedValueOnce(MARGOT_YAML)
					.mockResolvedValueOnce(
						`profile:\n  name: Oliver\n  slug: oliver\n  birthDate: "2025-01-10"\n  allergenStage: pre-solids\n  knownAllergens: []\n  avoidAllergens: []\n  dietaryNotes: ""\n  createdAt: "2026-01-01T00:00:00.000Z"\n  updatedAt: "2026-01-01T00:00:00.000Z"\nintroductions: []`,
					),
			});
			const result = await loadAllChildren(store as any);
			expect(result).toHaveLength(2);
			expect(result[0].profile.name).toBe('Margot');
			expect(result[1].profile.name).toBe('Oliver');
		});
	});

	// ─── deleteChildProfile ──────────────────────────────────────
	describe('deleteChildProfile', () => {
		it('archives the child YAML file', async () => {
			const store = createMockScopedStore({
				exists: vi.fn().mockResolvedValue(true),
			});
			const result = await deleteChildProfile(store as any, 'margot');
			expect(result).toBe(true);
			expect(store.archive).toHaveBeenCalledWith('children/margot.yaml');
		});

		it('returns false if child does not exist', async () => {
			const store = createMockScopedStore();
			const result = await deleteChildProfile(store as any, 'unknown');
			expect(result).toBe(false);
		});

		it('rejects slug with path traversal', async () => {
			const store = createMockScopedStore();
			const result = await deleteChildProfile(store as any, '../hack');
			expect(result).toBe(false);
		});
	});

	// ─── formatChildProfile ──────────────────────────────────────
	describe('formatChildProfile', () => {
		it('formats profile with age and allergen info', () => {
			const log = makeLog({}, [
				{
					food: 'scrambled eggs',
					allergenCategory: 'eggs',
					date: '2026-03-20',
					reaction: 'none',
					accepted: true,
					notes: 'Loved it',
				},
			]);
			const output = formatChildProfile(log, '2026-04-07');
			expect(output).toContain('Margot');
			expect(output).toContain('21 months');
			expect(output).toContain('early-introduction');
			expect(output).toContain('milk');
			expect(output).toContain('eggs');
			expect(output).toContain('scrambled eggs');
		});

		it('handles profile with no introductions', () => {
			const log = makeLog();
			const output = formatChildProfile(log, '2026-04-07');
			expect(output).toContain('Margot');
			expect(output).toContain('No foods introduced yet');
		});

		it('escapes Markdown control characters in profile fields', () => {
			const log: ChildFoodLog = {
				profile: {
					name: 'Baby *Star*',
					slug: 'baby-star',
					birthDate: '2025-06-01',
					allergenStage: 'early-introduction',
					knownAllergens: ['tree_nuts'],
					avoidAllergens: ['peanut [severe]'],
					dietaryNotes: 'Likes `soft` foods',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				introductions: [
					{
						food: '*Almond* Butter',
						date: '2026-04-10',
						accepted: true,
						allergenCategory: 'tree_nuts',
						reaction: 'none',
						notes: '',
					},
				],
			};

			const text = formatChildProfile(log, '2026-04-11');

			expect(text).toContain('\\*Star\\*');
			expect(text).toContain('tree\\_nuts');
			expect(text).toContain('peanut \\[severe\\]');
			expect(text).toContain('Likes \\`soft\\` foods');
			expect(text).toContain('\\*Almond\\*');
			// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
			// mismatch deferred to Finding 21. Only assert data-field escaping here.
		});
	});
});
