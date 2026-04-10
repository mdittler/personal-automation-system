/**
 * Domain types for the Food food management app.
 *
 * All types for the entire app are defined here — recipes, meal plans,
 * grocery lists, pantry, household, etc. Types are added as phases
 * are implemented.
 */

// Node timer globals — not in ES2024 lib, so we declare them here.
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;

// ─── Recipe Types ────────────────────────────────────────────────

export interface Ingredient {
	name: string;
	quantity: number | null;
	unit: string | null;
	notes?: string;
	/**
	 * Canonical lowercase singular form, computed at write time by
	 * `ingredient-normalizer.ts`. Optional only for backward compatibility
	 * with legacy data written before Phase H11.z — new writes MUST populate.
	 */
	canonicalName?: string;
}

export interface MacroData {
	calories?: number;
	protein?: number;
	carbs?: number;
	fat?: number;
	fiber?: number;
}

export interface Rating {
	userId: string;
	score: number; // 1–5
	date: string; // ISO date
	notes?: string;
}

export interface CookEvent {
	date: string; // ISO date
	cookedBy: string; // userId
	servings: number;
	notes?: string;
}

// ─── Cook Mode Types ────────────────────────────────────────────

export interface ScaledIngredient extends Ingredient {
	originalQuantity: number | null;
	scaledQuantity: number | null;
}

export interface CookSession {
	userId: string;
	recipeId: string;
	recipeTitle: string;
	currentStep: number; // 0-based index into instructions
	totalSteps: number;
	targetServings: number;
	originalServings: number;
	scaledIngredients: ScaledIngredient[];
	scalingNotes: string | null;
	instructions: string[];
	startedAt: number; // Date.now()
	lastActivityAt: number; // for 24h inactivity timeout
	lastMessageId: number | null; // for editMessage on button taps
	lastChatId: number | null;
	timerHandle?: ReturnType<typeof setTimeout>; // active setTimeout handle
	timerStepIndex?: number; // which step the timer was set for
	ttsEnabled?: boolean; // hands-free mode active
}

export type CookAction = 'next' | 'back' | 'repeat' | 'done';

export type RecipeStatus = 'draft' | 'confirmed' | 'archived';

export interface Recipe {
	id: string;
	title: string;
	source: string; // URL, book name, "homemade", "photo"
	sourcePhoto?: string; // path to original photo if saved from photo
	ingredients: Ingredient[];
	instructions: string[];
	servings: number;
	prepTime?: number; // minutes
	cookTime?: number; // minutes
	tags: string[];
	cuisine?: string;
	macros?: MacroData;
	ratings: Rating[];
	history: CookEvent[];
	householdNotes?: string;
	allergens: string[];
	kidAdaptation?: string;
	scalingNotes?: string;
	costEstimate?: number;
	childApprovals?: Record<string, 'approved' | 'rejected'>; // keyed by child slug
	status: RecipeStatus;
	createdAt: string; // ISO date
	updatedAt: string; // ISO date
}

// ─── Household Types ─────────────────────────────────────────────

export interface Household {
	id: string;
	name: string;
	createdBy: string; // userId
	members: string[]; // userIds
	joinCode: string;
	createdAt: string; // ISO date
}

// ─── Meal Plan Types ─────────────────────────────────────────────

export interface PlannedMeal {
	recipeId: string;
	recipeTitle: string;
	date: string; // ISO date
	mealType: string; // "dinner", "lunch", etc.
	assignedTo?: string; // userId
	votes: Record<string, 'up' | 'down' | 'neutral'>;
	cooked: boolean;
	rated: boolean;
	isNew: boolean; // true = LLM suggestion, not from recipe library
	description?: string; // brief description for new suggestions
}

export interface MealPlan {
	id: string;
	startDate: string;
	endDate: string;
	meals: PlannedMeal[];
	status: 'draft' | 'voting' | 'active' | 'completed';
	createdAt: string;
	updatedAt: string;
	votingStartedAt?: string; // ISO datetime — set when plan enters voting status
	lastRatingPromptDate?: string; // ISO date (YYYY-MM-DD) — idempotency for nightly prompt
}

// ─── Grocery Types ───────────────────────────────────────────────

export interface GroceryItem {
	name: string;
	quantity: number | null;
	unit: string | null;
	department: string;
	recipeIds: string[]; // which recipes need this item
	purchased: boolean;
	addedBy: string; // userId or 'system'
	/**
	 * Canonical lowercase singular form (Phase H11.z). Optional for
	 * backward compatibility with legacy data.
	 */
	canonicalName?: string;
}

export interface GroceryList {
	id: string;
	items: GroceryItem[];
	createdAt: string;
	updatedAt: string;
}

// ─── Pantry / Freezer Types ─────────────────────────────────────

export interface PantryItem {
	name: string;
	quantity: string; // freeform: "2 cans", "about 1 lb"
	addedDate: string;
	expiryEstimate?: string; // ISO date, LLM-estimated
	category: string; // produce, dairy, meat, etc.
	/**
	 * Canonical lowercase singular form (Phase H11.z). Optional for
	 * backward compatibility with legacy data.
	 */
	canonicalName?: string;
}

