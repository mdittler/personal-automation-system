import { describe, expect, it } from 'vitest';
import type { EditProposal } from '../../edit/index.js';
import { pendingEdits as pendingEditsAgain } from '../index.js';
import { pendingEdits } from '../pending-edits.js';

function makeProposal(id: string): EditProposal {
	return {
		kind: 'proposal',
		proposalId: id,
		filePath: 'users/u/app/file.md',
		absolutePath: '/data/users/u/app/file.md',
		appId: 'app',
		userId: 'u',
		description: 'desc',
		scope: 'user',
		beforeContent: 'a',
		afterContent: 'b',
		beforeHash: 'h',
		diff: 'd',
		expiresAt: new Date(Date.now() + 5 * 60 * 1000),
	};
}

describe('pendingEdits', () => {
	it('is the same Map instance for both direct import and barrel export', () => {
		expect(pendingEdits).toBe(pendingEditsAgain);
	});

	it('supports set/get/delete operations', () => {
		const userId = 'pending-edits-test-user-1';
		pendingEdits.delete(userId);
		const proposal = makeProposal('p1');
		pendingEdits.set(userId, proposal);
		expect(pendingEdits.get(userId)?.proposalId).toBe('p1');
		pendingEdits.delete(userId);
		expect(pendingEdits.has(userId)).toBe(false);
	});

	it('replacing a slot loses the old proposal (one slot per user)', () => {
		const userId = 'pending-edits-test-user-2';
		pendingEdits.set(userId, makeProposal('first'));
		pendingEdits.set(userId, makeProposal('second'));
		expect(pendingEdits.get(userId)?.proposalId).toBe('second');
		pendingEdits.delete(userId);
	});
});
