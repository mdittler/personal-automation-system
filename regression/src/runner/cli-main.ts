#!/usr/bin/env tsx
/**
 * CLI entry — invoked via `pnpm test:regression`.
 *
 * Wires production deps via `build-deps.ts`, forwards to `runCli`, exits
 * with the REQ-REG-011 gate code.
 */

import { buildProductionDeps } from './build-deps.js';
import { runCli } from './index.js';

const deps = await buildProductionDeps();
const { exitCode } = await runCli(process.argv.slice(2), deps);
process.exit(exitCode);