export interface FreezerItem {
	name: string;
	quantity: string;
	frozenDate: string;
	source?: string; // recipe name or "purchased"
}

// ─── Leftover Types ──────────────────────────────────────────────

export interface Leftover {
	name: string;
	quantity: string;
	fromRecipe?: string;
	storedDate: string;
	expiryEstimate: string;
	status: 'active' | 'used' | 'frozen' | 'wasted';
}

// ─── Waste Log Types ────────────────────────────────────────────

export interface WasteLogEntry {
	name: string;
	quantity: string;
	reason: 'expired' | 'spoiled' | 'discarded';
	source: 'leftover' | 'pantry' | 'freezer';
	date: string; // ISO date
}

// ─── Recipe Search Types ─────────────────────────────────────────

export interface RecipeSearchQuery {
	text?: string;
	tags?: string[];
	cuisine?: string;
	minRating?: number;
	maxDaysSinceCooked?: number;
	minProtein?: number;
	limit?: number;
}

export interface RecipeSearchResult {
	recipe: Recipe;
	relevance: string; // description of why this matched
}

// ─── LLM Parsed Types ───────────────────────────────────────────

export interface ParsedRecipe {
	title: string;
	source: string;
	ingredients: Ingredient[];
	instructions: string[];
	servings: number;
	prepTime?: number;
	cookTime?: number;
	tags: string[];
	cuisine?: string;
	macros?: MacroData;
	allergens: string[];
}

export interface RecipeEditRequest {
	field: string;
	value: unknown;
	description: string;
}

// ─── Receipt / Cost Types (H8) ──────────────────────────────────

export interface ReceiptLineItem {
	name: string;
	quantity: number;
	unitPrice: number | null;
	totalPrice: number;
}

export interface Receipt {
	id: string;
	store: string;
	date: string; // ISO date
	lineItems: ReceiptLineItem[];
	subtotal: number | null;
	tax: number | null;
	total: number;
	photoPath: string; // path to original photo in data store
	capturedAt: string; // ISO datetime
}

// ─── Cost Tracking Types (H10) ─────────────────────────────────

export interface PriceEntry {
	name: string; // normalized item name, e.g. "Eggs (60ct)"
	price: number; // dollar amount
	unit: string; // package unit, e.g. "60ct", "1 gal", "5 lb"
	department: string; // Dairy, Produce, Meat, Pantry, etc.
	updatedAt: string; // ISO date of last update
}

export interface StorePriceData {
	store: string; // display name, e.g. "Costco"
	slug: string; // file-safe name, e.g. "costco"
	lastUpdated: string; // ISO date
	items: PriceEntry[];
}

export interface IngredientCost {
	ingredientName: string; // from recipe, e.g. "2 cups AP flour"
	matchedItem: string | null; // from price DB, e.g. "AP flour (25 lb)"
	matchedPrice: number | null; // full package price
	matchedUnit: string | null; // package unit
	portionCost: number; // cost for the recipe's quantity
	isEstimate: boolean; // true if LLM-estimated (no price DB match)
}

export interface MealCostEstimate {
	recipeId: string;
	recipeTitle: string;
	store: string; // which store's prices were used
	ingredientCosts: IngredientCost[];
	totalCost: number; // sum of portionCost
	perServingCost: number; // totalCost / servings
	servings: number;
	estimatedAt: string; // ISO datetime
}

export interface CostHistoryWeek {
	weekId: string; // "2026-W15"
	startDate: string; // ISO date
	endDate: string; // ISO date
	meals: Array<{
		date: string;
		recipeTitle: string;
		cost: number;
		perServing: number;
	}>;
	totalCost: number;
	avgPerMeal: number;
	avgPerServing: number;
	mealCount: number;
}

export interface CostHistoryMonth {
	monthId: string; // "2026-04"
	weeks: Array<{
		weekId: string;
		totalCost: number;
		mealCount: number;
	}>;
	totalCost: number;
	avgPerMeal: number;
	avgPerServing: number;
	mealCount: number;
}

// ─── Batch Cooking Types (H7) ───────────────────────────────────

export interface SharedPrepTask {
	task: string;
	recipes: string[];
	estimatedMinutes: number;
}

export interface BatchAnalysis {
	sharedTasks: SharedPrepTask[];
	totalPrepMinutes: number;
	estimatedSavingsMinutes: number;
	freezerFriendlyRecipes: string[];
}

export interface CuisineClassification {
	recipe: string;
	cuisine: string;
}

// ─── Family / Child Types (H9) ─────────────────────────────────

export type AllergenStage = 'pre-solids' | 'early-introduction' | 'expanding' | 'established';

export interface ChildProfile {
	name: string;
	slug: string;
	birthDate: string; // ISO date
	allergenStage: AllergenStage;
	knownAllergens: string[];
	avoidAllergens: string[];
	dietaryNotes: string;
	createdAt: string; // ISO datetime
	updatedAt: string; // ISO datetime
}

