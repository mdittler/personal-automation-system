/**
 * Obsidian-compatible YAML frontmatter utilities.
 *
 * Generates, parses, and detects YAML frontmatter blocks for markdown files.
 * All generated .md files in PAS include frontmatter for Obsidian vault compatibility.
 */

export interface FrontmatterMeta {
	title?: string;
	date?: string;
	created?: string;
	tags?: string[];
	type?: 'daily-note' | 'report' | 'alert' | 'journal' | 'diff' | 'log';
	app?: string;
	user?: string;
	source?: string;
	aliases?: string[];
	related?: string[];
	[key: string]: unknown;
}

/** Characters that require quoting in YAML scalar values. */
const NEEDS_QUOTING = /[:#{}[\],&*?|>!%@`'"\\]|^(true|false|null|yes|no)$/i;

/**
 * Generate a YAML frontmatter block from metadata.
 * Omits undefined/null fields. Handles arrays as YAML lists.
 * Returns the block including delimiters and trailing newline.
 */
export function generateFrontmatter(meta: FrontmatterMeta): string {
	const lines: string[] = ['---'];

	for (const [key, value] of Object.entries(meta)) {
		if (value === undefined || value === null) continue;

		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${quoteIfNeeded(String(item))}`);
			}
		} else {
			lines.push(`${key}: ${quoteIfNeeded(String(value))}`);
		}
	}

	lines.push('---');
	return `${lines.join('\n')}\n`;
}

/**
 * Parse frontmatter from raw markdown content.
 * Returns the parsed metadata object and the body content (after frontmatter).
 * If no frontmatter is present, returns empty meta and the full content.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } {
	if (!hasFrontmatter(raw)) {
		return { meta: {}, content: raw };
	}

	// Handle both \n and \r\n line endings for the opening delimiter
	const openLen = raw.startsWith('---\r\n') ? 5 : 4;
	const endIndex = raw.indexOf('\n---', openLen - 1);
	if (endIndex === -1) {
		return { meta: {}, content: raw };
	}

	const frontmatterBlock = raw.slice(openLen, endIndex); // Skip opening "---\n" or "---\r\n"
	const content = raw.slice(endIndex + 4); // Skip closing "\n---"

	// Strip leading newline(s) from content if present (handles \n and \r\n)
	const body = content.startsWith('\r\n')
		? content.slice(2)
		: content.startsWith('\n')
			? content.slice(1)
			: content;

	const meta: Record<string, unknown> = {};
	let currentKey = '';
	let currentArray: string[] | null = null;

	for (const rawLine of frontmatterBlock.split('\n')) {
		const line = rawLine.replace(/\r$/, ''); // Handle \r\n line endings
		const arrayMatch = line.match(/^\s{2}- (.+)$/);
		if (arrayMatch?.[1] && currentKey) {
			if (!currentArray) {
				currentArray = [];
			}
			currentArray.push(unquote(arrayMatch[1].trim()));
			meta[currentKey] = currentArray;
			continue;
		}

		// Flush any pending array
		if (currentArray) {
			currentArray = null;
		}

		const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/);
		if (kvMatch?.[1] && kvMatch[2] !== undefined) {
			currentKey = kvMatch[1];
			const rawValue = kvMatch[2].trim();
			if (rawValue === '') {
				// Could be start of an array — wait for next lines
				meta[currentKey] = undefined;
			} else {
				meta[currentKey] = unquote(rawValue);
			}
		}
	}

	return { meta, content: body };
}

/**
 * Quick check if content starts with YAML frontmatter delimiters.
 */
export function hasFrontmatter(content: string): boolean {
	return content.startsWith('---\n') || content.startsWith('---\r\n');
}

/**
 * Strip frontmatter from content, returning only the body.
 * Convenience wrapper around parseFrontmatter().
 */
export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).content;
}

/** Quote a YAML value if it contains special characters. */
function quoteIfNeeded(value: string): string {
	if (value === '') return '""';
	if (NEEDS_QUOTING.test(value)) {
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return value;
}

/** Remove quotes from a YAML value. */
function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	return value;
}

/**
 * Extract wiki-links from markdown content.
 * Handles both `[[target]]` and `[[target|display text]]` formats.
 * Returns an array of unique link targets (without display text).
 */
export function extractWikiLinks(content: string): string[] {
	const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
	const links = new Set<string>();
	for (let match = regex.exec(content); match !== null; match = regex.exec(content)) {
		const target = match[1]?.trim();
		if (target) links.add(target);
	}
	return [...links];
}

/**
 * Build standardized tags for an app's data files.
 * Always includes `pas/<appId>` and `pas/<type>`. Extra tags are appended as-is.
 *
 * @example
 * buildAppTags('food-tracker', 'recipe', ['ingredient/chicken', 'meal/dinner'])
 * // => ['pas/recipe', 'pas/food-tracker', 'ingredient/chicken', 'meal/dinner']
 */
export function buildAppTags(appId: string, type: string, extras?: string[]): string[] {
	const tags: string[] = [`pas/${type}`, `pas/${appId}`];
	if (extras) {
		for (const tag of extras) {
			if (tag && !tags.includes(tag)) {
				tags.push(tag);
			}
		}
	}
	return tags;
}
