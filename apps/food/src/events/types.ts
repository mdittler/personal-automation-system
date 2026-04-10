/**
 * Event payload types for the food app's EventBus emissions and subscriptions.
 *
 * Outbound payloads are plain objects so the WebhookService wrapping stays
 * structured (non-object payloads are wrapped as { value: rawData } — see
 * core/src/services/webhooks/index.ts:92-95).
 */

// ─── Outbound: food emits ──────────────────────────────────────────────────

export interface MealPlanFinalizedPayload {
	planId: string;
	weekStart: string;
	householdId: string;
	mealCount: number;
	finalizedAt: string; // ISO 8601
}

export interface GroceryListReadyPayload {
	listId: string;
	householdId: string;
	itemCount: number;
	source: 'recipes' | 'manual' | 'photo';
	generatedAt: string; // ISO 8601
}

export interface RecipeScheduledPayload {
	planId: string;
	recipeId: string;
	recipeTitle: string;
	date: string;     // YYYY-MM-DD
	mealType: string;
	householdId: string;
}

export interface MealCookedPayload {
	planId: string;
	recipeId: string;
	recipeTitle: string;
	date: string;     // YYYY-MM-DD
	mealType: string;
	householdId: string;
	cookedAt: string; // ISO 8601
}

export interface ShoppingCompletedPayload {
	listId: string;
	householdId: string;
	itemsPurchased: number;
	completedAt: string; // ISO 8601
}

// ─── Inbound: health/fitness apps subscribe contract ──────────────────────

/**
 * Standard payload emitted by any health/fitness PAS app as 'health:daily-metrics'.
 * All metric fields are optional — apps emit what they track.
 */
export interface HealthDailyMetricsPayload {
	userId: string;
	date: string; // YYYY-MM-DD
	metrics: {
		sleepHours?: number;
		weightKg?: number;
		restingHeartRate?: number;
		workoutMinutes?: number;
		workoutIntensity?: 'low' | 'moderate' | 'high';
		notes?: string;
		// energyLevel and mood removed — subjective signals belong in a future
		// fitness/health app (e.g. Garmin stress score). See CLAUDE.md deferred items.
	};
	source: string; // emitting app id, for provenance
}
