# Hermes P5: SQLite + FTS5 Transcript Search

**Date:** 2026-04-28
**Phase:** Hermes P5
**Status:** In progress — Chunk 0 (docs) complete
**Prerequisite:** Hermes P3 (session persistence), Hermes P4 (memory snapshot + fenced recall)

---

## Overview

P5 adds full-text search across chat session transcripts. The index is a derived SQLite + FTS5 database; canonical data remains Markdown files on disk. The LLM recall pipeline classifies each incoming turn, searches past sessions, and injects hits as a fenced `<memory-context label="recalled-session">` block in prompt Layer 4. Retention/auto-prune and a rebuild CLI complete the feature.

---

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage | SQLite at `data/system/chat-state.db` | FTS5 built-in; no extra process; WAL mode handles single-writer/multi-reader on Mac Mini |
| Canonical source | Markdown transcripts (existing P3 paths) | Consistent with "no DB as source of truth" project principle |
| Index authority | Derived — rebuild must produce equivalent results | Delete DB + `pnpm chat-index-rebuild` must always work |
| Write ordering | Transcript file first, then await SQLite upsert | Index failure must not block conversation |
| Index timing | Awaited (not fire-and-forget) after each transcript write | Enables immediate `searchSessions` after `appendExchange` |
| Auth | Derive userId/householdId from requestContext only | Matches ConversationRetrievalService fail-closed pattern (REQ-CONV-SEARCH-002) |
| FTS query safety | Two-mode API: `buildUntrustedQuery` (strips operators) vs `buildTrustedQuery` (pass-through) | User/LLM-sourced terms are always sanitized before MATCH |
| Recall pipeline placement | Before PAS classifier and `auto_detect_pas` gate | Recall must work on both PAS and non-PAS paths |
| Active-session dedupe | Pass active `sessionId` in `excludeSessionIds` | Prevents duplicating content already in `recentTurns` |
| Prune target | `ended_at IS NOT NULL AND ended_at < cutoff` only | Active sessions must never be pruned |
| Prune scope | Deletes canonical `.md` files AND DB rows | Rebuild cannot restore pruned sessions (documented) |
| Windows DB lifecycle | `close()` before temp-dir deletion | `better-sqlite3` holds file lock; EBUSY without explicit close |
| Retry | `withSqliteRetry` — 15 attempts, 20–150 ms jitter, BUSY only | WAL reduces contention; retry handles transient lock spikes |

---

## Requirements

REQ-CONV-SEARCH-001 through REQ-CONV-SEARCH-014 — see `docs/urs.md` § "Hermes P5 — Transcript Search".

Summary:

| REQ | Title |
|-----|-------|
| 001 | Derived-index invariant |
| 002 | User-scoped auth — no caller-supplied identity |
| 003 | Schema — sessions, messages, messages_fts with PRAGMA user_version |
| 004 | Connection PRAGMAs |
| 005 | Jittered SQLite retry |
| 006 | Awaited best-effort indexing on transcript write |
| 007 | close() lifecycle and Windows-safe disposal |
| 008 | Untrusted FTS query sanitization |
| 009 | SearchHit ordering and grouping semantics |
| 010 | Active-session dedupe via excludeSessionIds |
| 011 | Recall pipeline independent of PAS classification |
| 012 | Prune semantics — only ended sessions, canonical deletion documented |
| 013 | Rebuild CLI parity — walks both household and legacy paths |
| 014 | Fenced Layer 4 injection with hostile-content sanitization |

---

## Chunk Decomposition

| Chunk | Scope |
|---|---|
| 0 | Docs only — URS REQ-CONV-SEARCH-001..014, this spec, open-items.md closure |
| A | `better-sqlite3` dep + schema (`applyMigrations`) + `withSqliteRetry` + `buildUntrustedQuery` / `buildTrustedQuery` |
| B | `ChatTranscriptIndex` service — `upsertSession`, `appendMessage`, `endSession`, `searchSessions`, `close()` |
| C | Rebuild CLI (`pnpm chat-index-rebuild`) + parity integration test |
| D | Live indexer hook in `ChatSessionStore` — await index calls after each transcript write |
| E | `searchSessions` on `ConversationRetrievalService` + source policy entry |
| F | Recall classifier + auto-invocation in `handle-message` / `handle-ask` + `formatRecalledSessions` + fenced injection |
| G | Retention config + `auto_prune` logic + `active-sessions.yaml` sweep |
| H | Persona test + end-to-end integration test + docs (`CLAUDE.md`, `MEMORY.md`) finalization |

---

## New Files (planned)

| File | Purpose |
|---|---|
| `core/src/services/chat-index/schema.ts` | `applyMigrations(db)`, DDL, `PRAGMA user_version` |
| `core/src/services/chat-index/retry.ts` | `withSqliteRetry(fn, opts)` |
| `core/src/services/chat-index/fts-query.ts` | `buildUntrustedQuery`, `buildTrustedQuery` |
| `core/src/services/chat-index/index.ts` | `ChatTranscriptIndex` class |
| `core/src/cli/chat-index-rebuild.ts` | Rebuild CLI entrypoint |

---

## Prompt Layer Impact (Post-P5)

| Layer | Content | Stability |
|---|---|---|
| 1 | Static base prompt + PAS policy | Fixed per deployment |
| 2 | Durable memory snapshot | Frozen at session start (P4) |
| 3 | Volatile per-turn context | Refreshed every turn |
| 4 | Fenced recalled content | `<memory-context label="recalled-data">` (P4) and `<memory-context label="recalled-session">` **(new P5)** |
| 5 | Interaction context | Per-turn |
| 6 | Conversation history tail | Current session turns |
| 7 | Current user message | New input |

---

## Verification Checklist

- [ ] `pnpm chat-index-rebuild` after delete produces equivalent search results (Chunk C)
- [ ] `searchSessions` immediately returns new turn after `appendExchange` (Chunk D)
- [ ] User A cannot see user B search results (REQ-CONV-SEARCH-002)
- [ ] Active session content excluded from recalled block via `excludeSessionIds` (REQ-CONV-SEARCH-010)
- [ ] FTS operators stripped from user-sourced queries (REQ-CONV-SEARCH-008)
- [ ] Recall block absent when classifier returns no-recall intent (Chunk F)
- [ ] Prune skips sessions with `ended_at NULL` (REQ-CONV-SEARCH-012)
- [ ] `close()` before temp-dir delete — no EBUSY on Windows (REQ-CONV-SEARCH-007)
- [ ] All 14 URS requirements have corresponding tests (Chunk H)
