import { describe, expect, it, vi } from 'vitest';
import { ConversationHistory, type ConversationTurn } from '../conversation-history.js';

function createMockStore(data: string | null = null) {
	return {
		read: vi.fn().mockResolvedValue(data ?? ''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

function turn(role: 'user' | 'assistant', content: string): ConversationTurn {
	return { role, content, timestamp: '2026-03-11T10:00:00.000Z' };
}

describe('ConversationHistory', () => {
	describe('load', () => {
		it('returns empty array when store has no data', async () => {
			const store = createMockStore('');
			const history = new ConversationHistory();
			expect(await history.load(store)).toEqual([]);
		});

		it('returns parsed turns from valid JSON', async () => {
			const turns = [turn('user', 'hello'), turn('assistant', 'hi')];
			const store = createMockStore(JSON.stringify(turns));
			const history = new ConversationHistory();
			expect(await history.load(store)).toEqual(turns);
		});

		it('truncates to maxTurns on load', async () => {
			const turns = Array.from({ length: 30 }, (_, i) => turn('user', `msg ${i}`));
			const store = createMockStore(JSON.stringify(turns));
			const history = new ConversationHistory({ maxTurns: 10 });
			const result = await history.load(store);
			expect(result).toHaveLength(10);
			expect(result[0].content).toBe('msg 20');
			expect(result[9].content).toBe('msg 29');
		});

		it('reads from history.json', async () => {
			const store = createMockStore('');
			const history = new ConversationHistory();
			await history.load(store);
			expect(store.read).toHaveBeenCalledWith('history.json');
		});

		it('returns empty array for malformed JSON', async () => {
			const store = createMockStore('{not valid json');
			const history = new ConversationHistory();
			expect(await history.load(store)).toEqual([]);
		});

		it('returns empty array when JSON is not an array', async () => {
			const store = createMockStore('{"key": "value"}');
			const history = new ConversationHistory();
			expect(await history.load(store)).toEqual([]);
		});

		it('returns empty array when JSON is a string', async () => {
			const store = createMockStore('"just a string"');
			const history = new ConversationHistory();
			expect(await history.load(store)).toEqual([]);
		});

		it('clamps maxTurns of 0 to 1', async () => {
			const turns = [turn('user', 'a'), turn('assistant', 'b'), turn('user', 'c')];
			const store = createMockStore(JSON.stringify(turns));
			const history = new ConversationHistory({ maxTurns: 0 });
			const result = await history.load(store);
			expect(result).toHaveLength(1);
			expect(result[0].content).toBe('c');
		});

		it('clamps negative maxTurns to 1', async () => {
			const turns = [turn('user', 'a'), turn('assistant', 'b')];
			const store = createMockStore(JSON.stringify(turns));
			const history = new ConversationHistory({ maxTurns: -5 });
			const result = await history.load(store);
			expect(result).toHaveLength(1);
			expect(result[0].content).toBe('b');
		});

		it('handles maxTurns of 1', async () => {
			const turns = [turn('user', 'a'), turn('assistant', 'b'), turn('user', 'c')];
			const store = createMockStore(JSON.stringify(turns));
			const history = new ConversationHistory({ maxTurns: 1 });
			const result = await history.load(store);
			expect(result).toHaveLength(1);
			expect(result[0].content).toBe('c');
		});
	});

	describe('append', () => {
		it('saves user and assistant turns', async () => {
			const store = createMockStore('[]');
			const history = new ConversationHistory();
			await history.append(store, turn('user', 'hello'), turn('assistant', 'hi'));

			expect(store.write).toHaveBeenCalledWith('history.json', expect.stringContaining('"hello"'));
			const written = JSON.parse(store.write.mock.calls[0][1]);
			expect(written).toHaveLength(2);
			expect(written[0].role).toBe('user');
			expect(written[1].role).toBe('assistant');
		});

		it('appends to existing history', async () => {
			const existing = [turn('user', 'old'), turn('assistant', 'old reply')];
			const store = createMockStore(JSON.stringify(existing));
			const history = new ConversationHistory();
			await history.append(store, turn('user', 'new'), turn('assistant', 'new reply'));

			const written = JSON.parse(store.write.mock.calls[0][1]);
			expect(written).toHaveLength(4);
			expect(written[2].content).toBe('new');
			expect(written[3].content).toBe('new reply');
		});

		it('truncates to maxTurns when exceeding limit', async () => {
			const existing = Array.from({ length: 8 }, (_, i) => turn('user', `msg ${i}`));
			const store = createMockStore(JSON.stringify(existing));
			const history = new ConversationHistory({ maxTurns: 6 });
			await history.append(store, turn('user', 'new1'), turn('assistant', 'new2'));

			const written = JSON.parse(store.write.mock.calls[0][1]);
			expect(written).toHaveLength(6);
			// Should keep the most recent 6
			expect(written[0].content).toBe('msg 4');
			expect(written[5].content).toBe('new2');
		});

		it('works with empty store (first conversation)', async () => {
			const store = createMockStore('');
			const history = new ConversationHistory();
			await history.append(store, turn('user', 'first'), turn('assistant', 'hello!'));

			const written = JSON.parse(store.write.mock.calls[0][1]);
			expect(written).toHaveLength(2);
		});

		it('works with malformed existing data', async () => {
			const store = createMockStore('not json');
			const history = new ConversationHistory();
			await history.append(store, turn('user', 'hello'), turn('assistant', 'hi'));

			const written = JSON.parse(store.write.mock.calls[0][1]);
			expect(written).toHaveLength(2);
		});

		it('uses atomic write via store.write', async () => {
			const store = createMockStore('[]');
			const history = new ConversationHistory();
			await history.append(store, turn('user', 'a'), turn('assistant', 'b'));

			expect(store.write).toHaveBeenCalledTimes(1);
			expect(store.write).toHaveBeenCalledWith('history.json', expect.any(String));
		});

		// -- Concurrency (D23 fix) --

		it('serializes concurrent appends so both are preserved', async () => {
			// Simulate slow writes to expose the race window
			let storedData = '[]';
			const store = createMockStore('[]');
			store.read.mockImplementation(() => Promise.resolve(storedData));
			store.write.mockImplementation((_file: string, data: string) => {
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						storedData = data;
						resolve();
					}, 10);
				});
			});

			const history = new ConversationHistory();

			// Fire two appends concurrently — without serialization, second overwrites first
			const p1 = history.append(store, turn('user', 'msg1'), turn('assistant', 'reply1'));
			const p2 = history.append(store, turn('user', 'msg2'), turn('assistant', 'reply2'));
			await Promise.all([p1, p2]);

			const final = JSON.parse(storedData);
			expect(final).toHaveLength(4);
			expect(final[0].content).toBe('msg1');
			expect(final[2].content).toBe('msg2');
		});

		it('does not stall queue when an append fails', async () => {
			const store = createMockStore('[]');
			store.write.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);

			const history = new ConversationHistory();

			// First append fails
			await expect(
				history.append(store, turn('user', 'fail'), turn('assistant', 'fail')),
			).rejects.toThrow('disk full');

			// Second append should still work (queue not stalled)
			await history.append(store, turn('user', 'ok'), turn('assistant', 'ok'));
			expect(store.write).toHaveBeenCalledTimes(2);
		});
	});
});
