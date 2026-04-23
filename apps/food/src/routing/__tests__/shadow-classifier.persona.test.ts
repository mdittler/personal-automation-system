/**
 * Shadow classifier persona spec — structural invariants + smoke roundtrips.
 *
 * What this file proves:
 *   1. FOOD_PERSONAS is internally consistent (label parity, reject integrity,
 *      coverage floors, no phrase duplication).
 *   2. One smoke roundtrip per label (mocked LLM echo) keeps the prompt+parse
 *      contract in sync with the dataset without bloating the unit suite.
 *
 * Persona schema:
 *   deterministicRejectFor — provably deterministic routes (regex/handler
 *     precedence); B.3 integration tests should consume these directly.
 *   advisoryNearMisses     — LLM-dependent or ambiguous near-misses; documented
 *     for reviewer awareness, not mechanical B.3 assertion.
 *
 * What this file does NOT prove:
 *   - Real NL accept/reject behaviour — that lives in B.3 integration tests at
 *     handleMessage, where the regex cascade actually runs and produces
 *     deterministic routing outcomes. FOOD_PERSONAS.deterministicRejectFor
 *     entries are designed to drive those tests.
 *   - Comprehensive phrase coverage — the existing taxonomy/plumbing spec in
 *     shadow-classifier.test.ts already holds one roundtrip per label;
 *     this file avoids duplicating it.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { LLMService } from '@pas/core/types';
import { FOOD_PERSONAS } from './shadow-classifier.personas.js';
import { FOOD_SHADOW_LABELS } from '../shadow-taxonomy.js';
import { FoodShadowClassifier } from '../shadow-classifier.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function mockLLM(response: string): LLMService {
    return {
        complete: vi.fn().mockResolvedValue(response),
        classify: vi.fn(),
        extractStructured: vi.fn(),
        getModelForTier: vi.fn(),
    } as unknown as LLMService;
}

const silentLogger: Logger = {
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
} as unknown as Logger;

// ─── Coverage floor constants ─────────────────────────────────────────────────

const ACCEPT_FLOOR = 3;
const REJECT_FLOOR = 2;

// ─── B.2 persona spec — structural invariants ─────────────────────────────────

describe('FOOD_PERSONAS — structural invariants', () => {
    it('covers all 27 labels in FOOD_SHADOW_LABELS (one persona per label)', () => {
        const coveredLabels = new Set(FOOD_PERSONAS.map((p) => p.label));
        for (const label of FOOD_SHADOW_LABELS) {
            expect(coveredLabels, `missing persona for label: "${label}"`).toContain(label);
        }
        expect(coveredLabels.size, 'extra personas beyond FOOD_SHADOW_LABELS').toBe(FOOD_SHADOW_LABELS.length);
    });

    it('no two personas share the same label', () => {
        const seen = new Set<string>();
        for (const p of FOOD_PERSONAS) {
            expect(seen, `duplicate persona label: "${p.label}"`).not.toContain(p.label);
            seen.add(p.label);
        }
    });

    it('every persona.label is in FOOD_SHADOW_LABELS', () => {
        const labelSet = new Set<string>(FOOD_SHADOW_LABELS);
        for (const p of FOOD_PERSONAS) {
            expect(labelSet, `persona.label not in taxonomy: "${p.label}"`).toContain(p.label);
        }
    });

    it('every deterministicRejectFor.correctLabel is in FOOD_SHADOW_LABELS', () => {
        const labelSet = new Set<string>(FOOD_SHADOW_LABELS);
        for (const p of FOOD_PERSONAS) {
            for (const r of p.deterministicRejectFor) {
                expect(
                    labelSet,
                    `deterministicRejectFor.correctLabel not in taxonomy: "${r.correctLabel}" (in persona for "${p.label}")`,
                ).toContain(r.correctLabel);
            }
        }
    });

    it('every advisoryNearMisses.correctLabel is in FOOD_SHADOW_LABELS', () => {
        const labelSet = new Set<string>(FOOD_SHADOW_LABELS);
        for (const p of FOOD_PERSONAS) {
            for (const r of p.advisoryNearMisses) {
                expect(
                    labelSet,
                    `advisoryNearMisses.correctLabel not in taxonomy: "${r.correctLabel}" (in persona for "${p.label}")`,
                ).toContain(r.correctLabel);
            }
        }
    });

    it('deterministicRejectFor.correctLabel ≠ persona.label for every entry', () => {
        for (const p of FOOD_PERSONAS) {
            for (const r of p.deterministicRejectFor) {
                expect(
                    r.correctLabel,
                    `deterministicRejectFor.correctLabel equals persona.label for "${p.label}" — entry: "${r.text}"`,
                ).not.toBe(p.label);
            }
        }
    });

    it(`every persona has at least ${ACCEPT_FLOOR} accept phrases`, () => {
        for (const p of FOOD_PERSONAS) {
            expect(
                p.accept.length,
                `persona "${p.label}" has only ${p.accept.length} accept phrases (floor: ${ACCEPT_FLOOR})`,
            ).toBeGreaterThanOrEqual(ACCEPT_FLOOR);
        }
    });

    it(`every persona has at least ${REJECT_FLOOR} deterministicRejectFor + advisoryNearMisses entries combined`, () => {
        for (const p of FOOD_PERSONAS) {
            const total = p.deterministicRejectFor.length + p.advisoryNearMisses.length;
            expect(
                total,
                `persona "${p.label}" has only ${total} reject entries combined (floor: ${REJECT_FLOOR})`,
            ).toBeGreaterThanOrEqual(REJECT_FLOOR);
        }
    });

    it('no phrase appears in both accept and deterministicRejectFor for the same persona', () => {
        for (const p of FOOD_PERSONAS) {
            const acceptSet = new Set(p.accept);
            for (const r of p.deterministicRejectFor) {
                expect(
                    acceptSet,
                    `phrase "${r.text}" is in both accept and deterministicRejectFor for "${p.label}"`,
                ).not.toContain(r.text);
            }
        }
    });

    it('no phrase appears in both accept and advisoryNearMisses for the same persona', () => {
        for (const p of FOOD_PERSONAS) {
            const acceptSet = new Set(p.accept);
            for (const r of p.advisoryNearMisses) {
                expect(
                    acceptSet,
                    `phrase "${r.text}" is in both accept and advisoryNearMisses for "${p.label}"`,
                ).not.toContain(r.text);
            }
        }
    });
});

// ─── B.2 persona spec — smoke roundtrips (mocked-echo, one per label) ──

describe('FOOD_PERSONAS — smoke roundtrips (mocked-echo, one per label)', () => {
    for (const persona of FOOD_PERSONAS) {
        const sample = persona.accept[0]!;
        it(`smoke: "${sample}" → { kind: "ok", action: "${persona.label}" }`, async () => {
            const response = JSON.stringify({ action: persona.label, confidence: 0.85 });
            const llm = mockLLM(response);
            const classifier = new FoodShadowClassifier({
                llm,
                logger: silentLogger,
                labels: FOOD_SHADOW_LABELS,
            });
            const result = await classifier.classify(sample, 1.0);
            expect(result).toEqual({ kind: 'ok', action: persona.label, confidence: 0.85 });
        });
    }
});
