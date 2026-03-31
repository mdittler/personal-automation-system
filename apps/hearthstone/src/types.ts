/**
 * Domain types for the Hearthstone food management app.
 *
 * All types for the entire app are defined here — recipes, meal plans,
 * grocery lists, pantry, household, etc. Types are added as phases
 * are implemented.
 */

// ─── Recipe Types ────────────────────────────────────────────────

export interface Ingredient {
	name: string;
	quantity: number | null;
	unit: string | null;
	notes?: string;
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
