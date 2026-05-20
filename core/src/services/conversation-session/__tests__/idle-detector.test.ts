import { describe, expect, it } from 'vitest';
import type { ChatSessionFrontmatter } from '../chat-session-store.js';
import { getLastActivityIso, isIdle } from '../idle-detector.js';

describe('idle-detector', () => {
	const baseMeta: ChatSessionFrontmatter = {
		id: '20260501_120000_aabbccdd',
		source: 'telegram',
		user_id: 'u1',
		household_id: null,
		model: null,
		title: null,
		parent_session_id: null,
		started_at: '2026-05-01T12:00:00.000Z',
		ended_at: null,
		token_counts: { input: 0, output: 0 },
	};

	describe('getLastActivityIso', () => {
		it('returns last_activity_at when present', () => {
			const meta = { ...baseMeta, last_activity_at: '2026-05-01T14:00:00.000Z' };
			expect(getLastActivityIso(meta)).toBe('2026-05-01T14:00:00.000Z');
		});
		it('falls back to started_at when last_activity_at is absent (legacy transcripts)', () => {
			expect(getLastActivityIso(baseMeta)).toBe('2026-05-01T12:00:00.000Z');
		});
	});

	describe('isIdle', () => {
		it('returns true when elapsed > idleMinutes', () => {
			expect(isIdle('2026-05-01T12:00:00Z', new Date('2026-05-01T14:01:00Z'), 120)).toBe(true);
		});
		it('returns false when elapsed === idleMinutes (exclusive boundary)', () => {
			expect(isIdle('2026-05-01T12:00:00Z', new Date('2026-05-01T14:00:00Z'), 120)).toBe(false);
		});
		it('returns false when elapsed < idleMinutes', () => {
			expect(isIdle('2026-05-01T12:00:00Z', new Date('2026-05-01T13:59:00Z'), 120)).toBe(false);
		});
		it('returns false for zero idleMinutes (disabled signal)', () => {
			expect(isIdle('2026-05-01T12:00:00Z', new Date('2026-05-02T00:00:00Z'), 0)).toBe(false);
		});
		it('returns false for negative idleMinutes', () => {
			expect(isIdle('2026-05-01T12:00:00Z', new Date('2026-05-02T00:00:00Z'), -1)).toBe(false);
		});
		it('returns false on unparseable lastActivityIso (defensive)', () => {
			expect(isIdle('not-a-date', new Date(), 60)).toBe(false);
		});
		it('returns true for 1ms past threshold', () => {
			expect(isIdle('2026-05-01T12:00:00.000Z', new Date('2026-05-01T14:00:00.001Z'), 120)).toBe(
				true,
			);
		});
	});
});
