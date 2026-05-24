/**
 * Strategy B — transitive call-graph guard for Food proactive sends.
 *
 * Replaces the entrypoint-scoped explicit-helper enumeration in
 * `proactive-send-scan.ts` with a true reachability analysis: from each
 * named entrypoint, walk the call graph BFS and flag any reachable
 * `telegram.send*` call (excluding sanctioned files).
 *
 * Uses `ts.createProgram` + the TypeScript type checker for cross-file
 * symbol resolution. Builds a function-level adjacency map keyed by
 * stable `${fileName}#${declarationStart}` IDs.
 *
 * Pattern reference: `core/src/testing/verdict-literal-scan.ts` (single-
 * file AST walker) — extended here with cross-file symbol resolution.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import * as ts from 'typescript';

export interface ProactiveSendHit {
	file: string;
	line: number;
	fn: string;
}

export interface FindReachableSendsOpts {
	projectRoot: string;
	entrypoints: string[];
	/** POSIX-style relative paths to exclude. Defaults to `['utils/proactive-message.ts']` plus tests/testing dirs (handled below). */
	excludeFiles?: string[];
}

type FnId = string; // `${fileName}#${declStart}`

interface FnNode {
	id: FnId;
	name: string;
	file: string;
	source: ts.SourceFile;
	declaration: ts.Node;
}

/**
 * Build a function-level call graph over a TypeScript Program.
 * Returns { fnsByName, callees }.
 */
function buildGraph(program: ts.Program): {
	fnsByName: Map<string, FnNode[]>;
	callees: Map<FnId, Set<FnId>>;
	fnsById: Map<FnId, FnNode>;
	telegramCallsByFnId: Map<FnId, Array<{ line: number }>>;
} {
	const checker = program.getTypeChecker();
	const fnsByName = new Map<string, FnNode[]>();
	const fnsById = new Map<FnId, FnNode>();
	const callees = new Map<FnId, Set<FnId>>();
	const telegramCallsByFnId = new Map<FnId, Array<{ line: number }>>();

	// Pass 1: index all named functions.
	for (const sf of program.getSourceFiles()) {
		if (sf.isDeclarationFile) continue;
		const visit = (node: ts.Node): void => {
			const fnNode = tryExtractFn(node, sf);
			if (fnNode) {
				fnsById.set(fnNode.id, fnNode);
				const list = fnsByName.get(fnNode.name) ?? [];
				list.push(fnNode);
				fnsByName.set(fnNode.name, list);
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}

	// Pass 2: for each indexed function, walk its body, recording outgoing
	// call edges (resolved through the type checker) and telegram.send calls.
	for (const fn of fnsById.values()) {
		const out = new Set<FnId>();
		const sends: Array<{ line: number }> = [];
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				if (isTelegramSendCall(node)) {
					const line = fn.source.getLineAndCharacterOfPosition(node.getStart(fn.source)).line + 1;
					sends.push({ line });
				} else {
					const targetId = resolveCallTarget(node, checker, fnsById);
					if (targetId) out.add(targetId);
				}
			}
			ts.forEachChild(node, visit);
		};
		const body = getFunctionBody(fn.declaration);
		if (body) ts.forEachChild(body, visit);
		callees.set(fn.id, out);
		if (sends.length) telegramCallsByFnId.set(fn.id, sends);
	}

	return { fnsByName, fnsById, callees, telegramCallsByFnId };
}

function tryExtractFn(node: ts.Node, sf: ts.SourceFile): FnNode | undefined {
	// Named function declaration
	if (ts.isFunctionDeclaration(node) && node.name) {
		return {
			id: `${sf.fileName}#${node.getStart(sf)}`,
			name: node.name.text,
			file: sf.fileName,
			source: sf,
			declaration: node,
		};
	}
	// Method declaration
	if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
		return {
			id: `${sf.fileName}#${node.getStart(sf)}`,
			name: node.name.text,
			file: sf.fileName,
			source: sf,
			declaration: node,
		};
	}
	// const X = () => ... | const X = function () {}
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
		const init = node.initializer;
		if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
			return {
				id: `${sf.fileName}#${init.getStart(sf)}`,
				name: node.name.text,
				file: sf.fileName,
				source: sf,
				declaration: init,
			};
		}
	}
	// { X: () => ... }
	if (ts.isPropertyAssignment(node) && node.initializer) {
		const init = node.initializer;
		const name =
			ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
		if (name && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
			return {
				id: `${sf.fileName}#${init.getStart(sf)}`,
				name,
				file: sf.fileName,
				source: sf,
				declaration: init,
			};
		}
	}
	return undefined;
}

function getFunctionBody(node: ts.Node): ts.Node | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node)
	) {
		return node.body;
	}
	return undefined;
}

function isTelegramSendCall(call: ts.CallExpression): boolean {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee)) return false;
	const methodName = callee.name.text;
	if (
		methodName !== 'send' &&
		methodName !== 'sendWithButtons' &&
		methodName !== 'sendPhoto' &&
		methodName !== 'sendOptions'
	) {
		return false;
	}
	const receiver = callee.expression;
	if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'telegram') return true;
	if (ts.isIdentifier(receiver) && receiver.text === 'telegram') return true;
	return false;
}

