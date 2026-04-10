import type { ScopedDataStore } from '@pas/core/types';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import type { QuickMealTemplate } from '../types.js';
import { AsyncLock } from '../utils/async-lock.js';

const QUICK_MEALS_FILE = 'quick-meals.yaml';
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const ARCHIVE_MAX = 500;

// Per-store async lock to serialize read-modify-write sequences. The chain
// is keyed by the file constant — every method touches the same file, and
// the store is per-user via ScopedDataStore, so a single key suffices.
const lock = new AsyncLock();
const LOCK_KEY = QUICK_MEALS_FILE;

// Defence-in-depth schema validation at the persistence boundary. All current
// callers happen to validate, but the store should not trust them — a future
// path that bypasses the guided flow must still be rejected here.
const TemplateSchema = z.object({
	id: z.string().regex(SAFE_SEGMENT, 'unsafe id'),
	userId: z.string(),
	label: z
		.string()
		.min(1, 'label cannot be empty')
		.max(100, 'label too long')
		.refine(
			(s) => !/[*_`[\]()]/.test(s),
			'label cannot contain markdown special characters',
		),
	kind: z.enum(['home', 'restaurant', 'other']),
	ingredients: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(50, 'too many ingredients'),
	notes: z.string().max(500).optional(),
	estimatedMacros: z.object({
		calories: z.number().min(0).max(10000),
		protein: z.number().min(0).max(500),
		carbs: z.number().min(0).max(1500),
		fat: z.number().min(0).max(500),
		fiber: z.number().min(0).max(200),
	}),
	confidence: z.number().min(0).max(1),
	llmModel: z.string(),
	usageCount: z.number().int().min(0),
	createdAt: z.string(),
	updatedAt: z.string(),
	lastUsedAt: z.string().optional(),
});

/**
 * Slugifies a human label into a safe filesystem-and-key-safe id.
 * Lowercases, replaces non-alphanumeric runs with single hyphens,
 * strips leading/trailing hyphens. Throws on inputs that reduce to nothing.
 */
export function slugifyLabel(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (!slug || !SAFE_SEGMENT.test(slug)) {
		throw new Error(`Invalid label '${label}': produces no safe slug`);
	}
	return slug;
}

interface StoreFile {
	active: QuickMealTemplate[];
	archive: QuickMealTemplate[];
}

/**
 * Read + parse the YAML store. On YAML parse failure, preserve the corrupt
 * file by renaming it to `<name>.corrupt-<ts>` so the user can recover, then
 * return an empty store. We MUST NOT silently overwrite a corrupt file with
 * empty data on the next write — that's irreversible loss.
 */
async function readFile(store: ScopedDataStore): Promise<StoreFile> {
	const raw = await store.read(QUICK_MEALS_FILE);
	if (!raw) return { active: [], archive: [] };
	try {
		const body = stripFrontmatter(raw);
		if (!body.trim()) return { active: [], archive: [] };
		const parsed = parse(body) as StoreFile | null;
		return {
			active: parsed?.active ?? [],
			archive: parsed?.archive ?? [],
		};
	} catch (err) {
		// Corrupt YAML — preserve, do not overwrite.
		await preserveCorruptFile(store, raw, err);
		return { active: [], archive: [] };
	}
}

async function preserveCorruptFile(
	store: ScopedDataStore,
	raw: string,
	err: unknown,
): Promise<void> {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const corruptPath = `${QUICK_MEALS_FILE}.corrupt-${ts}`;
	try {
		await store.write(corruptPath, raw);
	} catch {
		// If we cannot even preserve, swallow — surfacing the original parse
		// error to callers who didn't sign up for it would be worse.
	}
	// Best-effort breadcrumb in stderr; the store does not own a logger.
	// eslint-disable-next-line no-console
	console.error(
		`[quick-meals-store] Corrupt YAML preserved as ${corruptPath}:`,
		(err as Error)?.message ?? err,
	);
}

async function writeFile(store: ScopedDataStore, data: StoreFile): Promise<void> {
	const body = stringify(data);
	const frontmatter = generateFrontmatter({
		tags: buildAppTags('food', 'quick-meals'),
		updated: new Date().toISOString(),
	});
	await store.write(QUICK_MEALS_FILE, `${frontmatter}\n${body}`);
}

/** Returns all active (non-archived) quick-meals. */
export async function loadQuickMeals(store: ScopedDataStore): Promise<QuickMealTemplate[]> {
	const f = await readFile(store);
	return f.active;
}

/** Finds an active quick-meal by id, or returns undefined. */
export async function findQuickMealById(
	store: ScopedDataStore,
	id: string,
): Promise<QuickMealTemplate | undefined> {
	const list = await loadQuickMeals(store);
	return list.find((t) => t.id === id);
}

/**
 * Upsert: if a template with the same id exists, replace it; else append.
 * Validates the full template via Zod (defence in depth — all current callers
 * already validate, but the store should not trust them).
 *
 * Serialized via the per-store async lock so concurrent saves cannot lose
 * each other's mutations.
 */
export async function saveQuickMeal(
	store: ScopedDataStore,
	template: QuickMealTemplate,
): Promise<void> {
	const validated = TemplateSchema.safeParse(template);
	if (!validated.success) {
		throw new Error(`Invalid quick-meal template: ${validated.error.message}`);
	}
	await lock.run(LOCK_KEY, async () => {
		const f = await readFile(store);
		const idx = f.active.findIndex((t) => t.id === template.id);
		if (idx >= 0) f.active[idx] = template;
		else f.active.push(template);
		await writeFile(store, f);
	});
}

/**
 * Move a template from active → archive. No-op if not found.
 * Caps the archive at ARCHIVE_MAX with FIFO eviction.
 */
export async function archiveQuickMeal(
	store: ScopedDataStore,
	id: string,
): Promise<void> {
	await lock.run(LOCK_KEY, async () => {
		const f = await readFile(store);
		const idx = f.active.findIndex((t) => t.id === id);
		if (idx < 0) return;
		const [removed] = f.active.splice(idx, 1);
		f.archive.push({ ...removed!, updatedAt: new Date().toISOString() });
		// FIFO eviction once we exceed the cap.
		while (f.archive.length > ARCHIVE_MAX) {
			f.archive.shift();
		}
		await writeFile(store, f);
	});
}

/** Bump usageCount + lastUsedAt on an active quick-meal. No-op if not found. */
export async function incrementUsage(
	store: ScopedDataStore,
	id: string,
): Promise<void> {
	await lock.run(LOCK_KEY, async () => {
		const f = await readFile(store);
		const t = f.active.find((x) => x.id === id);
		if (!t) return;
		t.usageCount += 1;
		t.lastUsedAt = new Date().toISOString();
		await writeFile(store, f);
	});
}