export interface FoodIntroduction {
	food: string;
	allergenCategory: string | null; // Big 9 or null for non-allergenic
	date: string; // ISO date
	reaction: 'none' | 'mild' | 'moderate' | 'severe';
	accepted: boolean;
	notes: string;
}

export interface ChildFoodLog {
	profile: ChildProfile;
	introductions: FoodIntroduction[];
}

export interface KidAdaptation {
	childName: string;
	originalRecipeId: string;
	setAsideBefore: string[];
	textureGuidance: string[];
	allergenFlags: string[];
	portionGuidance: string;
	generalNotes: string;
}

// ─── Nutrition / Macro Types (H11) ────────────────────────────────

export interface MacroTargets {
	calories?: number;
	protein?: number; // grams
	carbs?: number; // grams
	fat?: number; // grams
	fiber?: number; // grams
}

export type EstimationKind = 'recipe' | 'quick-meal' | 'llm-ad-hoc' | 'manual';

export interface QuickMealTemplate {
	id: string;                  // slugified label
	userId: string;
	label: string;
	kind: 'home' | 'restaurant' | 'other';
	ingredients: string[];       // free text, one per line
	notes?: string;
	estimatedMacros: MacroData;  // LLM-computed at save time
	confidence: number;          // 0.0-1.0
	llmModel: string;            // audit trail (model id)
	usdaCrossCheck?: {
		calories: number;
		matchedIngredients: number;
		totalIngredients: number;
	};
	usageCount: number;
	lastUsedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface MealMacroEntry {
	recipeId: string;
	recipeTitle: string;
	mealType: string; // dinner, lunch, etc.
	servingsEaten: number;
	macros: MacroData;
	// H11.w additions (all optional — back-compat with existing entries)
	estimationKind?: EstimationKind;
	confidence?: number;
	sourceId?: string; // recipe id, quick-meal id, or undefined for manual/ad-hoc
}

export interface DailyMacroEntry {
	date: string; // ISO date YYYY-MM-DD
	meals: MealMacroEntry[];
	totals: MacroData;
}

export interface MonthlyMacroLog {
	month: string; // YYYY-MM
	userId: string;
	days: DailyMacroEntry[];
}

export interface MacroProgress {
	current: MacroData;
	targets: MacroTargets;
	period: string; // "today", "this week", "2026-04"
	daysTracked: number;
	dailyAverage: MacroData;
	adherence?: MacroAdherence;
}

export interface MacroFieldAdherence {
	daysTracked: number; // days where the target was set AND the day had any data
	daysHit: number; // days within ±tolerance of target
	percentHit: number; // 0–100, rounded
	currentStreak: number; // consecutive hits ending at the most recent day
	longestStreak: number; // longest consecutive-hit run in the period
}

export interface MacroAdherence {
	calories?: MacroFieldAdherence;
	protein?: MacroFieldAdherence;
	carbs?: MacroFieldAdherence;
	fat?: MacroFieldAdherence;
	fiber?: MacroFieldAdherence;
}

// ─── Guest Profile Types (H11) ────────────────────────────────────

export interface GuestProfile {
	name: string;
	slug: string;
	dietaryRestrictions: string[];
	allergies: string[];
	notes?: string;
	createdAt: string;
	updatedAt: string;
}

// ─── Hosting / Event Types (H11) ──────────────────────────────────

export interface EventMenuItem {
	recipeTitle: string;
	recipeId?: string;
	scaledServings: number;
	dietaryNotes: string[];
	/**
	 * Inline ingredient list the LLM may provide for dishes not in the recipe library.
	 * Uses the same structured shape as recipe ingredients so the pantry-subtract
	 * and display-formatting paths can be shared between library and novel dishes.
	 */
	ingredients?: Ingredient[];
}

export interface PrepTimelineStep {
	time: string; // relative time like "T-3h", "T-1h", "T-15min"
	task: string;
	recipe?: string;
}

export interface EventPlan {
	description: string;
	eventTime: string; // ISO datetime
	guestCount: number;
	guests: GuestProfile[];
	menu: EventMenuItem[];
	prepTimeline: PrepTimelineStep[];
	deltaGroceryItems: string[];
	timelineError?: string; // populated if the prep-timeline LLM call failed
}

// ─── Cultural Calendar Types (H12b) ─────────────────────────────

export interface FixedDateRule {
	type: 'fixed';
	month: number; // 1-12
	day: number;
}

export interface NthWeekdayDateRule {
	type: 'nthWeekday';
	month: number;   // 1-12
	weekday: number; // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
	n: number;       // 1-based occurrence (4 = 4th occurrence)
}

export interface EasterDateRule {
	type: 'easter';
	offset?: number; // days offset from Easter (e.g. -47 for Mardi Gras)
}

export interface TableDateRule {
	type: 'table';
	dates: Record<number, string>; // year → "MM-DD"
}

export type HolidayDateRule = FixedDateRule | NthWeekdayDateRule | EasterDateRule | TableDateRule;

export interface Holiday {
	id: string;
	name: string;
	dateRule: HolidayDateRule;
	cuisine: string;
	traditionalFoods: string[];
	region: string;
	enabled: boolean;
}

export interface CulturalCalendar {
	holidays: Holiday[];
}
