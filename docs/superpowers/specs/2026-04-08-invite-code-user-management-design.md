# Invite Code Registration & User Management GUI

## Context

Currently, registering new PAS users requires manually editing `config/pas.yaml` with the new user's Telegram numeric ID — information that most people don't know how to find. This creates friction for onboarding household members and guests. Additionally, there's no GUI for managing user access after registration; all changes require editing YAML and restarting.

This feature introduces:
1. **Invite codes** — admin generates a code via `/invite`, shares it with the new user, who redeems it by messaging the bot. No Telegram ID knowledge needed.
2. **User management GUI** — admin-only page for managing app access, shared scopes, and user removal.
3. **Runtime user mutation** — UserManager gains add/remove/update capabilities with automatic `pas.yaml` sync.

## 1. Invite Code System

### 1.1 Code Generation (`/invite` command)

- **Command**: `/invite <display-name>` (e.g., `/invite Sarah`)
- **Admin-only**: Rejects non-admin users with "Only admins can create invites."
- **Code format**: 8-character alphanumeric (lowercase + digits), cryptographically random via `crypto.randomBytes`
- **Expiry**: 24 hours from creation
- **Storage**: `data/system/invites.yaml`
- **Response**: Bot replies with the code and instructions to share

**Built-in command**: Handled in the router alongside `/space` and `/start`, before app command dispatch.

### 1.2 Invite Storage Schema

File: `data/system/invites.yaml`

```yaml
# Key is the invite code
abc12xyz:
  name: "Sarah"
  createdBy: "8187111554"      # Admin's Telegram ID
  createdAt: "2026-04-08T10:00:00.000Z"
  expiresAt: "2026-04-09T10:00:00.000Z"
  usedBy: null                 # Telegram ID of redeemer, null if unused
  usedAt: null                 # ISO timestamp of redemption, null if unused
```

### 1.3 Code Redemption (`/start <code>`)

