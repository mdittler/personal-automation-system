# Conversation Commands

Built-in slash commands handled by the conversation layer itself (not by any app). All are available to every user; none require admin.

## Quick Reference

- `/ask <question>` — Force app-aware mode for this question. PAS will consider your data, installed apps, and recent history.
- `/edit <instructions>` — LLM-assisted file edit on data files you own. Targets one file per invocation; PAS replies with the proposed change for confirmation.
- `/notes [on|off|status]` — Toggle daily-notes logging for your account. When on, every non-command chat message is also appended to today's daily-notes file. (Distinct from the Notes app's `/note` / `/listnotes` commands.)
- `/newchat`, `/reset` — Start a fresh chat session. Drops the in-progress session and mints a new one. Aliases.
- `/title [new title]` — Show the current session's title, or set it. Auto-titling assigns one after a few exchanges; this lets you override.
- `/recall <query>` — Search past conversations (full-text). Returns snippets with session links.
- `/refreshmemory`, `/refresh-memory` — Rebuild your memory snapshot from your current data. Use after big config or data changes. Aliases.
- `/flushmemory`, `/flush-memory` — Save a summary of this session to long-term memory before ending it. Aliases.
- `/settings` — View your tunables. Subforms:
  - `/settings <category>` — show all keys in one category
  - `/settings <category> <key> [value]` — read or write a single key
  - `/settings reset` — restore defaults (requires confirmation)
  - `/settings confirm` — confirm a pending destructive change
- `/start` — Onboarding entry. New users redeem invite codes via `/start <code>`.
- `/help` — List available commands.

## When to use each

### `/ask` vs free-text chat

Plain chat messages may route to an app (intent-based) or fall back to the chatbot. `/ask` skips the routing classifier and forces the app-aware chatbot path — useful when you want PAS to reason across apps and data rather than pick a single app to handle the message.

### `/edit`

Use `/edit` to ask PAS to modify one of your own data files in place. Provide the target and the change in natural language ("edit my grocery list and remove the bread"). PAS will preview the change and require confirmation before writing.

### `/notes` (conversation built-in, not the Notes app)

`/notes on` enables daily-notes capture: every chat message you send is appended to your daily notes file in addition to its normal handling. `/notes off` turns it back off. `/notes status` reports the current state. This is independent of the Notes app's `/note` (save one explicit note) and `/listnotes` (list recent notes).

### `/newchat` and `/reset`

Both start a fresh chat session. The in-progress session is closed (and, if long enough, summarized into long-term memory). Use when you want to switch topics cleanly without context bleed.

### `/title`

With no argument, prints the current session title. With an argument, sets it. Session titles are normally auto-assigned after a few turns; manual `/title` overrides take precedence.

### `/recall <query>`

Searches your past conversations for text matching the query and returns short snippets with the session each came from. Useful for "what did we decide about X?" style lookups.

### `/refreshmemory` / `/refresh-memory`

Forces an immediate rebuild of your memory snapshot (the per-user data digest the chatbot reads at the start of each turn). Run this after large config changes, after editing many files at once, or if the chatbot seems out of date.

### `/flushmemory` / `/flush-memory`

Eagerly writes a summary of the current session to long-term memory. Normally this happens automatically when a session is closed; `/flushmemory` forces it now.

### `/settings`

`/settings` alone lists categories and keys. `/settings <category>` drills into a single category. `/settings <category> <key>` shows one key's current value. `/settings <category> <key> <value>` sets it. Some settings are destructive (e.g. resetting a vault) — PAS will reply with a confirmation prompt and require `/settings confirm` to proceed. `/settings reset` restores defaults for all keys.

### `/start`

The entry point for new users. A first-time `/start` triggers onboarding. `/start <code>` redeems an invite code from an admin (see `inviting-users.md`).

### `/help`

Lists all commands currently available to you, including built-ins and app-declared commands you have access to.
