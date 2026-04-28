import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { CorruptTranscriptError } from './errors.js';
import type { ChatSessionFrontmatter, SessionTurn } from './chat-session-store.js';

// The em-dash (U+2014) is the mandatory delimiter; ASCII hyphen-minus is not recognized.
const EM_DASH = '—';

// Header pattern: ### role — ISO8601_UTC
const HEADER_RE = new RegExp(
	`^### (user|assistant) ${EM_DASH} (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)$`,
	'm',
);

function pickFenceLength(content: string): number {
	let max = 3;
	const runs = content.match(/`+/g) ?? [];
	for (const run of runs) {
		if (run.length > max) max = run.length;
	}
	return max + 1;
}

function makeFence(n: number): string {
	return '`'.repeat(n);
}

export function encodeNew(meta: ChatSessionFrontmatter): string {
	const frontmatter = stringifyYaml(meta, { lineWidth: 0 });
	return `---\n${frontmatter}---\n`;
}

export function encodeAppend(existingRaw: string, turn: SessionTurn): string {
	const fenceLen = pickFenceLength(turn.content);
	const fence = makeFence(fenceLen);
	return `${existingRaw}\n### ${turn.role} ${EM_DASH} ${turn.timestamp}\n${fence}\n${turn.content}\n${fence}\n`;
}

export function decode(raw: string): { meta: ChatSessionFrontmatter; turns: SessionTurn[] } {
	// Extract frontmatter between the first two '---' delimiters
	const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!fmMatch) {
		throw new CorruptTranscriptError('Missing or malformed YAML frontmatter');
	}

	let meta: ChatSessionFrontmatter;
	try {
		const parsed = parseYaml(fmMatch[1]!);
		if (!parsed || typeof parsed !== 'object') {
			throw new Error('parsed to non-object');
		}
		meta = parsed as ChatSessionFrontmatter;
	} catch (e) {
		throw new CorruptTranscriptError(`Failed to parse frontmatter: ${String(e)}`);
	}

	// Parse turns sequentially: find header → find opening fence → consume until closing fence.
	// Content inside fences is never scanned for headers, so transcript-looking lines in
	// user/assistant messages cannot corrupt the parse.
	const body = raw.slice(fmMatch[0].length);
	const lines = body.split('\n');
	const turns: SessionTurn[] = [];

	const headerRe = new RegExp(
		`^### (user|assistant) ${EM_DASH} (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)$`,
	);
	const fenceRe = /^`{4,}$/;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const headerMatch = line.match(headerRe);
		if (!headerMatch) {
			i++;
			continue;
		}

		const role = headerMatch[1]! as 'user' | 'assistant';
		const timestamp = headerMatch[2]!;
		i++;

		// Find opening fence: first non-empty line after the header must be a fence.
		let fenceStr = '';
		while (i < lines.length) {
			const l = lines[i]!.trim();
			if (l === '') {
				i++;
				continue;
			}
			if (fenceRe.test(l)) {
				fenceStr = l;
				i++;
				break;
			}
			throw new CorruptTranscriptError(`Turn at ${timestamp} has no opening fence`);
		}
		if (!fenceStr) {
			throw new CorruptTranscriptError(`Turn at ${timestamp} has no opening fence`);
		}

		// Collect content lines until the matching closing fence.
		// Lines are treated as opaque — no header scanning inside the fence.
		const contentLines: string[] = [];
		let foundClosing = false;
		while (i < lines.length) {
			const l = lines[i]!;
			i++;
			if (l.trim() === fenceStr) {
				foundClosing = true;
				break;
			}
			contentLines.push(l);
		}
		if (!foundClosing) {
			throw new CorruptTranscriptError(`Turn at ${timestamp} has no closing fence`);
		}

		turns.push({ role, timestamp, content: contentLines.join('\n') });
	}

	return { meta, turns };
}
