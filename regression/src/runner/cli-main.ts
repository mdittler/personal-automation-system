#!/usr/bin/env tsx
/**
 * CLI entry — invoked via `pnpm test:regression`.
 *
 * Peeks at argv to decide between three dep factories:
 *  - `--list`: `buildMetadataDeps()` — loads pas.yaml + resolves real
 *    tier model IDs via `ModelSelector` so the emitted `currentCacheKey`
 *    matches what `runSuite()` would later write to cache (Chunk B.2
 *    Codex C1). Does NOT compose providers or LLMService.
 *  - `--dry-run`: `buildDryRunDeps()` — no env, no real LLM, just enough
 *    to load cases and render an estimate.
 *  - otherwise: `buildProductionDeps()` — loads pas.yaml + composes the
 *    real LLMService stack (requires production env vars).
 */

import { buildDryRunDeps, buildMetadataDeps, buildProductionDeps } from './build-deps.js';
import { runCli } from './index.js';

const argv = process.argv.slice(2);
const isList = argv.includes('--list');
const isDryRun = argv.includes('--dry-run');
const deps = isList
	? await buildMetadataDeps()
	: isDryRun
		? buildDryRunDeps()
		: await buildProductionDeps();
const { exitCode } = await runCli(argv, deps);
process.exit(exitCode);
