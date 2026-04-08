import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VerificationLogger } from '../verification-logger.js';
import type { VerificationLogEntry } from '../verification-logger.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const baseEntry: VerificationLogEntry = {
	timestamp: new Date('2026-04-08T14:32:05.000Z'),
	userId: '12345',
	messageText: 'I want to add chicken to the list',
	messageType: 'text',
	classifierAppId: 'food',
	classifierConfidence: 0.55,
	classifierIntent: 'user wants to add items to the grocery list',
	verifierAgrees: true,
	outcome: 'auto',
	routedTo: 'food',
};

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), 'verification-logger-test-'));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('VerificationLogger', () => {
	it('creates log file with YAML frontmatter on first write', async () => {
		const logger = new VerificationLogger(tmpDir);
		await logger.log(baseEntry);

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		expect(content).toContain('---');
		expect(content).toContain('title: Route Verification Log');
		expect(content).toContain('type: system-log');
		expect(content).toContain('tags: [pas/route-verification]');
	});

	it('appends a formatted entry after the frontmatter', async () => {
		const logger = new VerificationLogger(tmpDir);
		await logger.log(baseEntry);

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		expect(content).toContain('## 2026-04-08');
		expect(content).toContain('**Message**: "I want to add chicken to the list"');
		expect(content).toContain('**Type**: text');
		expect(content).toContain('**User**: 12345');
		expect(content).toContain('**Classifier**: food (confidence: 0.55, intent: "user wants to add items to the grocery list")');
		expect(content).toContain('**Verifier**: food (agrees)');
		expect(content).toContain('**Outcome**: routed to food (auto)');
	});

	it('appends multiple entries to the same file', async () => {
		const logger = new VerificationLogger(tmpDir);
		await logger.log(baseEntry);
		await logger.log({ ...baseEntry, messageText: 'Second message' });

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		// Frontmatter should appear only once
		const frontmatterMatches = content.match(/---/g);
		expect(frontmatterMatches?.length).toBe(2); // opening and closing ---

		expect(content).toContain('"I want to add chicken to the list"');
		expect(content).toContain('"Second message"');
	});

	it('includes photo path for photo messages', async () => {
		const logger = new VerificationLogger(tmpDir);
		const photoEntry: VerificationLogEntry = {
			...baseEntry,
			messageType: 'photo',
			photoPath: 'data/users/12345/food/photos/chicken.jpg',
		};
		await logger.log(photoEntry);

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		expect(content).toContain('**Type**: photo');
		expect(content).toContain('**Photo**: [chicken.jpg](data/users/12345/food/photos/chicken.jpg)');
	});

	it('handles missing directory by creating it', async () => {
		const nestedDir = join(tmpDir, 'nested', 'subdir');
		const logger = new VerificationLogger(nestedDir);
		await logger.log(baseEntry);

		const content = await readFile(join(nestedDir, 'route-verification-log.md'), 'utf-8');
		expect(content).toContain('title: Route Verification Log');
	});

	it('includes verifier suggestion and user choice for disagreements', async () => {
		const logger = new VerificationLogger(tmpDir);
		const disagreementEntry: VerificationLogEntry = {
			...baseEntry,
			verifierAgrees: false,
			verifierSuggestedAppId: 'notes',
			verifierSuggestedIntent: 'user wants to write a note',
			userChoice: 'notes',
			outcome: 'user override',
			routedTo: 'notes',
		};
		await logger.log(disagreementEntry);

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		expect(content).toContain('**Verifier**: notes (disagrees');
		expect(content).toContain('**User choice**: notes');
		expect(content).toContain('**Outcome**: routed to notes (user override)');
	});

	it('truncates message text to 200 chars', async () => {
		const logger = new VerificationLogger(tmpDir);
		const longText = 'a'.repeat(250);
		await logger.log({ ...baseEntry, messageText: longText });

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		// The logged text should be max 200 chars
		expect(content).toContain('"' + 'a'.repeat(200) + '"');
		expect(content).not.toContain('"' + 'a'.repeat(201));
	});

	it('formats timestamp as YYYY-MM-DD HH:MM:SS', async () => {
		const logger = new VerificationLogger(tmpDir);
		// Use a timestamp that is unambiguous in UTC (we format from ISO string)
		const entry = { ...baseEntry, timestamp: new Date('2026-04-08T14:32:05.123Z') };
		await logger.log(entry);

		const content = await readFile(join(tmpDir, 'route-verification-log.md'), 'utf-8');
		// Should have no milliseconds, T replaced with space
		expect(content).toMatch(/## 2026-04-08 14:32:05/);
	});
});
