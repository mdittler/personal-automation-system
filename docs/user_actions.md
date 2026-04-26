# Operator Action Items

Actions that require a human operator to take after a deployment or upgrade.

---

## Hermes P1 Chunk C (2026-04-26)

**Daily-notes opt-in migration**

After upgrading to this version:

- You may safely delete the `defaults.fallback` line from `config/pas.yaml`. Daily-notes
  logging is now per-user opt-in (default OFF) controlled via `/notes on` or the GUI.
- To enable daily-notes system-wide for all new users (before they set their own preference),
  add the following to `config/pas.yaml`:

  ```yaml
  chat:
    log_to_notes: true
  ```

  Per-user preference set via `/notes on`/`/notes off` or the GUI always wins over the
  system default.

- `/ask`, `/edit`, `/notes` are now Router built-ins — they work even if the user has the
  chatbot app toggled OFF. No configuration change is required.
