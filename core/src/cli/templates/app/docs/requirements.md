# {{APP_NAME}} Requirements

## Overview

(What does this app do? Who is it for? What problem does it solve?)

---

## Module 1: (Feature Area Name)

### Requirements

**FA-1. (Requirement title.)**
(Describe the requirement in detail. Include acceptance criteria.)

**FA-2. (Requirement title.)**
(Describe the requirement.)

---

## Cross-App Events

(List any events this app emits or subscribes to via the PAS event bus.)

| Event | Payload | Description |
|-------|---------|-------------|
| `{{APP_ID}}:example-event` | `{ ... }` | (When is this emitted?) |

---

## Implementation Phases

(Optional: break requirements into ordered phases for incremental delivery.)

| Phase | Modules | Description |
|-------|---------|-------------|
| 1 | (Module 1) | (What's included and why it comes first) |
| 2 | (Module 2) | (What depends on Phase 1) |

---

## Configuration

(List user-configurable fields with types, defaults, and descriptions.)

| Config Field | Type | Default | Description |
|---|---|---|---|
| `example_field` | string | `""` | (What does this control?) |
