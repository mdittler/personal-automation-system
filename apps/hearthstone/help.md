# Hearthstone — Food Management

Your household kitchen companion. Save recipes, plan meals, manage grocery lists, and more.

## Getting Started

First, set up your household so family members can share recipes and grocery lists:

- `/household create Family Kitchen` — create a household
- Share the join code with your partner
- `/household join ABC123` — join an existing household

## Recipes

### Saving Recipes
Just paste or describe a recipe and Hearthstone will parse and save it:

- Paste a full recipe from a website
- Describe one: "save a recipe for chicken stir fry with broccoli and soy sauce"
- New recipes start as drafts until you cook and rate them

### Searching Recipes
- `/recipes` — see all your saved recipes
- `/recipes chicken` — search by ingredient, title, or cuisine
- "find me easy dinner recipes"
- "show Italian recipes"

### Editing Recipes
- "add the tag 'weeknight' to the chicken stir fry"
- "change the servings on lasagna to 8"
- "update the prep time on banana bread to 15 minutes"

## Household

- `/household` — see household info and members
- `/household create <name>` — create a new household
- `/household join <code>` — join with a code
- `/household leave` — leave the household

## Grocery Lists

### Adding Items
- `/addgrocery milk, eggs, 2 lbs chicken` — quick-add items
- "add milk and eggs to grocery list" — natural language
- "we need bread" — shorthand

### Generating from Recipes
- "make grocery list for chicken stir fry" — auto-generates from recipe ingredients
- Staple items (salt, pepper, etc.) are excluded automatically
- Pantry items are excluded automatically

### Shopping Mode
- `/grocery` — view your list with tap-to-toggle checkboxes
- Tap any item to mark it as purchased (✅)
- Use 🔄 Refresh to see changes from other household members
- Use 🗑 Clear ✅ to remove purchased items
- Use 📦 → Pantry to move purchased items to your pantry

## Pantry

### Viewing
- `/pantry` — see what you have on hand
- "what's in the pantry"

### Adding Items
- "add eggs and milk to pantry" — manual addition
- Purchased grocery items can be moved to pantry automatically

### Removing Items
- "remove eggs from pantry"
- "we're out of milk"

## Meal Planning

### Viewing and Generating Plans
- `/mealplan` — show the current week's meal plan
- `/mealplan generate` — generate a new plan for the upcoming week
- "plan meals for this week" — natural language trigger

### Daily Planning
- "what's for dinner?" — shows tonight's planned meal with prep summary
- "swap Monday" — replace Monday's planned meal with a new suggestion
- "show [recipe name]" — show full details for a newly suggested recipe

### How Plans Are Generated
The meal planner considers:
- Your dietary preferences and restrictions
- In-season produce for your region
- Recent cooking history (avoids repetition)
- Cuisine variety across the week
- New-to-existing recipe ratio (configurable)

Plans auto-generate on a schedule (default: Sunday 9am, configurable in settings).

After a plan is generated, tap **🛒 Grocery List** to create a grocery list for the week's meals.

---

## "What Can I Make?"

Ask "what can I make?" and Hearthstone cross-references your pantry against your recipe library:

- **Ready to Cook** — you have all the ingredients on hand
- **Almost There** — recipes where you're only missing one or two items

Results are based on your current pantry inventory matched against saved recipes.

---

## Food Questions

Ask any cooking question:
- "what can I substitute for buttermilk?"
- "how long do I cook salmon at 400?"
- "is it safe to eat raw cookie dough?"