/**
 * Resolve `call.expression` to an FnId in `fnsById`. Uses the type
 * checker to chase the symbol back to its declaration and matches by
 * `${fileName}#${declStart}`.
 */
function resolveCallTarget(
	call: ts.CallExpression,
	checker: ts.TypeChecker,
	fnsById: Map<FnId, FnNode>,
): FnId | undefined {
	const expr = call.expression;
	const ident = pickCallTargetIdentifier(expr);
	if (!ident) return undefined;
	let symbol = checker.getSymbolAtLocation(ident);
	if (!symbol) return undefined;
	// Follow import / re-export aliases to the original declaration.
	if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
		try {
			symbol = checker.getAliasedSymbol(symbol);
		} catch {
			// non-alias — keep original
		}
	}
	const decls = symbol.getDeclarations();
	if (!decls) return undefined;
	for (const decl of decls) {
		const sf = decl.getSourceFile();
		// For function declarations and method declarations, declStart is decl.getStart(sf).
		// For arrow/function-expression bindings, the FnNode's id uses the initializer's start.
		const startCandidates: number[] = [decl.getStart(sf)];
		if (ts.isVariableDeclaration(decl) && decl.initializer) {
			startCandidates.push(decl.initializer.getStart(sf));
		}
		if (ts.isPropertyAssignment(decl) && decl.initializer) {
			startCandidates.push(decl.initializer.getStart(sf));
		}
		for (const start of startCandidates) {
			const id = `${sf.fileName}#${start}`;
			if (fnsById.has(id)) return id;
		}
	}
	return undefined;
}

function pickCallTargetIdentifier(expr: ts.Node): ts.Identifier | undefined {
	if (ts.isIdentifier(expr)) return expr;
	if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name;
	return undefined;
}

function isExcluded(file: string, projectRoot: string, excludeFiles: string[]): boolean {
	// Normalize to posix-relative
	const rel = file.startsWith(projectRoot) ? file.slice(projectRoot.length + 1) : file;
	const posixPath = rel.split(sep).join(posix.sep);
	if (posixPath.includes('/__tests__/') || posixPath.startsWith('__tests__/')) return true;
	if (posixPath.includes('/testing/') || posixPath.startsWith('testing/')) return true;
	if (excludeFiles.some((e) => posixPath === e || posixPath.endsWith(`/${e}`))) return true;
	return false;
}

/**
 * Public entry — build a Program from `projectRoot`, walk the call graph,
 * report `telegram.send*` reachable from any named entrypoint.
 */
export function findReachableSends(opts: FindReachableSendsOpts): ProactiveSendHit[] {
	const { projectRoot, entrypoints } = opts;
	const excludeFiles = opts.excludeFiles ?? ['utils/proactive-message.ts'];

	// Load tsconfig if present, fall back to default options.
	const configPath = join(projectRoot, 'tsconfig.json');
	let compilerOptions: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.Node16,
	};
	let rootNames: string[] = [];
	try {
		const raw = JSON.parse(readFileSync(configPath, 'utf8'));
		const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, projectRoot);
		compilerOptions = parsed.options;
		rootNames = parsed.fileNames;
	} catch {
		// No tsconfig — fall back to enumerating every .ts file.
		rootNames = enumerateTsFiles(projectRoot);
	}

	const program = ts.createProgram({ rootNames, options: compilerOptions });
	const { fnsByName, fnsById, callees, telegramCallsByFnId } = buildGraph(program);

	// BFS from each entrypoint
	const reachable = new Set<FnId>();
	const queue: FnId[] = [];
	for (const name of entrypoints) {
		const candidates = fnsByName.get(name);
		if (!candidates) continue;
		for (const fn of candidates) {
			if (!reachable.has(fn.id)) {
				reachable.add(fn.id);
				queue.push(fn.id);
			}
		}
	}
	while (queue.length) {
		const id = queue.shift();
		if (!id) continue;
		const next = callees.get(id);
		if (!next) continue;
		for (const target of next) {
			if (!reachable.has(target)) {
				reachable.add(target);
				queue.push(target);
			}
		}
	}

	// Collect telegram.send* call sites whose enclosing fn is reachable
	// AND whose file is not excluded.
	const hits: ProactiveSendHit[] = [];
	for (const id of reachable) {
		const fn = fnsById.get(id);
		if (!fn) continue;
		if (isExcluded(fn.file, projectRoot, excludeFiles)) continue;
		const sends = telegramCallsByFnId.get(id);
		if (!sends) continue;
		const relFile = fn.file.startsWith(projectRoot)
			? fn.file
					.slice(projectRoot.length + 1)
					.split(sep)
					.join(posix.sep)
			: fn.file;
		for (const { line } of sends) {
			hits.push({ file: relFile, line, fn: fn.name });
		}
	}
	return hits;
}

function enumerateTsFiles(root: string): string[] {
	// Codex #13: ESM; statically imported at the top of the file. No require().
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === 'node_modules' || name === 'dist') continue;
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(full);
			else if (st.isFile() && name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
		}
	};
	walk(root);
	return out;
}
