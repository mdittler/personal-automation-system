/**
 * Model journal service interface.
 *
 * Provides each AI model with its own persistent file it can write to freely
 * during interactions. Not operational memory, not user-facing notes,
 * not a system log — just a file the model owns.
 *
 * Each model gets its own journal at data/model-journal/{model-slug}.md
 * with archives at data/model-journal-archive/{model-slug}/YYYY-MM.md.
 *
 * Entries are appended with timestamps. Monthly archival rotates old
 * entries to keep the active context bounded.
 */

export interface ModelJournalService {
	/** Read the current month's journal content for a model. Returns empty string if none. */
	read(modelSlug: string): Promise<string>;

	/** Append an entry with timestamp to a model's journal. Handles monthly archival. */
	append(modelSlug: string, content: string): Promise<void>;

	/** List archived journal files (YYYY-MM.md) for a model. Returns sorted filenames. */
	listArchives(modelSlug: string): Promise<string[]>;

	/** Read a specific archived journal file for a model. Returns empty string if not found. */
	readArchive(modelSlug: string, filename: string): Promise<string>;

	/** List model slugs that have journal files. Returns sorted slugs. */
	listModels(): Promise<string[]>;
}
