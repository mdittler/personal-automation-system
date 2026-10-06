/**
 * Outcome oracle for the agent bucket (REQ-REG-AGENT-001).
 *
 * Deterministic grading of one trial: facts in the reply, forbidden phrases,
 * file state after the task, and byte-identical "unchanged" paths. It never
 * inspects which tools ran — outcomes are tested, not paths (doctrine item 7).
 *
 * Known limitation: number facts match any number in the reply, so a value
 * that also appears incidentally (e.g. "3") can pass by coincidence. Tasks use
 * distinctive amounts (two-decimal prices) wherever possible.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import type { AgentExpectation, DataStateCheck, FactCheck } from '../cases/agent/types.js';

export interface OutcomeContext {
	dataDir: string;
	householdId: string;
	userId: string;
}

export interface OutcomeInput {
	/** One reply string per user turn (all bot messages sent during that turn, joined). */
	replies: string[];
	expectation: AgentExpectation;
	ctx: OutcomeContext;
	/** Snapshot of `expectation.unchanged` taken before the first turn. */
	before: Map<string, string>;
	/** Count of bot messages sent to users other than the requester during the trial. */
	externalMessages?: number;
}

export interface OutcomeResult {
	pass: boolean;
	failures: string[];
}

const MONTHS = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december',
];

export function resolveDataPath(p: string, ctx: OutcomeContext): string {
	return p.replaceAll('{householdId}', ctx.householdId).replaceAll('{userId}', ctx.userId);
}

function normalize(s: string): string {
	return s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').toLowerCase();
}

export function matchesNumber(reply: string, value: number): boolean {
	const cleaned = reply.replace(/(\d),(?=\d{3}\b)/g, '$1');
	for (const m of cleaned.matchAll(/\d+(?:\.\d+)?/g)) {
		if (Math.abs(Number.parseFloat(m[0]) - value) < 0.005) return true;
	}
	return false;
}

export function matchesDate(reply: string, iso: string): boolean {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) throw new Error(`matchesDate: not an ISO date: ${iso}`);
	const [, y, mm, dd] = m as unknown as [string, string, string, string];
	const month = Number(mm);
	const day = Number(dd);
	const text = normalize(reply);
	if (text.includes(iso)) return true;
	const full = MONTHS[month - 1]!;
	const names = [full, full.slice(0, 3), ...(month === 9 ? ['sept'] : [])];
	const nameAlt = names.join('|');
	const dayRe = `0?${day}(?:st|nd|rd|th)?`;
	// An explicit trailing year must be the expected one; an omitted year is fine.
	const yearRe = '(?:(?:,\\s*|\\s+)(\\d{4}))?';
	const textual = [
		new RegExp(`\\b(?:${nameAlt})\\.?\\s+${dayRe}\\b${yearRe}`, 'g'),
		new RegExp(`\\b${dayRe}\\s+(?:of\\s+)?(?:${nameAlt})\\b${yearRe}`, 'g'),
	];
	for (const re of textual) {
		for (const m of text.matchAll(re)) {
			if (m[1] === undefined || m[1] === y) return true;
		}
	}
	return new RegExp(`(?<![\\d/])0?${month}/0?${day}(?:/(?:${y}|${y.slice(2)}))?(?![\\d/])`).test(
		text,
	);
}

export function expandDatePlaceholders(text: string, today: string): string {
	return text.replace(/\{date:([+-]\d+)\}/g, (_m, offset: string) => {
		const d = new Date(`${today}T00:00:00Z`);
		d.setUTCDate(d.getUTCDate() + Number(offset));
		return d.toISOString().slice(0, 10);
	});
}

function describeFact(f: FactCheck): string {
	switch (f.kind) {
		case 'any-text':
			return `missing fact "${f.label}" (any of: ${f.values.join(', ')})`;
		default:
			return `missing fact "${f.label}" (${String(f.value)})`;
	}
}

function factMatches(reply: string, f: FactCheck, today: string): boolean {
	const text = normalize(reply);
	switch (f.kind) {
		case 'number':
			return matchesNumber(reply, f.value);
		case 'text':
			return text.includes(normalize(f.value));
		case 'any-text':
			return f.values.some((v) => text.includes(normalize(v)));
		case 'date':
			return matchesDate(reply, expandDatePlaceholders(f.value, today));
	}
}

async function listMatching(dataDir: string, rel: string): Promise<string[]> {
	const last = rel.split('/').pop() ?? '';
	if (!last.includes('*')) {
		try {
			await stat(join(dataDir, rel));
			return [rel];
		} catch {
			return [];
		}
	}
	const parent = dirname(rel);
	const escaped = last.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
	const re = new RegExp(`^${escaped}$`);
	try {
		const names = await readdir(join(dataDir, parent));
		return names
			.filter((n) => re.test(n))
			.sort()
			.map((n) => `${parent}/${n}`);
	} catch {
		return [];
	}
}

