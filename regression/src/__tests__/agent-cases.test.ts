import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildCases } from '../cases/agent/index.js';
import { seedFacts } from '../cases/agent/seed-facts.js';
import {
	AGENT_CATEGORIES,
	type AgentExpectation,
	type AgentTaskPayload,
	USER,
} from '../cases/agent/types.js';
import { validatePersonaCase } from '../shared/validate-case.js';

const FIXTURES = join(process.cwd(), 'fixtures', 'agent');
const REPO = join(process.cwd(), '..');

describe('agent seed facts are pinned (REQ-REG-AGENT-003)', () => {
	const f = seedFacts(FIXTURES);
	it('matches the generated receipts', () => {
		expect(f.receipts).toHaveLength(9);
		expect(f.latest('Costco')).toMatchObject({ date: '2026-09-09', total: 57.35 });
		expect(f.previous('Costco')).toMatchObject({ date: '2026-08-26', total: 111.36 });
		expect(f.storeTotal('Costco')).toBe(333.85);
		expect(f.storeTotal("Trader Joe's")).toBe(56.42);
		expect(f.storeTotal('Wegmans')).toBe(48.5);
		expect(f.totalBetween('2026-07-01')).toBe(235.92);
		expect(f.mostItems('Costco')).toMatchObject({ date: '2026-05-27', total: 88.36 });
		expect(f.storeAverage('Costco')).toBe(83.46);
		expect(f.storeTax('Costco')).toBe(8.72);
		expect(f.quantityOf(/banana/i)).toBe(11);
		expect(f.quantityOf(/rotisserie/i)).toBe(3);
		expect(f.maxUnitPrice()).toMatchObject({ name: 'Kirkland Olive Oil 2L', unitPrice: 25.49 });
	});
});

describe('agent cases (REQ-REG-AGENT-003)', () => {
	const cases = buildCases();
	it('has exactly 46 tasks (REQ floor is 40), unique ids, all valid, each budgeted at $0.75', () => {
		expect(cases.length).toBe(46);
		expect(cases.length).toBeGreaterThanOrEqual(40);
		expect(new Set(cases.map((c) => c.case.id)).size).toBe(cases.length);
		for (const lc of cases) {
			expect(() => validatePersonaCase(lc.case)).not.toThrow();
			expect(lc.case.budgetUsd, lc.case.id).toBe(0.75);
			expect(lc.case.id.startsWith('agent-'), lc.case.id).toBe(true); // the CLI report filters on this prefix
		}
	});
	it('covers exactly 8 categories, each at least 3 times, and both sets', () => {
		const exp = cases.map((lc) => lc.case.inputs[0]!.expected as AgentExpectation);
		expect(AGENT_CATEGORIES).toHaveLength(8);
		expect(new Set(exp.map((e) => e.category)).size).toBe(8);
		for (const cat of AGENT_CATEGORIES) {
			expect(exp.filter((e) => e.category === cat).length, cat).toBeGreaterThanOrEqual(3);
		}
		expect(exp.some((e) => e.set === 'regression')).toBe(true);
		expect(exp.some((e) => e.set === 'capability')).toBe(true);
	});
	it('every injection task watches notes/ and context/ and forbids messages to other users (review C5)', () => {
		const injection = cases.filter(
			(lc) => (lc.case.inputs[0]!.expected as AgentExpectation).category === 'injection',
		);
		expect(injection.length).toBeGreaterThanOrEqual(3);
		for (const lc of injection) {
			const e = lc.case.inputs[0]!.expected as AgentExpectation;
			expect(e.unchanged, lc.case.id).toEqual(
				expect.arrayContaining([`${USER}/notes/`, `${USER}/context/`]),
			);
			expect(e.noExternalMessages, lc.case.id).toBe(true);
			expect(lc.case.inputs[0]!.payload as AgentTaskPayload).toHaveProperty('overlay');
		}
	});
	it('every task asserts something and references existing overlays and photos', () => {
		for (const lc of cases) {
			const e = lc.case.inputs[0]!.expected as AgentExpectation;
			const p = lc.case.inputs[0]!.payload as AgentTaskPayload;
			const checks =
				(e.facts?.length ?? 0) + (e.dataState?.length ?? 0) + (e.unchanged?.length ?? 0);
			expect(checks, lc.case.id).toBeGreaterThan(0);
			if (p.overlay)
				expect(existsSync(join(FIXTURES, 'overlays', p.overlay)), lc.case.id).toBe(true);
			for (const turn of p.turns) {
				if ('photo' in turn) expect(existsSync(join(REPO, turn.photo)), turn.photo).toBe(true);
			}
		}
	});
});

describe("agent seed grocery lists use the app's department vocabulary (smoke finding)", () => {
	// Food's formatGroceryMessage renders only departments in its DEPT_ORDER and
	// silently drops items with any other department, so a seed item filed under
	// a non-canonical department ("Pantry", "Dairy") is invisible to the bot.
	const src = readFileSync(join(REPO, 'apps', 'food', 'src', 'services', 'item-parser.ts'), 'utf8');
	const block = /export const DEPARTMENTS = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? '';
	const canonical = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
	const grocery = (dir: string): string => join(dir, 'food', 'grocery', 'active.yaml');
	const files = [
		grocery(join(FIXTURES, 'household')),
		...readdirSync(join(FIXTURES, 'overlays'))
			.map((o) => grocery(join(FIXTURES, 'overlays', o)))
			.filter((f) => existsSync(f)),
	];
	it('reads the canonical list from the app source', () => {
		expect(canonical).toContain('Dairy & Eggs');
		expect(canonical).toContain('Pantry & Dry Goods');
	});
	it('every seeded grocery item has a canonical department', () => {
		expect(files.length).toBeGreaterThanOrEqual(2);
		for (const f of files) {
			const body = readFileSync(f, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
			const items = (YAML.parse(body) as { items: Array<{ name: string; department: string }> })
				.items;
			for (const i of items)
				expect(canonical, `${f}: ${i.name} -> ${i.department}`).toContain(i.department);
		}
	});
});
