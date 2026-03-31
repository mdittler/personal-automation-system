# Shared Data Spaces

Spaces let you share data with specific people instead of everyone. For example, share a grocery list with your family, or project notes with a specific group.

## How Spaces Work

Each space has a name, ID, and a list of members. When you enter a space with `/space <id>`, your messages operate on shared data within that space instead of your personal data. Apps that support spaces will read and write to the space directory.

## Commands

- `/space` — Show your current mode (personal or space) and list your spaces
- `/space <id>` — Enter a shared space (you must be a member)
- `/space off` — Return to personal mode
- `/space create <id> <name>` — Create a new space (you become the first member)
- `/space delete <id>` — Delete a space (creator only; data is preserved on disk)
- `/space invite <space-id> <username>` — Add a member by their display name
- `/space kick <space-id> <username>` — Remove a member
- `/space members <space-id>` — List members of a space

## Data Storage

Space data is stored at `data/spaces/<space-id>/<app-id>/`. This is separate from per-user data (`data/users/<user-id>/`) and shared data (`data/users/shared/`).

When you delete a space, the definition is removed but the data files are preserved on disk.

## GUI Management

Spaces can also be managed from the GUI at **Spaces** in the navigation bar. The GUI lets you create, edit, and delete spaces, and manage members with a visual interface.

Space data files are browsable from the **Data** page under the "Spaces" section.

## Obsidian Vault Integration

When using `data/vaults/<userId>/` as your Obsidian vault root (via VaultService), space data appears automatically under the `_spaces/` directory:

```
data/vaults/<userId>/
  notes/               ← your personal app data
  _shared/grocery/     ← global shared data
  _spaces/family/      ← space data (symlink to data/spaces/family/)
    meal-planner/
    grocery/
```

Space files are browsable, searchable, and linkable in Obsidian just like personal data. Use wiki-links with the `_spaces/` prefix to reference space files:

```markdown
See the family grocery list: [[_spaces/family/grocery/lists/weekly]]
This week's meal plan: [[_spaces/family/meal-planner/plans/week-12]]
```

The `_spaces/` prefix cannot collide with app IDs (app IDs must match `^[a-z][a-z0-9-]*$`). Only spaces where you are a member will have symlinks in your vault.

## For App Developers

Apps can access space data via `services.data.forSpace(ctx.spaceId, ctx.userId)`. This returns a `ScopedDataStore` rooted at the space directory. The infrastructure checks membership before returning the store — unauthorized access throws `SpaceMembershipError`.

When a user is in space mode, `ctx.spaceId` and `ctx.spaceName` are set on the `MessageContext`. Apps that don't support spaces can simply ignore these fields.