function yamlBody(raw: string): unknown {
	const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(raw);
	return YAML.parse(m ? (m[1] ?? '') : raw);
}

async function checkDataState(check: DataStateCheck, ctx: OutcomeContext): Promise<string[]> {
	const rel = resolveDataPath(check.path, ctx);
	const files = await listMatching(ctx.dataDir, rel);
	const failures: string[] = [];
	if (check.exists === true && files.length === 0)
		failures.push(`data state: ${rel} does not exist`);
	if (check.exists === false && files.length > 0)
		failures.push(`data state: ${rel} should not exist`);
	const contents = await Promise.all(files.map((f) => readFile(join(ctx.dataDir, f), 'utf8')));
	if (check.contains) {
		const want = check.contains.map(normalize);
		if (!contents.some((c) => want.every((w) => normalize(c).includes(w)))) {
			failures.push(`data state: no file matching ${rel} contains [${check.contains.join(', ')}]`);
		}
	}
	if (check.lineRegex) {
		const lines = contents.flatMap((c) => c.split('\n'));
		for (const src of check.lineRegex) {
			const re = new RegExp(src, 'i');
			if (!lines.some((l) => re.test(l)))
				failures.push(`data state: no line in ${rel} matches /${src}/i`);
		}
	}
	if (check.items) {
		const { key, field, match, present, count } = check.items;
		const first = contents[0];
		if (first === undefined) {
			failures.push(`data state: ${rel} missing (items check)`);
		} else {
			const doc = yamlBody(first) as Record<string, unknown> | null;
			const list = Array.isArray(doc?.[key]) ? (doc?.[key] as Array<Record<string, unknown>>) : [];
			const re = new RegExp(match, 'i');
			const n = list.filter((it) => re.test(String(it?.[field] ?? ''))).length;
			if (present && n === 0)
				failures.push(`data state: no ${key}[].${field} matching /${match}/i in ${rel}`);
			if (present && count !== undefined && n !== count) {
				failures.push(
					`data state: expected ${count} ${key}[].${field} matching /${match}/i in ${rel}, found ${n}`,
				);
			}
			if (!present && n > 0)
				failures.push(`data state: ${key}[].${field} matching /${match}/i still present in ${rel}`);
		}
	}
	return failures;
}

async function digestPath(dataDir: string, rel: string): Promise<string> {
	const abs = join(dataDir, rel);
	if (!rel.endsWith('/')) {
		try {
			return createHash('sha256')
				.update(await readFile(abs))
				.digest('hex');
		} catch {
			return 'absent';
		}
	}
	const entries: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		let names: string[];
		try {
			names = (await readdir(dir)).sort();
		} catch {
			return;
		}
		for (const n of names) {
			const p = join(dir, n);
			if ((await stat(p)).isDirectory()) await walk(p, `${prefix}${n}/`);
			else
				entries.push(
					`${prefix}${n}:${createHash('sha256')
						.update(await readFile(p))
						.digest('hex')}`,
				);
		}
	};
	await walk(abs, '');
	return entries.length === 0
		? 'absent'
		: createHash('sha256').update(entries.join('\n')).digest('hex');
}

/** Snapshot `unchanged` paths before the first turn. Keys are resolved paths. */
export async function snapshotPaths(
	paths: readonly string[],
	ctx: OutcomeContext,
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const p of paths) {
		const rel = resolveDataPath(p, ctx);
		out.set(rel, await digestPath(ctx.dataDir, rel));
	}
	return out;
}

export async function evaluateOutcome(
	input: OutcomeInput,
	today = new Date().toISOString().slice(0, 10),
): Promise<OutcomeResult> {
	const { replies, expectation: exp, ctx, before } = input;
	const failures: string[] = [];
	const factText =
		exp.factsFrom === 'all-turns' ? replies.join('\n') : (replies[replies.length - 1] ?? '');
	for (const f of exp.facts ?? []) {
		if (!factMatches(factText, f, today)) failures.push(describeFact(f));
	}
	const allText = normalize(replies.join('\n'));
	for (const phrase of exp.forbidden ?? []) {
		if (allText.includes(normalize(phrase))) failures.push(`forbidden phrase present: "${phrase}"`);
	}
	for (const check of exp.dataState ?? []) failures.push(...(await checkDataState(check, ctx)));
	for (const p of exp.unchanged ?? []) {
		const rel = resolveDataPath(p, ctx);
		if ((await digestPath(ctx.dataDir, rel)) !== before.get(rel)) failures.push(`changed: ${rel}`);
	}
	if (exp.noExternalMessages && (input.externalMessages ?? 0) > 0) {
		failures.push(`${input.externalMessages} message(s) sent to another user`);
	}
	return { pass: failures.length === 0, failures };
}
