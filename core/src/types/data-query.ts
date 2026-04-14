/**
 * Public types for the DataQueryService.
 *
 * These types are in core/src/types/ so that apps and tests can import them
 * without depending on internal service implementation paths.
 */

/** A single file retrieved by a DataQueryService query, with frontmatter stripped. */
export interface DataQueryFile {
	/** Data-root-relative path (e.g., "users/matt/food/recipes/tacos.yaml") */
	path: string;
	/** App that owns this file */
	appId: string;
	/** From frontmatter type field */
	type: string | null;
	/** From frontmatter title or first heading */
	title: string | null;
	/** File content with frontmatter stripped and truncated for prompt injection */
	content: string;
}

/** Result returned by DataQueryService.query(). */
export interface DataQueryResult {
	/** Files whose content is relevant to the query. */
	files: DataQueryFile[];
	/** True when no relevant files were found (empty files array). */
	empty: boolean;
}

/**
 * Service interface for natural-language data queries over indexed files.
 *
 * Exposed to apps via CoreServices.dataQuery (optional — only injected when
 * the app declares "data-query" in manifest requirements.services).
 *
 * D2b: scope-filtered, LLM-selected, content-returned file queries.
 * D2c (future): contextual follow-up support via InteractionContextService.
 */
export interface DataQueryService {
	/**
	 * Query the user's accessible data files using natural language.
	 *
	 * Scope enforcement:
	 * - User-scoped files: only visible to their owner
	 * - Shared files: visible to all in single-household mode (no spaces exist
	 *   OR calling user belongs to no space)
	 * - Space-scoped files: only visible to space members
	 *
	 * @param question - Natural language question to answer
	 * @param userId - ID of the querying user (for scope enforcement)
	 * @returns Relevant file contents, or { files: [], empty: true } if none found
	 */
	query(question: string, userId: string): Promise<DataQueryResult>;
}
