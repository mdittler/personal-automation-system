/**
 * App knowledge base service — read-only documentation search.
 *
 * Indexes help files from app directories (help.md, docs/*.md) and
 * infrastructure docs from core/docs/help/. Apps declare 'app-knowledge'
 * in requirements.services to receive this.
 */

/** A single knowledge base entry from an app or infrastructure doc. */
export interface KnowledgeEntry {
	/** App ID, or 'infrastructure' for PAS core docs. */
	appId: string;
	/** Source filename (e.g., 'help.md', 'scheduling.md'). */
	source: string;
	/** Document content (may be truncated). */
	content: string;
}

/** Read-only knowledge base of app and infrastructure documentation. */
export interface AppKnowledgeBaseService {
	/**
	 * Search for knowledge entries matching the query.
	 * When userId is provided, only returns entries from enabled apps.
	 * Infrastructure docs are always included.
	 */
	search(query: string, userId?: string): Promise<KnowledgeEntry[]>;
}
