/**
 * Static analyzer for PAS app source code.
 *
 * Scans app source files for banned import patterns that violate
 * the PAS security model (e.g., direct LLM SDK usage, child_process).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface BannedImportViolation {
	/** Relative path from app root. */
	file: string;
	/** 1-based line number. */
	line: number;
	/** The banned module specifier found. */
	importName: string;
	/** Human-readable explanation of why this import is banned. */
	reason: string;
}

export interface StaticAnalysisResult {
	violations: BannedImportViolation[];
	filesScanned: number;
}

interface BannedImport {
	/** Module specifier to match against. */
	pattern: string;
	/** Human-readable reason for the ban. */
	reason: string;
}

const BANNED_IMPORTS: BannedImport[] = [
	{ pattern: '@anthropic-ai/sdk', reason: 'Apps must use CoreServices.llm for all LLM access.' },
	{ pattern: 'openai', reason: 'Apps must use CoreServices.llm for all LLM access.' },
	{ pattern: '@google/genai', reason: 'Apps must use CoreServices.llm for all LLM access.' },
	{ pattern: 'ollama', reason: 'Apps must use CoreServices.llm for all LLM access.' },
	{ pattern: 'child_process', reason: 'Arbitrary command execution is not allowed in apps.' },
	{ pattern: 'node:child_process', reason: 'Arbitrary command execution is not allowed in apps.' },
];

/** Directories to skip when scanning. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** File extensions to scan. */
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']);

/**
 * Regex to extract module specifiers from import/require statements.
 *
 * Matches:
 *   import ... from 'module'
 *   import('module')
 *   require('module')
 *   export ... from 'module'
 *
 * Does NOT match inside comments or string literals (handled by line-level filtering).
 */
const IMPORT_PATTERN =
	/(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"]|export\s+\{[^}]*\}\s+from\s+['"])([^'"]+)['"]/g;

/**
 * Check if a line is a single-line comment.
 * Block comment state is tracked separately in scanFileContent().
 */
function isCommentLine(line: string): boolean {
	const trimmed = line.trimStart();
	return trimmed.startsWith('//') || trimmed.startsWith('*');
}

/**
 * Check whether a module specifier matches a banned import.
 *
 * For scoped packages (starting with @), matches the full scope+name.
 * For unscoped packages, matches exactly or as a subpath (e.g., "openai" matches "openai/resources"
 * but NOT "openai-helpers").
 */
function matchesBannedImport(specifier: string, pattern: string): boolean {
	if (specifier === pattern) return true;
	if (specifier.startsWith(`${pattern}/`)) return true;
	return false;
}

/**
 * Recursively collect all scannable source files in a directory.
 */
async function collectSourceFiles(dir: string, appRoot: string): Promise<string[]> {
	const files: string[] = [];

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return files;
	}

	const { stat } = await import('node:fs/promises');

	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;

		const fullPath = join(dir, name);
		const stats = await stat(fullPath).catch(() => null);
		if (!stats) continue;

		if (stats.isDirectory()) {
			const nested = await collectSourceFiles(fullPath, appRoot);
			files.push(...nested);
		} else if (stats.isFile()) {
			const ext = name.slice(name.lastIndexOf('.'));
			if (SCAN_EXTENSIONS.has(ext)) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

/**
 * Check a line (or partial line) for banned import patterns and record violations.
 */
function checkLineForViolations(
	text: string,
	relPath: string,
	lineIndex: number,
	violations: BannedImportViolation[],
): void {
	IMPORT_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null = IMPORT_PATTERN.exec(text);
	while (match !== null) {
		const specifier = match[1] as string;
		for (const banned of BANNED_IMPORTS) {
			if (matchesBannedImport(specifier, banned.pattern)) {
				violations.push({
					file: relPath,
					line: lineIndex + 1,
					importName: banned.pattern,
					reason: banned.reason,
				});
			}
		}
		match = IMPORT_PATTERN.exec(text);
	}
}

/**
 * Scan a single file for banned imports.
 * Tracks block comment state (/* ... *​/) to avoid false positives on commented-out imports.
 */
function scanFileContent(content: string, relPath: string): BannedImportViolation[] {
	const violations: BannedImportViolation[] = [];
	const lines = content.split('\n');
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;

		if (inBlockComment) {
			const closeIdx = line.indexOf('*/');
			if (closeIdx === -1) continue; // Still inside block comment
			inBlockComment = false;
			// Check the remainder after the block comment closes
			const after = line.slice(closeIdx + 2);
			if (after.trim()) {
				checkLineForViolations(after, relPath, i, violations);
			}
			continue;
		}

		if (isCommentLine(line)) continue;

		// Check for block comment opening
		const openIdx = line.indexOf('/*');
		if (openIdx !== -1) {
			const closeIdx = line.indexOf('*/', openIdx + 2);
			if (closeIdx === -1) {
				// Block comment starts, doesn't close on this line
				inBlockComment = true;
				// Check content before the block comment
				const before = line.slice(0, openIdx);
				if (before.trim()) {
					checkLineForViolations(before, relPath, i, violations);
				}
				continue;
			}
			// Single-line block comment: /* ... */ — remove it and scan the rest
			const cleaned = line.slice(0, openIdx) + line.slice(closeIdx + 2);
			checkLineForViolations(cleaned, relPath, i, violations);
			continue;
		}

		checkLineForViolations(line, relPath, i, violations);
	}

	return violations;
}

/**
 * Analyze an app directory for banned imports.
 *
 * Recursively scans all .ts/.js source files (excluding node_modules, dist, .git)
 * and reports any imports that violate the PAS app security model.
 */
export async function analyzeApp(appDir: string): Promise<StaticAnalysisResult> {
	const sourceFiles = await collectSourceFiles(appDir, appDir);
	const violations: BannedImportViolation[] = [];

	for (const filePath of sourceFiles) {
		const content = await readFile(filePath, 'utf-8');
		const relPath = relative(appDir, filePath).replace(/\\/g, '/');
		const fileViolations = scanFileContent(content, relPath);
		violations.push(...fileViolations);
	}

	return {
		violations,
		filesScanned: sourceFiles.length,
	};
}
