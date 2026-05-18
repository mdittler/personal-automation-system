# Inviting New Users

`/invite <name>` generates a single-use 8-character code that a new user redeems by messaging the bot `/start <code>`. Admins only.

## Commands

- `/invite <name>` — Generate an invite code for a new user with display name `<name>`. Admin-only.
- `/start <code>` — Redeem an invite code (used by the new user, not the admin).

## The Flow

1. As an admin, type `/invite Sarah` (or whatever display name the new user should have).
2. The bot replies with a code, e.g. `abc12345`, valid for 24 hours.
3. Share the code with the new user via any channel (text, email, etc.).
4. The new user messages the bot `/start abc12345`. PAS welcomes them and registers them with the supplied display name.

## Constraints

- **Admin-only** — non-admins attempting `/invite` get "Only admins can create invites."
- **Display names must be globally unique** across this PAS instance — if "Sarah" is already taken, pick another.
- **Numeric-only names are rejected** (they could collide with Telegram user IDs).
- **Codes expire after 24 hours** and cannot be reused after redemption.

## Troubleshooting

- "Name … is already taken" — pick a different display name and run `/invite` again.
- "This invite code has expired" — generate a fresh code with `/invite`.
- "This invite code has already been used" — generate a fresh code; one code redeems exactly one user.
- "Only admins can create invites" — ask a household admin to run `/invite` for you.
