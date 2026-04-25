/**
 * App / context / knowledge gathering helpers for the chatbot.
 *
 * Each helper takes its dependencies explicitly so it can be unit-tested
 * without a CoreServices closure.
 */

import type { AppKnowledgeBaseService } from '../../types/app-knowledge.js';
import type { AppInfo, AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { ContextStoreService } from '../../types/context-store.js';

/** Max context entries to include in system prompt. */
export const MAX_CONTEXT_ENTRIES = 3;

/** Max knowledge base entries to include in system prompt. */
export const MAX_KNOWLEDGE_ENTRIES = 5;

/** Get enabled app infos for a user (graceful on missing service). */
export async function getEnabledAppInfos(
	userId: string,
	deps: { appMetadata?: AppMetadataService; logger?: AppLogger },
): Promise<AppInfo[]> {
	try {
		if (!deps.appMetadata) return [];
		return await deps.appMetadata.getEnabledApps(userId);
	} catch (error) {
		deps.logger?.warn('Failed to get app metadata: %s', error);
		return [];
	}
}

/** Search knowledge base (graceful on missing service). */
export async function searchKnowledge(
	query: string,
	userId: string,
	deps: { appKnowledge?: AppKnowledgeBaseService; logger?: AppLogger },
): Promise<Array<{ source: string; content: string }>> {
	try {
		if (!deps.appKnowledge) return [];
		const entries = await deps.appKnowledge.search(query, userId);
		return entries.slice(0, MAX_KNOWLEDGE_ENTRIES);
	} catch (error) {
		deps.logger?.warn('Failed to search knowledge base: %s', error);
		return [];
	}
}

/** Format app metadata into a concise text summary. */
export function formatAppMetadata(apps: AppInfo[]): string {
	const lines: string[] = [];
	for (const app of apps) {
		lines.push(`${app.name} (${app.id}) — ${app.description}`);
		if (app.commands.length > 0) {
			for (const cmd of app.commands) {
				const argStr = cmd.args?.length ? ` ${cmd.args.map((a) => `<${a}>`).join(' ')}` : '';
				lines.push(`  ${cmd.name}${argStr} — ${cmd.description}`);
			}
		}
		if (app.intents.length > 0) {
			lines.push(`  Understands: ${app.intents.join(', ')}`);
		}
		if (app.acceptsPhotos) lines.push('  Accepts photos');
		if (app.hasSchedules) lines.push('  Has scheduled tasks');
	}
	return lines.join('\n');
}

/**
 * Gather all user context entries from the ContextStore.
 *
 * Context entries are small, user-curated preferences — include them all
 * so the LLM can decide relevance. Keyword search is too fragile for
 * natural-language queries (e.g., "what should I eat?" won't match "food").
 */
export async function gatherContext(
	_text: string,
	userId: string,
	deps: { contextStore?: ContextStoreService; logger?: AppLogger },
): Promise<string[]> {
	try {
		if (!deps.contextStore) return [];
		const entries = await deps.contextStore.listForUser(userId);
		return entries.slice(0, MAX_CONTEXT_ENTRIES).map((e) => e.content);
	} catch (error) {
		deps.logger?.warn('Failed to load context store: %s', error);
		return [];
	}
}