- **Trigger**: User sends `/start <code>` to the bot (Telegram's deep link mechanism sends `/start <payload>` when user opens a `t.me/bot?start=<payload>` link)
- **Also accepts**: Plain code as a message from an unregistered user (fallback for users who just paste the code)
- **Validation checks** (in order):
  1. Code exists in `invites.yaml` → if not: "Invalid invite code."
  2. Code not already used (`usedBy === null`) → if used: "This invite code has already been used."
  3. Code not expired (`expiresAt > now`) → if expired: "This invite code has expired. Ask the admin for a new one."
  4. User not already registered → if registered: "You're already registered! Type /help to get started."

**On successful redemption:**
1. Create `RegisteredUser`: `{ id: telegramUserId, name: invite.name, isAdmin: false, enabledApps: ["*"], sharedScopes: [] }`
2. Add to UserManager in memory (immediate activation)
3. Sync users to `pas.yaml` (persistence)
4. Mark code as used in `invites.yaml` (`usedBy`, `usedAt`)
5. Send welcome message: "Welcome to PAS, {name}! Type /help to see available commands."
6. Log the registration event

### 1.4 InviteService

New service: `core/src/services/invite/index.ts`

```typescript
interface InviteCode {
  name: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
  usedAt: string | null;
}

class InviteService {
  constructor(opts: { dataDir: string; logger: Logger })

  // Generate a new invite code, store it, return the code string
  async createInvite(name: string, createdBy: string): Promise<string>

  // Validate and return the invite if redeemable, or an error message
  async validateCode(code: string): Promise<{ invite: InviteCode } | { error: string }>

  // Mark code as used
  async redeemCode(code: string, usedBy: string): Promise<void>

  // List all invites (for potential future GUI use)
  async listInvites(): Promise<Record<string, InviteCode>>

  // Cleanup expired/used codes older than 7 days (called periodically or at startup)
  async cleanup(): Promise<void>
}
```

Storage path: `{dataDir}/system/invites.yaml`

## 2. User Management GUI

### 2.1 Page: `/gui/users`

Admin-only page added to the sidebar navigation as "Users".

**Table layout:**

| Name | App 1 | App 2 | ... | Groups | Actions |
|------|-------|-------|-----|--------|---------|
| Matthew (admin) | [x] | [x] | ... | grocery, family | — |
| Sarah | [x] | [ ] | ... | grocery | Remove |

- **Rows**: All registered users, sorted alphabetically
- **App columns**: One column per loaded app. Each cell is a checkbox.
- **Groups column**: Comma-separated list of `sharedScopes`. Editable inline.
- **Actions column**: "Remove" button (not shown for the current admin viewing the page)

### 2.2 App Access Toggles

- **Mechanism**: htmx POST to `/gui/users/:userId/apps` with the updated app list
- **Behavior**: Checkbox toggle sends the full list of checked apps. Server updates UserManager in memory + syncs to `pas.yaml`.
- **Wildcard handling**: If user currently has `["*"]` and admin unchecks one app, convert to explicit list of all apps minus the unchecked one. If admin checks all apps, convert back to `["*"]`.

### 2.3 Groups (Shared Scopes) Editing

- **Mechanism**: Inline edit. Click the groups cell → shows input field with current values. Submit updates via htmx POST to `/gui/users/:userId/groups`.
- **Validation**: Scope names must match `^[a-zA-Z0-9_-]+$` pattern.

### 2.4 User Removal

- **Mechanism**: "Remove" button with browser `confirm()` dialog before htmx DELETE to `/gui/users/:userId`.
- **Guards**:
  - Cannot remove yourself (the currently authenticated admin)
  - Cannot remove the last admin user
- **Effect**: Removes from UserManager in memory + syncs to `pas.yaml`. User's data directory is NOT deleted (preserves history).

### 2.5 Admin-Only Access

The GUI uses a single shared `GUI_AUTH_TOKEN` — anyone with the token can access all GUI pages. Since this token is only shared with admins, the existing cookie auth is sufficient. No additional per-user admin check is needed for the users page. This is consistent with how all other GUI pages (reports, alerts, spaces, apps) work today.

## 3. Runtime User Management

### 3.1 UserManager Additions

New methods on `UserManager`:

```typescript
// Add a new user to the in-memory map
addUser(user: RegisteredUser): void

// Remove a user from the in-memory map
removeUser(telegramId: string): boolean

// Update a user's enabled apps
updateUserApps(telegramId: string, enabledApps: string[]): boolean

// Update a user's shared scopes
updateUserSharedScopes(telegramId: string, sharedScopes: string[]): boolean
```

These methods only mutate in-memory state. Config persistence is handled separately.

### 3.2 Config Writer

New utility: `core/src/services/config/config-writer.ts`

```typescript
// Reads pas.yaml, updates the users section, writes back atomically
async function syncUsersToConfig(configPath: string, users: ReadonlyArray<RegisteredUser>): Promise<void>
```

**Implementation approach:**
- Read current `pas.yaml` as raw text
- Parse YAML to object
- Replace the `users` array (converting camelCase back to snake_case)
- Serialize to YAML
- Write atomically (temp file + rename)
- Preserves all non-user sections (telegram, llm, routing, etc.) untouched

### 3.3 UserMutationService

Coordinates mutations across UserManager + config writer + invite service:

```typescript
class UserMutationService {
  constructor(opts: { userManager: UserManager; configPath: string; logger: Logger })

  // Register a new user (from invite redemption)
  async registerUser(user: RegisteredUser): Promise<void>

  // Remove a user
  async removeUser(telegramId: string): Promise<{ error?: string }>

  // Update app access
  async updateUserApps(telegramId: string, enabledApps: string[]): Promise<void>

  // Update shared scopes
  async updateUserSharedScopes(telegramId: string, sharedScopes: string[]): Promise<void>
}
```

Each method: mutates UserManager in memory → syncs to `pas.yaml`.

## 4. Integration Points

### 4.1 Router Changes

In `core/src/services/router/index.ts`:

- Add `/invite` to built-in command handling (alongside `/space`, `/start`, `/help`)
- Modify `/start` handling: if `/start <code>`, attempt invite redemption instead of welcome message
- Add invite code detection in UserGuard: before rejecting unregistered users, check if their message is an invite code

### 4.2 UserGuard Changes

In `core/src/services/user-manager/user-guard.ts`:

- When an unregistered user sends a message, check if the message text is a valid invite code
- If it is: trigger redemption flow
- If not: send existing rejection message ("You're not registered...")

### 4.3 Help Message

Add invite command to admin help output:

```
*Admin*
  /invite <name> — Generate an invite code for a new user
```

### 4.4 GUI Navigation

Add "Users" link to sidebar in `layout.eta`, visible to all authenticated GUI users.

## 5. Files to Create/Modify

### New files:
- `core/src/services/invite/index.ts` — InviteService
- `core/src/services/config/config-writer.ts` — Config sync utility
- `core/src/services/user-manager/user-mutation-service.ts` — Mutation coordinator
- `core/src/gui/routes/users.ts` — GUI route handlers
- `core/src/gui/views/users.eta` — User management page template
- `core/src/services/invite/__tests__/index.test.ts` — InviteService tests
- `core/src/services/config/__tests__/config-writer.test.ts` — Config writer tests
- `core/src/services/user-manager/__tests__/user-mutation-service.test.ts` — Mutation service tests
- `core/src/gui/routes/__tests__/users.test.ts` — GUI route tests

### Modified files:
- `core/src/services/router/index.ts` — Add `/invite` command handling, modify `/start` for code redemption
- `core/src/services/user-manager/index.ts` — Add mutation methods
- `core/src/services/user-manager/user-guard.ts` — Add invite code detection for unregistered users
- `core/src/bootstrap.ts` — Wire InviteService, UserMutationService, GUI routes
- `core/src/gui/index.ts` — Register user management routes
- `core/src/gui/views/layout.eta` — Add "Users" to sidebar navigation
- `core/src/types/users.ts` — Add InviteCode type if needed

## 6. Error Handling

| Scenario | Response |
|----------|----------|
| Non-admin uses `/invite` | "Only admins can create invites." |
| `/invite` with no name | "Usage: `/invite <name>`" |
| Invalid code format | "Invalid invite code." |
| Code not found | "Invalid invite code." |
| Code already used | "This invite code has already been used." |
| Code expired | "This invite code has expired. Ask the admin for a new one." |
| Already registered user redeems | "You're already registered! Type /help to get started." |
| Remove self from GUI | "Cannot remove your own account." |
| Remove last admin | "Cannot remove the last admin user." |
| Invalid scope name in GUI | "Invalid scope name. Use only letters, numbers, hyphens, and underscores." |

## 7. Security Considerations

- **Invite codes are single-use**: Once redeemed, the code is permanently marked as used
- **24-hour expiry**: Limits the window for code interception
- **Cryptographic randomness**: `crypto.randomBytes` for code generation (not Math.random)
- **Admin-only generation**: Only `is_admin: true` users can create codes
- **No enumeration**: Invalid codes and non-existent codes return the same error message
- **Atomic config writes**: Temp file + rename prevents partial writes on crash
- **GUI admin protection**: Cannot remove self or last admin from GUI

## 8. Verification Plan

1. **Unit tests**: InviteService (create, validate, redeem, expiry, cleanup), ConfigWriter (read-modify-write, atomic write), UserMutationService (register, remove, update), GUI routes (admin check, CRUD operations)
2. **Integration test**: Full flow — admin creates invite → share code → new user redeems → user is active → appears in GUI → admin toggles apps → admin removes user
3. **Manual testing**:
   - Create invite via `/invite TestUser` in Telegram
   - Open bot from another Telegram account, send `/start <code>`
   - Verify new user can use the bot immediately
   - Verify new user appears in GUI at `/gui/users`
   - Toggle app checkboxes, verify `pas.yaml` updates
   - Remove user, verify they can no longer message the bot
   - Restart PAS, verify all changes persisted
