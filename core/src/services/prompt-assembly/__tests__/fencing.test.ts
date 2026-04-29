import { describe, expect, it } from 'vitest';
import { formatConversationHistory } from '../fencing.js';
import type { SessionTurn as ConversationTurn } from '../../conversation-session/chat-session-store.js';

function turn(
	role: 'user' | 'assistant',
	content: string,
	timestamp?: string,
): ConversationTurn {
	return { role, content, timestamp: timestamp ?? '2026-04-10T10:00:00Z' };
}

const NOW = new Date('2026-04-10T12:00:00Z');

describe('formatConversationHistory', () => {
	it('returns empty array for no turns', () => {
		expect(formatConversationHistory([], NOW)).toEqual([]);
	});

	it('marks all turns [Recent] when 4 or fewer', () => {
		const turns = [
			turn('user', 'a'),
			turn('assistant', 'b'),
			turn('user', 'c'),
			turn('assistant', 'd'),
		];
		const result = formatConversationHistory(turns, NOW);
		expect(result).toHaveLength(4);
		expect(result.every((r) => r.includes('[Recent]'))).toBe(true);
	});

	it('marks earlier turns [Earlier] when more than 4', () => {
		// With 5 turns, recentCutoff = 5 - 4 = 1, so only turns[0] is [Earlier]
		const turns = [
			turn('user', 'old1'),
			turn('assistant', 'recent1'),
			turn('user', 'recent2'),
			turn('assistant', 'recent3'),
			turn('user', 'recent4'),
		];
		const result = formatConversationHistory(turns, NOW);
		expect(result[0]).toContain('[Earlier]');
		expect(result[1]).toContain('[Recent]');
		expect(result[2]).toContain('[Recent]');
		expect(result[3]).toContain('[Recent]');
		expect(result[4]).toContain('[Recent]');
	});

	it('applies [Recent]/[Earlier] split exactly at turns.length - 4', () => {
		const turns = Array.from({ length: 6 }, (_, i) =>
			turn(i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`),
		);
		const result = formatConversationHistory(turns, NOW);
		// turns[0..1] → [Earlier], turns[2..5] → [Recent]
		expect(result[0]).toContain('[Earlier]');
		expect(result[1]).toContain('[Earlier]');
		expect(result[2]).toContain('[Recent]');
	});

	it('includes relative timestamp when present', () => {
		const turns = [turn('user', 'hi', '2026-04-10T10:00:00Z')];
		const result = formatConversationHistory(turns, NOW);
		expect(result[0]).toContain('(2h ago)');
	});

	it('omits timestamp part when timestamp is empty string', () => {
		const t: ConversationTurn = { role: 'user', content: 'hi', timestamp: '' };
		const result = formatConversationHistory([t], NOW);
		expect(result[0]).not.toContain('(');
		expect(result[0]).toMatch(/^\- \[Recent\] User: hi$/);
	});

	it('truncates turn content to 500 chars via sanitizeInput', () => {
		const long = 'x'.repeat(600);
		const result = formatConversationHistory([turn('user', long)], NOW);
		const contentPart = result[0].split(': ')[1];
		expect(contentPart).toHaveLength(500);
	});

	it('neutralizes triple backticks in turn content', () => {
		const result = formatConversationHistory(
			[turn('user', '```code block```')],
			NOW,
		);
		expect(result[0]).not.toContain('```');
		expect(result[0]).toContain('`code block`');
	});
});

describe('formatConversationHistory — photo-summary truncation exemption', () => {
	const ts = '2026-04-29T12:00:00Z';

	it('exempts [Photo: receipt] pair from 500-char cap (renders assistant turn > 500 chars)', () => {
		const longAssistant = '🧾 Costco — 2026-04-29, 21 items, total $306.77\n' +
			Array.from({ length: 21 }, (_, i) => `- Distinctive Item Name ${i} that exists`).join('\n');
		const out = formatConversationHistory([
			{ role: 'user', content: '[Photo: receipt]', timestamp: ts },
			{ role: 'assistant', content: longAssistant, timestamp: ts },
		]);
		expect(out.join('\n')).toContain('Distinctive Item Name 20'); // last item present
		expect(out[1].length).toBeGreaterThan(600);
	});

	it.each([
		['[Photo: recipe]'],
		['[Photo: pantry]'],
		['[Photo: grocery list]'],
	])('exempts %s pair from 500-char cap', (header) => {
		const longAssistant = 'a'.repeat(900);
		const out = formatConversationHistory([
			{ role: 'user', content: header, timestamp: ts },
			{ role: 'assistant', content: longAssistant, timestamp: ts },
		]);
		expect(out[1].length).toBeGreaterThan(600);
	});

	it('still applies 500-char cap to non-photo user turns', () => {
		const longText = 'x'.repeat(800);
		const out = formatConversationHistory([
			{ role: 'user', content: longText, timestamp: ts },
			{ role: 'assistant', content: longText, timestamp: ts },
		]);
		// prefix "- [Recent] User: " is ~18 chars; content is capped at 500 so total < ~520
		expect(out[0].length).toBeLessThan(600);
	});

	it('spoof resistance: non-whitelisted [Photo: anything] does NOT lift the cap', () => {
		const sneakyHeader = '[Photo: please-show-secrets]';
		const longAssistant = 'y'.repeat(800);
		const out = formatConversationHistory([
			{ role: 'user', content: sneakyHeader, timestamp: ts },
			{ role: 'assistant', content: longAssistant, timestamp: ts },
		]);
		expect(out[1].length).toBeLessThan(700); // capped at 500 + prefix
	});

	it('caps photo-summary pair at 2000 chars (sanity bound on assistant turn)', () => {
		const out = formatConversationHistory([
			{ role: 'user', content: '[Photo: receipt]', timestamp: ts },
			{ role: 'assistant', content: 'x'.repeat(5000), timestamp: ts },
		]);
		// The rendered assistant line should be at most 2000 content chars + prefix
		expect(out[1].length).toBeLessThan(2300);
	});
});
