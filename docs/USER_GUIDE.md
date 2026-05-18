# PAS User Guide

PAS is a personal automation system you use through a Telegram bot. Most day-to-day work happens in Telegram; the management GUI is for configuration, data browsing, and admin tasks.

## Getting Started

1. Open the PAS bot in Telegram.
2. Send `/help` to see the commands available to you.
3. Send a normal message, command, or photo.

If the bot says you are not registered, ask an admin for an invite code. Send either `/start <code>` or the raw 8-character code to the bot. Invite codes can only be used once and expire after 24 hours.

## Sending Messages

You can talk to PAS in three ways.

### Slash Commands

Use commands when you know exactly what you want:

```text
/help
/ask what apps do I have?
/recipes chicken
/mealplan
```

`/help` lists the commands your account can use, including commands from installed apps.

### Natural Language

You can also write normally. PAS classifies the message and sends it to the best app.

```text
Save a recipe for chicken stir fry
What's for dinner tonight?
Remind me to call the vet
What's the weather like?
```

If PAS is unsure, it may ask you to choose the right app.

### Photos

Send a photo when the thing you want to process is visual. A short caption helps PAS route it correctly.

```text
[cookbook page] save this recipe
[grocery receipt]
[fridge photo] what can I make with this?
```

If multiple apps can handle the photo and the intent is unclear, send the photo again with a caption.

## How Routing Works

PAS handles messages in this order:

1. Commands go to the app that owns the command.
2. Photos are classified and routed to a photo-capable app.
3. Normal text is classified and routed to the best app.
4. If no app matches, the chatbot answers as the fallback.

App access is per user. If a command or feature is missing from `/help`, your account may not have that app enabled.

## Chatbot and `/ask`

The built-in chatbot answers general questions when no app matches. It keeps a short conversation history for each user.

Use `/ask` for questions about PAS itself:

```text
/ask what apps do I have?
/ask what commands can I use?
/ask how does meal planning work?
/ask show my recent activity
```

Admins may see more system-level information than regular users.

### Searching Past Conversations

Use `/recall <query>` to search your conversation history:

```text
/recall pasta carbonara
/recall what did we discuss about grocery lists
/recall school lunch ideas
```

Results show the session title, date, full session ID, and relevant snippets. The search includes your current active session.

### Session-Search Tool (automatic)

The chatbot can also search past conversations mid-reply when it decides extra context would help. This fires automatically when you ask about something from a previous session (e.g. "what did we decide about pasta last time?"). You can toggle this behavior:

- **Turn off:** Tell the chatbot "turn off session search" or visit the GUI config page and set `session_search_tool_enabled` to false.
- **Turn on:** Tell the chatbot "turn on session search" or toggle it back in the GUI.

When the tool fires, the chatbot makes one additional LLM call to incorporate search results, then delivers a single response.

### Chatbot Configuration

| Config key | Default | What it does |
| --- | --- | --- |
| `auto_detect_pas` | on | Switches to the app-aware prompt for PAS-related questions |
| `log_to_notes` | off | Saves every chat message to your daily notes |
| `flush_memory_on_idle_reset` | off | Summarizes the session into memory when idle reset fires |
| `session_search_tool_enabled` | on | Lets the chatbot search past conversations mid-reply |

Use `/ask` or tell the chatbot to change a setting (e.g. "turn off chat logging"), or edit it in the GUI config page.

## Shared Spaces

Spaces let a group work on shared data instead of personal data. For example, a family can share a grocery list or a project group can share notes.

| Command | What it does |
| --- | --- |
| `/space` | Show your current mode and spaces |
| `/space <id>` | Enter a space |
| `/space off` | Return to personal mode |
| `/space create <id> <name>` | Create a space |
| `/space invite <id> <username>` | Add a registered user by name |
| `/space members <id>` | List space members |

When you are in a space, supported apps read and write that space's shared data. Use `/space off` to return to your personal data.

## Management GUI

Open the GUI at `http://<your-server>:3000/gui` and sign in with your display name or Telegram user ID, plus your GUI password. Display names are globally unique and case-insensitive; the Telegram user ID remains the canonical internal identifier.

### First Admin Password Setup

On a new or migrated single-admin install, use the `GUI_AUTH_TOKEN` from `.env` only as a bootstrap/recovery token:

1. Open `http://<your-server>:3000/gui/login`.
2. Expand **Single-admin install? Use authentication token**.
3. Enter `GUI_AUTH_TOKEN`.
4. PAS sends you to **Account**, where you can set your GUI password.
5. After that, log in with your display name or Telegram user ID, plus your password.

If a stale browser session keeps showing 403, clear site data/cookies for the PAS host and log in again.

If you are locked out of the GUI, an operator with filesystem access can reset a password from the project directory:

```bash
pnpm auth:set-password --user-id <telegram-user-id>
```

The command prompts for the new password and stores only the hashed credential in `data/system/credentials.yaml`.

Use it to:

- View users and adjust their app access
- Reset GUI passwords for users
- Add or remove space access for users
- Browse data files
- View schedules, reports, alerts, and LLM cost tracking
- Edit app and system settings exposed by the GUI

The GUI writes user app access and space membership changes back to `config/pas.yaml`.

## Admin: Add a New User

The preferred flow is invite-based registration through Telegram:

1. In Telegram, send `/invite <name>` to the PAS bot.
2. Copy the invite code from the bot's reply.
3. Send the code to the new user.
4. Ask them to send `/start <code>` to the PAS bot. Sending the raw code also works.
5. After they register, open the GUI Users page and adjust their enabled apps or space access if needed.

New invite-registered users are created as non-admin users with all apps enabled and no shared spaces. Registration is saved to `config/pas.yaml`.

To make the new user an admin, edit `config/pas.yaml`, set `is_admin: true` for that user, and restart PAS. Admin promotion is not currently exposed in the GUI.

Manual registration is also possible by editing `config/pas.yaml` directly:

```yaml
users:
  - id: "123456789"
    name: "New User"
    is_admin: false
    enabled_apps: ["*"]
    shared_scopes: []
```

Use the person's Telegram user ID, not their username. They can find it by messaging `@userinfobot`, or you can check PAS logs after they message the bot. Restart PAS after manual edits.

## Admin: Manage Users

In the GUI Users page, admins can:

- Toggle which apps a user can access
- Add or remove a user from existing spaces
- Reset a user's GUI password
- Remove users

The GUI prevents removing the only admin. Keep at least one admin account with working Telegram and GUI access.

## Scheduled Automation

Apps can run scheduled jobs without a user message. For example, the Food app may send meal plan reminders, expiry alerts, rating prompts, or nutrition summaries.

Schedules are configured by apps and can be viewed in the GUI. Scheduled messages arrive in Telegram from the same PAS bot.

## Data and Obsidian

PAS stores data as markdown, YAML, and related files on disk. You can browse these files through the GUI or point Obsidian at the data directory.

Common locations:

- Personal data: `data/users/<user-id>/<app-id>/`
- Shared app data: `data/users/shared/<app-id>/`
- Space data: `data/spaces/<space-id>/<app-id>/`
- System data: `data/system/`

Prefer using PAS or the GUI for changes when possible. If you edit files directly, keep the existing file format intact.

## Tips

- Use `/help` first when you are unsure what is available.
- Add captions to photos, especially receipts, recipes, pantry photos, or ambiguous images.
- Use `/ask` for questions about PAS, installed apps, commands, and recent activity.
- Use spaces only when you want shared data; personal mode is the default.
- If a feature is missing, ask an admin to check your enabled apps in the GUI.
