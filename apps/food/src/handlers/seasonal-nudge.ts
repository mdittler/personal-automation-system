/**
 * Seasonal nudge handler — bi-monthly scheduled job suggesting in-season produce and recipes.
 */

import type { CoreServices } from '@pas/core/types';
import { sanitizeInput } from '../utils/sanitize.js';
import { loadHousehold } from '../utils/household-guard.js';

export async function handleSeasonalNudgeJob(services: CoreServices): Promise<void> {
	// Check if seasonal nudges are enabled
	const enabled = await services.config.get<boolean>('seasonal_nudges');
	if (enabled === false) return;

	const sharedStore = services.data.forShared('shared');
	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const rawLocation = (await services.config.get<string>('location')) as string | undefined;
	const location = rawLocation ? sanitizeInput(rawLocation, 100) : undefined;
	const month = new Date().toLocaleDateString('en-US', { month: 'long' });

	const prompt = `You are a helpful food assistant. Suggest 3-4 fruits or vegetables that are currently in season${location ? ` in \`${location}\`` : ''} during ${month}.

For each item, suggest a simple recipe idea that features it as a main ingredient.

Format as a friendly, concise Telegram message. Use bullet points. Keep it brief and encouraging.`;

	try {
		const message = await services.llm.complete(prompt, { tier: 'fast' });

		for (const memberId of household.members) {
			await services.telegram.send(memberId, message);
		}
	} catch (err) {
		services.logger.error('Seasonal nudge job failed', err);
	}
}
