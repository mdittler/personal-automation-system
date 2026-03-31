---
name: pas-documentation-maintenance
description: PAS documentation update rules for CLAUDE.md, URS, system introspection, and app developer docs. Use when making significant changes, adding services, or modifying architecture.
---

# PAS Documentation Maintenance

This skill defines when and how to update project documentation during development sessions. Follow these rules whenever making significant changes.

## CLAUDE.md Updates

**CLAUDE.md is the single source of truth for the project.** Update it during every session that makes significant changes.

### When to Update
- A new architectural pattern, service, or abstraction is introduced
- A design decision is made (even "we chose X over Y because Z")
- New security measures, input validation, or auth changes are added
- New important files are created or existing ones substantially changed
- A bug reveals a non-obvious gotcha worth remembering
- A convention or workflow changes

### What to Update
- **Architecture Decisions** — new patterns, services, design choices with rationale
- **Security** — new endpoints, validation rules, auth changes
- **Key File Paths** — new important files (entry points, types, security-critical only)
- **Code Conventions** — if a new convention is established

If in doubt, write it down. A slightly verbose CLAUDE.md is better than a stale one.

## URS Updates (`docs/urs.md`)

Update whenever functionality is added, changed, or removed. See the `pas-testing-standards` skill for the full URS workflow.

## System Introspection Updates

When adding or changing architecture, services, security, or key files, check whether the chatbot's `/ask` system data needs updating:

| File | What to Check |
|------|--------------|
| `apps/chatbot/src/index.ts` | `CATEGORY_KEYWORDS` and `gatherSystemData()` — do they expose the new information? |
| `core/docs/help/system-info.md` | Does the help doc cover the new feature? |
| `core/src/services/system-info/index.ts` | Does the service aggregate the new data? |

## App Developer Documentation

Update these files when infrastructure changes affect the app-facing API:

| File | When to Update |
|------|---------------|
| `docs/CREATING_AN_APP.md` | New/changed CoreServices fields, testing utilities, app sharing workflow |
| `docs/MANIFEST_REFERENCE.md` | New/changed manifest schema fields |
| `core/src/cli/templates/app/` | Scaffold template when patterns change |

## Checklist

Before completing a session with significant changes, verify:
- [ ] CLAUDE.md updated with new architecture/security/files
- [ ] URS updated with new requirements and test references
- [ ] System introspection reviewed (if architecture changed)
- [ ] App developer docs reviewed (if CoreServices or manifest changed)
