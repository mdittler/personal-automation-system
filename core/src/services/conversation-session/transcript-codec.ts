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

	// Everything after the closing '---\n'
	const body = raw.slice(fmMatch[0].length);
	const turns: SessionTurn[] = [];

	// Split on turn headers; each header is "### role — timestamp"
	const headerGlobalRe = new RegExp(
		`### (user|assistant) ${EM_DASH} (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)`,
		'gm',
	);

	let match: RegExpExecArray | null;
	const headers: Array<{ role: 'user' | 'assistant'; timestamp: string; startIdx: number }> = [];

	while ((match = headerGlobalRe.exec(body)) !== null) {
		headers.push({
			role: match[1]! as 'user' | 'assistant',
			timestamp: match[2]!,
			startIdx: match.index + match[0].length,
		});
	}

	for (let i = 0; i < headers.length; i++) {
		const h = headers[i]!;
		const next = headers[i + 1];
		const segEnd = next !== undefined ? body.lastIndexOf(`### ${next.role}`, next.startIdx - 1) : body.length;
		const segment = body.slice(h.startIdx, segEnd >= 0 ? segEnd : body.length);

		// Parse fenced block: find opening fence on first non-empty line
		const lines = segment.split('\n');
		// lines[0] is empty (immediately after header), lines[1] is the fence
		let fenceStart = -1;
		let fenceStr = '';
		for (let j = 0; j < lines.length; j++) {
			const trimmed = lines[j]!.trim();
			if (trimmed.match(/^`{4,}$/)) {
				fenceStart = j;
				fenceStr = trimmed;
				break;
			}
		}

		if (fenceStart === -1) {
			throw new CorruptTranscriptError(`Turn at ${h.timestamp} has no opening fence`);
		}

		// Find the closing fence — same fence string on its own line AFTER the opening
		let fenceEnd = -1;
		for (let j = fenceStart + 1; j < lines.length; j++) {
			if (lines[j]!.trim() === fenceStr) {
				fenceEnd = j;
				break;
			}
		}

		if (fenceEnd === -1) {
			throw new CorruptTranscriptError(`Turn at ${h.timestamp} has no closing fence`);
		}

		const content = lines.slice(fenceStart + 1, fenceEnd).join('\n');
		turns.push({ role: h.role, timestamp: h.timestamp, content });
	}

	return { meta, turns };
}
