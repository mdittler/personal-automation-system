#!/usr/bin/env tsx
/**
 * CLI entry — invoked via `pnpm test:regression`.
 *
 * Peeks at argv to decide between two dep factories:
 *  - `--dry-run`: `buildDryRunDeps()` — no env, no real LLM, just enough
 *    to load cases and render an estimate.
 *  - otherwise: `buildProductionDeps()` — loads pas.yaml + composes the
 *    real LLMService stack (requires production env vars).
 */

import { buildDryRunDeps, buildProductionDeps } from './build-deps.js';
import { runCli } from './index.js';

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const deps = isDryRun ? buildDryRunDeps() : await buildProductionDeps();
const { exitCode } = await runCli(argv, deps);
process.exit(exitCode);
