/**
 * Receipt-fixture shape tests (REQ-REG-006 spirit at the fixture-shape level).
 *
 * Validates that every fixture in `regression/fixtures/receipts/`:
 *   1. The photo file exists.
 *   2. Its SHA-256 matches the recorded hash in the `.sha256` companion
 *      (parses the first whitespace-delimited token, so basename vs
 *      relative path doesn't matter).
 *   3. The `.expected.json` sidecar parses cleanly and has the required
 *      shape for either happy-path (with totalPrice / lineItems) or
 *      rejection mode (with rejectedDate).
 *   4. All 5 receipt cases load via `loadCases`, IDs are unique, and every
 *      `coverage[]` path resolves to a real file (mirrors
 *      cases.contract.test.ts:35-48).
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCases } from '../runner/case-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const FIXTURES_DIR = resolve(REPO_ROOT, 'regression/fixtures/receipts');
const CASES_DIR = resolve(REPO_ROOT, 'regression/src/cases');

const FIXTURES = [
	{ name: 'costco-long', rejection: false },
	{ name: 'trader-joes-correction', rejection: false },
	{ name: 'trader-joes-long', rejection: false },
	{ name: 'trader-joes-short', rejection: false },
	{ name: 'expired-90d', rejection: true },
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe('receipt fixtures — per-fixture shape', () => {
	for (const { name, rejection } of FIXTURES) {
		describe(name, () => {
			it('photo file exists', async () => {
				const photoPath = resolve(FIXTURES_DIR, `${name}.jpg`);
				const s = await stat(photoPath);
				expect(s.isFile()).toBe(true);
			});

			it('photo SHA-256 matches the recorded .sha256 manifest', async () => {
				const photoPath = resolve(FIXTURES_DIR, `${name}.jpg`);
				const sidecarPath = resolve(FIXTURES_DIR, `${name}.sha256`);
				const photoBytes = await readFile(photoPath);
				const manifestText = await readFile(sidecarPath, 'utf8');
				// Parse only the first whitespace-delimited token (the hash);
				// ignore the path portion so basename-vs-relative-path differences don't matter.
				const recordedHash = manifestText.trim().split(/\s+/)[0];
				expect(recordedHash).toBeDefined();
				expect(recordedHash).toMatch(/^[0-9a-f]{64}$/);
				const actualHash = createHash('sha256').update(photoBytes).digest('hex');
				expect(actualHash).toBe(recordedHash);
			});

			it('sidecar JSON parses cleanly', async () => {
				const sidecarPath = resolve(FIXTURES_DIR, `${name}.expected.json`);
				const text = await readFile(sidecarPath, 'utf8');
				expect(() => JSON.parse(text)).not.toThrow();
			});

			if (rejection) {
				it('rejection sidecar has store + rejectedDate (ISO YYYY-MM-DD)', async () => {
					const sidecarPath = resolve(FIXTURES_DIR, `${name}.expected.json`);
					const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
					expect(sidecar.expectRejection).toBe(true);
					expect(typeof sidecar.store).toBe('string');
					expect(sidecar.store.length).toBeGreaterThan(0);
					// Rejection sidecars require rejectedDate so the runner can
					// assert rawExtractedDate preservation.
					expect(typeof sidecar.rejectedDate).toBe('string');
					expect(sidecar.rejectedDate).toMatch(ISO_DATE_RE);
				});
			} else {
				it('happy-path sidecar has total + non-empty lineItems with well-formed entries', async () => {
					const sidecarPath = resolve(FIXTURES_DIR, `${name}.expected.json`);
					const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'));
					expect(typeof sidecar.total).toBe('number');
					expect(Number.isFinite(sidecar.total)).toBe(true);
					expect(Array.isArray(sidecar.lineItems)).toBe(true);
					expect(sidecar.lineItems.length).toBeGreaterThan(0);
					for (const li of sidecar.lineItems) {
						expect(typeof li.name).toBe('string');
						expect(li.name.length).toBeGreaterThan(0);
						expect(typeof li.totalPrice).toBe('number');
						expect(Number.isFinite(li.totalPrice)).toBe(true);
						// Optional quantity / unitPrice — validate shape only when present.
						if (li.quantity !== undefined) {
							expect(typeof li.quantity).toBe('number');
							expect(Number.isFinite(li.quantity)).toBe(true);
							expect(li.quantity).toBeGreaterThan(0);
						}
						if (li.unitPrice !== undefined && li.unitPrice !== null) {
							expect(typeof li.unitPrice).toBe('number');
							expect(Number.isFinite(li.unitPrice)).toBe(true);
						}
					}
				});
			}
		});
	}
});

describe('receipt fixtures — global', () => {
	it('exactly 5 receipt cases load via loadCases', async () => {
		const loaded = await loadCases(CASES_DIR);
		const receiptCases = loaded.filter((lc) => lc.case.bucket === 'receipt');
		expect(receiptCases).toHaveLength(FIXTURES.length);
	});

	it('all receipt case IDs are unique', async () => {
		const loaded = await loadCases(CASES_DIR);
		const ids = loaded.filter((lc) => lc.case.bucket === 'receipt').map((lc) => lc.case.id);
		expect(new Set(ids).size).toBe(ids.length);
		// Spot-check the expected IDs match what the fixture map declares.
		for (const { name } of FIXTURES) {
			expect(ids).toContain(`receipt-${name}`);
		}
	});

	it('every coverage path resolves to an existing file', async () => {
		const loaded = await loadCases(CASES_DIR);
		const receiptCases = loaded.filter((lc) => lc.case.bucket === 'receipt');
		for (const lc of receiptCases) {
			for (const p of lc.case.coverage) {
				const abs = resolve(REPO_ROOT, p);
				// stat throws on missing — wrap to give a clearer assertion message.
				try {
					const s = await stat(abs);
					expect(s.isFile()).toBe(true);
				} catch (err) {
					throw new Error(
						`coverage path "${p}" for case "${lc.case.id}" does not resolve: ${(err as Error).message}`,
					);
				}
			}
		}
	});

	it('every case input payload points at an existing photo + sidecar', async () => {
		const loaded = await loadCases(CASES_DIR);
		const receiptCases = loaded.filter((lc) => lc.case.bucket === 'receipt');
		for (const lc of receiptCases) {
			for (const input of lc.case.inputs) {
				const payload = input.payload as { photoFixture: string; sidecarFixture: string };
				expect(typeof payload.photoFixture).toBe('string');
				expect(typeof payload.sidecarFixture).toBe('string');
				const photoStat = await stat(payload.photoFixture);
				const sidecarStat = await stat(payload.sidecarFixture);
				expect(photoStat.isFile()).toBe(true);
				expect(sidecarStat.isFile()).toBe(true);
			}
		}
	});
});
