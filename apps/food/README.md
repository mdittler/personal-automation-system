# Food

Household food management through your Telegram bot — recipes, meal planning, grocery lists, pantry tracking, cooking guidance, and family food intelligence.

## What it does

Food turns your Telegram bot into a kitchen companion for your entire household. Save recipes by pasting text or sending photos. Plan meals for the week with household voting. Generate grocery lists automatically from your meal plan and check off items in shopping mode. Track what's in your pantry and freezer, and ask "what can I make?" to find recipes that match what you have on hand. When it's time to cook, step through recipes hands-free with voice output. Track food costs by scanning receipts, and get weekly nutrition summaries.

Multiple household members share the same recipe library, meal plans, and grocery lists through a single bot.

## Key features

- **Recipe management** — save, search, edit, and scale recipes. Import by pasting text, sending a photo of a cookbook page, or describing what you want
- **Meal planning** — auto-generated weekly plans based on your preferences, with household voting to pick favorites
- **Grocery lists** — generated from meal plans, deduplicated, with shopping mode UI for checking off items at the store
- **Pantry and freezer tracking** — log what you have, get expiry alerts, and match pantry contents against recipes
- **Cook mode** — step-by-step recipe guidance with timers and optional hands-free voice output via Chromecast/Google Home
- **Photo recognition** — send photos of recipes, grocery receipts, pantry shelves, or handwritten shopping lists
- **Family features** — child food profiles, allergen introduction tracking, kid-friendly recipe adaptations
- **Cost tracking** — scan receipts to build a price database, get weekly/monthly/yearly budget reports
- **Leftovers and waste** — log leftovers with expiry tracking, reduce food waste with smart suggestions
- **Nutrition** — weekly macro summaries based on what you cook

## Getting started

1. **Create a household**: Send `/household create My Family` to your bot
2. **Invite members**: Other registered PAS users can join with `/household join`
3. **Save your first recipe**: Paste a recipe or send a photo of one — the app parses and saves it automatically
4. **Generate a meal plan**: Send `/mealplan` or say "plan meals for the week"

## Commands

| Command | Description |
|---------|-------------|
| `/recipes` | Browse and search your recipe library |
| `/mealplan` | View current meal plan or generate a new one |
| `/grocery` | View the current grocery list |
| `/addgrocery` | Quick-add items to the grocery list |
| `/pantry` | View or update pantry inventory |
| `/freezer` | View or update freezer inventory |
| `/cook` | Start cook mode for a recipe |
| `/leftovers` | Log or view current leftovers |
| `/hosting` | Plan a menu for hosting guests |
| `/foodbudget` | View food cost tracking and reports |
| `/nutrition` | View nutrition summaries and reports |
| `/whatsfordinner` | See what's planned for tonight |
| `/family` | Manage child profiles and food introduction tracking |
| `/household` | Create, join, or manage your household |

## Natural language

You don't need to memorize commands. Just talk to the bot:

- "Save a recipe for chicken stir fry" — saves the recipe
- "What's for dinner tonight?" — checks today's meal plan
- "Add milk, eggs, and bread to the grocery list" — adds items
- "What can I make with chicken and rice?" — searches recipes matching your pantry
- "Start cooking the pasta carbonara" — enters cook mode
- "How much protein did I have this week?" — shows nutrition summary
- "What's in the freezer?" — lists freezer contents

## Photos

Send a photo to the bot and it will automatically detect what it is:

| Photo type | What happens |
|------------|-------------|
| Recipe (cookbook page, recipe card) | Extracts ingredients, instructions, and saves the recipe |
| Grocery receipt | Extracts store, items, and prices for cost tracking |
| Pantry or fridge contents | Identifies items and adds them to inventory |
| Handwritten shopping list | Extracts items and adds them to your grocery list |

Add a caption like "save this recipe" or "receipt" to help classification, or just send the photo and let the AI figure it out.

## Automated schedules

The app runs these tasks automatically:

- **Weekly meal plan** — generated Sunday mornings based on your preferences
- **Vote finalization** — checks hourly for expired voting windows
- **Rating prompts** — asks what you cooked each evening at 8pm
- **Expiry alerts** — daily checks on pantry, freezer, and leftover freshness
- **Seasonal suggestions** — twice-monthly nudges for in-season produce
- **Nutrition summary** — weekly macro report on Sundays
- **Defrost reminders** — evening alerts if tomorrow's meals need frozen ingredients thawed

## Configuration

The app has 22 configurable settings including meal types, planning schedule, dietary preferences and restrictions, voting window duration, store preferences, seasonal nudges, child meal adaptation, and hands-free cooking defaults. Configure through the PAS management GUI.

## Detailed documentation

See [`help.md`](help.md) for comprehensive documentation of every feature, including detailed examples and all available options.
