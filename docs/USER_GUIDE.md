# PAS User Guide

Everything you do in PAS happens through your Telegram bot. This guide covers how to interact with the system and what it can do for you.

## Sending messages

There are three ways to communicate with PAS:

### Slash commands

Type `/` followed by a command name to trigger a specific action. Each app provides its own commands.

```
/help                    Show all available commands
/ask what apps do I have?    Ask the PAS assistant a question
/recipes chicken             Search recipes for "chicken"
/mealplan                    View the current meal plan
```

Use `/help` to see every command available to you.

### Natural language

Just type what you want in plain English. PAS uses AI to figure out which app should handle your message and routes it automatically.

```
"Save a recipe for chicken stir fry"       → Food app
"What's for dinner tonight?"                → Food app
"Remind me to call the vet"                 → Notes app (if configured)
"What's the weather like?"                  → Chatbot fallback
```

You don't need to think about which app handles what — just say what you need.

### Photos

Send a photo and PAS classifies it and routes to the right app. Adding a caption helps with classification but isn't required.

```
[photo of a cookbook page] + "save this recipe"    → Extracts and saves the recipe
[photo of a grocery receipt]                       → Extracts items and prices
[photo of your fridge]  + "what's in my fridge"    → Identifies items for inventory
```

If multiple apps handle photos and PAS can't determine which one you mean, it will ask you to add a caption.

## How routing works

PAS processes your messages in this order:

1. **Commands** — if your message starts with `/`, it goes directly to the app that owns that command
2. **Photos** — if you send a photo, it's classified by type and routed to the matching app
3. **Natural language** — for regular text, AI classification determines the best app
4. **Fallback** — if no app matches, the built-in chatbot responds as a general-purpose AI assistant

## The chatbot and /ask

When no app matches your message, PAS has a built-in conversational AI chatbot. It maintains conversation history (up to 20 turns per user) and can answer general questions.

The `/ask` command is special — it gives the chatbot awareness of your entire PAS system:

```
/ask what apps do I have?
/ask how does meal planning work?
/ask what commands can I use?
/ask show my recent activity
```

Use `/ask` when you want help understanding PAS itself.

## Shared data spaces

Spaces let you share data with specific people. For example, share a grocery list with your family or project notes with a group.

| Command | Description |
|---------|-------------|
| `/space` | Show your current mode and list your spaces |
| `/space <id>` | Enter a shared space |
| `/space off` | Return to personal mode |
| `/space create <id> <name>` | Create a new space |
| `/space invite <id> <username>` | Add a member |
| `/space members <id>` | List members |

When you're in a space, your messages operate on shared data within that space instead of your personal data.

## Scheduled automation

Apps can run tasks on a schedule without you doing anything. For example, the Food app automatically:

- Generates weekly meal plans on Sunday mornings
- Sends rating prompts each evening
- Alerts you when pantry items are approaching expiry
- Sends weekly nutrition summaries

You'll receive these as Telegram messages from your bot at the scheduled times. Schedules are configured per-app and can be viewed in the management GUI.

## Per-user settings

Each app can offer configurable settings (dietary preferences, notification timing, default behaviors, etc.). Configure these through the **management GUI** at `http://<your-server>:3000/gui`.

The GUI also lets you:

- Browse and manage your data files
- View LLM cost tracking and model configuration
- Manage shared spaces and members
- View and edit app configurations

## Multi-user

Multiple Telegram users can share the same PAS instance. Each user has:

- Their own data directory (isolated from other users)
- Their own app configurations and preferences
- Their own conversation history with the chatbot
- Access to shared data through spaces or app-level sharing (like the Food app's household feature)

Users are registered by a system administrator through the configuration file.

## Obsidian integration

All PAS data is stored as markdown and YAML files on disk. If you use Obsidian, you can point a vault at your data directory and browse, search, and link to your data directly. Space data appears under `_spaces/` and shared data under `_shared/`.

## Tips

- **Captions on photos** help classification — "save this recipe" or "receipt" gives PAS a strong hint
- **"What can I make?"** searches recipes matching your current pantry inventory
- **`/ask`** is your go-to for system questions — it knows about all installed apps and their capabilities
- **You can mix commands and natural language** — use whatever feels natural in the moment
- **Spaces** are optional — most features work fine in personal mode
