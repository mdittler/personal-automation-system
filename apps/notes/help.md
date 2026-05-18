# Notes

Quick-capture notes scoped to your user. Notes are timestamped and appended to a daily file under `data/users/<userId>/notes/daily-notes/`.

## Commands

- `/note <text>` — Save a quick note. The note is timestamped and appended to today's daily-notes file.
- `/listnotes` — List your most recent notes. (Page size is configurable via `notes_per_page` in settings.)
- `/summarize` — Generate an AI summary of today's notes.

## Natural-Language Intents

The bot also recognizes free-text phrases and routes them to the same handler as `/note`:

- "note this"
- "save a note"
- "add to my notes"
- "jot down …"

For example, "jot down: pick up dry cleaning Thursday" is equivalent to `/note pick up dry cleaning Thursday`.

## Storage

- Notes live at `data/users/<userId>/notes/daily-notes/YYYY-MM-DD.md`.
- Files have YAML frontmatter so they render natively in Obsidian.
- Files are append-only — `/summarize` reads but never rewrites your daily file.

## Settings

- `notes_per_page` (default: 10) — How many notes `/listnotes` shows per page.

## Related

- For toggling whether *every* chat message also gets appended to daily notes, see the conversation built-in `/notes` command in `conversation-commands.md`. That command is distinct from the Notes app's `/note` and `/listnotes`.
