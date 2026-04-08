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

### Voting on Plans

When a household has multiple members, generated plans enter a voting phase:

- Each meal is sent as a separate message with 👍 / 👎 / 😐 buttons
- All household members can vote on each meal
- After the voting window (default: 12 hours), the plan is finalized
- Downvoted meals are automatically replaced with new suggestions
- If everyone votes before the window expires, finalization happens immediately
- Not voting counts as neutral — no negative signal

### Rating Meals

Every evening at 8pm, you'll get a "What did you cook tonight?" message:

- Tap the meal you cooked
- Rate it 👍 or 👎 (or skip)
- Positive ratings help the planner suggest it again in future weeks
- New recipes that get a 👍 are automatically confirmed into your recipe library
- You can also mark meals as cooked from the `/mealplan` view using the ✅ buttons

### Shopping Follow-up

After you clear purchased items from your grocery list, if items remain:

- You'll get a follow-up message after 1 hour
- Choose "Clear remaining" to empty the list, or "Keep for next trip" to leave items

---

## "What Can I Make?"

Ask "what can I make?" and Hearthstone cross-references your pantry against your recipe library:

- **Ready to Cook** — you have all the ingredients on hand
- **Almost There** — recipes where you're only missing one or two items

Results are based on your current pantry inventory matched against saved recipes.

---

## Photos

Send a photo to Hearthstone and it will automatically detect what it is:

### Recipe Photos
- Send a photo of a cookbook page, handwritten recipe card, or recipe screenshot
- Add a caption like "save this recipe" for faster processing
- Hearthstone extracts the full recipe (ingredients, instructions, servings, etc.)
- Both the original photo and parsed recipe are saved
- "show me the photo of the lasagna" — retrieve a specific recipe's original photo
- "show me recipe photos" — see a list of all recipes with photos to choose from

### Grocery Receipt Photos
- Send a photo of your grocery receipt
- Add a caption like "receipt" or "grocery receipt"
- Hearthstone extracts the store name, line items, and total
- Receipt data is stored for future cost tracking

### Pantry Photos
- Send a photo of your pantry, fridge, or freezer contents
- Add a caption like "what's in my fridge"
- Hearthstone identifies items and adds them to your pantry inventory

### Grocery List Photos
- Send a photo of a handwritten shopping list or recipe
- Add a caption like "add these to grocery list"
- Items are extracted and added to your grocery list
- If it's a recipe photo, Hearthstone offers to save the recipe too

---

## Family Features

Manage child profiles, adapt recipes for little ones, and track food introductions safely.

### Child Profiles
- `/family` — list all registered children
- `/family add Margot 2024-06-15` — add a child with name and birth date
- `/family margot` — view a child's profile and recent food log
- `/family remove Margot` — remove a child profile

### Kid-Friendly Recipe Adaptations
Ask Hearthstone to adapt any recipe for your child:
- "make this for Margot" — adapt the last viewed recipe
- "kid friendly version" — generic adaptation
- "how do I adapt the chili for the baby?" — specify recipe and child

Adaptations include:
- What to set aside before adding spice/heat
- Chopping and texture guidance for their age
- Allergen flags based on the child's avoid list
- Age-appropriate portion sizes

### Food Introduction Tracker
Track new foods as your baby starts solids:
- "Margot tried peanut butter today" — log a new food
- "introduced eggs to Margot" — log with allergen detection
- "gave baby yogurt for the first time" — natural phrasing

Hearthstone automatically:
- Detects if the food is a common allergen (FDA Big 9)
- Warns if you're introducing a new allergen too soon (configurable wait period, default 3 days)
- Maintains a history of introduced foods and reactions

### Child Approval Tagging
Track which recipes your children enjoy:
- Use the 👍/👎 buttons when viewing a recipe to tag it per child
- Kid-approved recipes are weighted higher in future meal plan generation

---

## Food Questions

Ask any cooking question:
- "what can I substitute for buttermilk?"
- "how long do I cook salmon at 400?"
- "is it safe to eat raw cookie dough?"

---

## Cost Tracking

Hearthstone tracks food costs from your grocery receipts and estimates meal costs.

### Price Database
Prices are automatically captured from receipt photos and stored per store:
- Send a grocery receipt photo — prices are extracted and saved automatically
- "eggs are $3.50 at costco" — manually update a price
- "update milk price to $4.29 at kroger" — update specific items
- Prices are stored in Obsidian-compatible files you can edit manually

### Budget Reports
- `/foodbudget` — see this week's meal costs and spending
- `/foodbudget month` — monthly spending summary with trends
- `/foodbudget year` — year-in-review with monthly totals
- "how much did we spend on food?" — natural language budget query

### Cost Annotations
When price data is available:
- Meal plans show estimated total cost and average per meal
- If a plan is significantly more expensive than recent weeks, you'll see a budget alert with swap suggestions
- Grocery lists show estimated totals when `show_price_estimates` is enabled in settings

### Settings
- `default_store` — which store's prices to use for estimates
- `show_price_estimates` — show price annotations on grocery lists (off by default)
- `preferred_stores` — your preferred stores for comparison
