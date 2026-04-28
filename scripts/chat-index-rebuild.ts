#!/usr/bin/env tsx
/**
 * chat-index-rebuild.ts
 *
 * Rebuilds the chat transcript FTS index from raw Markdown session files on
 * disk.  Walks both path layouts:
 *
 *   Legacy:    <dataDir>/users/<userId>/chatbot/conversation/sessions/*.md
 *   Household: <dataDir>/households/<householdId>/users/<userId>/chatbot/conversation/sessions/*.md
 *
 * Usage:
 *   pnpm chat-index-rebuild [--dry-run] [--db <path>] [--data <path>]
 *
 * Core logic lives in core/src/services/chat-transcript-index/rebuild.ts and is
 * re-exported here so that tests can import it without going above the core project root.
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { rebuildIndex } from '../core/src/services/chat-transcript-index/rebuild.js';

export { rebuildIndex } from '../core/src/services/chat-transcript-index/rebuild.js';

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      db: { type: 'string', default: 'data/system/chat-state.db' },
      data: { type: 'string', default: 'data/' },
    },
  });

  const dbPath = resolve(process.cwd(), values.db!);
  const dataDir = resolve(process.cwd(), values.data!);
  const dryRun = values['dry-run']!;

  if (dryRun) {
    console.log('[dry-run] No writes will be performed.');
  }
  console.log(`DB:   ${dbPath}`);
  console.log(`Data: ${dataDir}`);

  const result = await rebuildIndex({ dbPath, dataDir, dryRun });

  console.log(
    `\nDone: ${result.sessions} sessions indexed, ${result.turns} turns indexed, ${result.skipped} skipped (corrupt or unreadable)`,
  );
}

// Run when invoked as a script (not when imported in tests)
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('chat-index-rebuild.ts') ||
  process.argv[1]?.endsWith('chat-index-rebuild.js');

if (isMain) {
  main().catch((err) => {
    console.error('chat-index-rebuild failed:', err);
    process.exit(1);
  });
}
