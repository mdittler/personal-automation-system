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
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
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

const ESCAPE = 'path escapes trial data dir';

/** Lexical escapes (`..`, absolute). Symlinks are checked separately via realpath. */
function lexicalEscape(rel: string): boolean {
	if (rel.includes('\0') || rel.includes('\\')) return true;
	if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return true;
	return rel.split('/').includes('..');
}

/**
 * True when `rel` (or a symlink along it, including a glob's parent) resolves
 * outside `dataDir`. A missing tail is fine; a symlink that leaves the dir is not.
 */
async function resolvesOutside(dataDir: string, rel: string): Promise<boolean> {
	let root: string;
	try {
		root = await realpath(dataDir);
	} catch {
		return true;
	}
	const logical = rel.endsWith('/') ? rel.slice(0, -1) : rel;
	if (logical === '' || logical === '.') return false;
	const segments = logical.split('/').filter((s) => s.length > 0 && s !== '.');
	const last = segments[segments.length - 1] ?? '';
	const walk = last.includes('*') ? segments.slice(0, -1) : segments;
	let cursor = root;
	for (const seg of walk) {
		if (seg === '..' || seg.includes('*')) return true;
		cursor = join(cursor, seg);
		try {
			const st = await lstat(cursor);
			if (!st.isSymbolicLink()) continue;
			const real = await realpath(cursor);
			const relTo = relative(root, real);
			if (relTo.startsWith('..') || isAbsolute(relTo)) return true;
			cursor = real;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') continue;
			return true;
		}
	}
	const relTo = relative(root, cursor);
	return relTo.startsWith('..') || isAbsolute(relTo);
}

async function escapeFailure(dataDir: string, rel: string): Promise<string | undefined> {
	if (lexicalEscape(rel) || (await resolvesOutside(dataDir, rel))) return `${ESCAPE}: ${rel}`;
	return undefined;
}

/** realpath of an existing path, or undefined when it does not exist. Throws on an outside symlink. */
async function realInside(root: string, abs: string, label: string): Promise<string | undefined> {
	try {
		const real = await realpath(abs);
		const relTo = relative(root, real);
		if (relTo.startsWith('..') || isAbsolute(relTo)) throw new Error(`${ESCAPE}: ${label}`);
		return real;
	} catch (err) {
		if (err instanceof Error && err.message.startsWith(ESCAPE)) throw err;
		return undefined;
	}
}

function normalize(s: string): string {
	return s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').toLowerCase();
}

/** Digit token with leading zeros and trailing fractional zeros removed. */
function canonicalAmount(token: string): string {
	const [intRaw, fracRaw] = token.split('.');
	const intPart = (intRaw ?? '0').replace(/^0+(?=\d)/, '') || '0';
	const frac = (fracRaw ?? '').replace(/0+$/, '');
	return frac.length === 0 ? intPart : `${intPart}.${frac}`;
}

export function matchesNumber(reply: string, value: number): boolean {
	if (!Number.isFinite(value)) return false;
	const want = canonicalAmount(value.toString());
	const cleaned = reply.replace(/(\d),(?=\d{3}\b)/g, '$1');
	for (const m of cleaned.matchAll(/(?<!\d)\d+(?:\.\d+)?(?!\d)/g)) {
		if (canonicalAmount(m[0]) === want) return true;
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
	if (new RegExp(`(?<!\\d)${iso}(?!\\d)`).test(text)) return true;
	const full = MONTHS[month - 1]!;
	const names = [full, full.slice(0, 3), ...(month === 9 ? ['sept'] : [])];
	const nameAlt = names.join('|');
	const dayRe = `0?${day}(?:st|nd|rd|th)?`;
	// An explicit trailing year must be the whole digit token and the expected
	// year; an omitted year is fine. `\d+` stops a longer run (`20261`) from
	// matching as `2026`.
	const yearRe = '(?:(?:,\\s*|\\s+)(\\d+))?';
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
	const escaped = await escapeFailure(ctx.dataDir, rel);
	if (escaped) return [escaped];
	const files = await listMatching(ctx.dataDir, rel);
	for (const f of files) {
		const fileEscape = await escapeFailure(ctx.dataDir, f);
		if (fileEscape) return [fileEscape];
	}
	const failures: string[] = [];
	if (check.exists === true && files.length === 0)
		failures.push(`data state: ${rel} does not exist`);
	if (check.exists === false && files.length > 0)
		failures.push(`data state: ${rel} should not exist`);
	const root = await realpath(ctx.dataDir);
	const contents = await Promise.all(
		files.map(async (f) => {
			const real = await realInside(root, join(ctx.dataDir, f), f);
			return real === undefined ? '' : readFile(real, 'utf8');
		}),
	);
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
	const escaped = await escapeFailure(dataDir, rel);
	if (escaped) throw new Error(escaped);
	const root = await realpath(dataDir);
	const abs = join(dataDir, rel);
	const hashFile = async (file: string): Promise<string> =>
		createHash('sha256')
			.update(await readFile(file))
			.digest('hex');
	if (!rel.endsWith('/')) {
		const real = await realInside(root, abs, rel);
		if (real === undefined) return 'absent';
		try {
			return await hashFile(real);
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
			const label = `${prefix}${n}`;
			const real = await realInside(root, join(dir, n), label);
			if (real === undefined) continue;
			if ((await stat(real)).isDirectory()) await walk(real, `${label}/`);
			else entries.push(`${label}:${await hashFile(real)}`);
		}
	};
	const start = (await realInside(root, abs, rel)) ?? abs;
	await walk(start, '');
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
		if (await escapeFailure(ctx.dataDir, rel)) continue;
		try {
			out.set(rel, await digestPath(ctx.dataDir, rel));
		} catch (err) {
			if (err instanceof Error && err.message.startsWith(ESCAPE)) continue;
			throw err;
		}
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
		const escaped = await escapeFailure(ctx.dataDir, rel);
		if (escaped) {
			failures.push(escaped);
			continue;
		}
		try {
			if ((await digestPath(ctx.dataDir, rel)) !== before.get(rel))
				failures.push(`changed: ${rel}`);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith(ESCAPE)) failures.push(err.message);
			else throw err;
		}
	}
	if (exp.noExternalMessages && (input.externalMessages ?? 0) > 0) {
		failures.push(`${input.externalMessages} message(s) sent to another user`);
	}
	return { pass: failures.length === 0, failures };
}
