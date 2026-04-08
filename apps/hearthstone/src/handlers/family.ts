/**
 * Family handler — /family command, intent handlers, callback handlers.
 *
 * Orchestrates child profile management, kid-friendly recipe adaptations,
 * food introduction logging, and child approval tagging.
 */

import type { CoreServices, InlineButton, ScopedDataStore } from '@pas/core/types';
import { classifyLLMError } from '@pas/core/utils/llm-errors';
import {
	computeAgeMonths,
	deleteChildProfile,
	formatChildProfile,
	loadAllChildren,
	loadChildProfile,
	parseBirthDate,
	saveChildProfile,
	slugifyChildName,
} from '../services/family-profiles.js';
import {
	addFoodIntroduction,
	checkAllergenWaitWindow,
	formatAllergenWarning,
	matchAllergenCategory,
} from '../services/child-tracker.js';
import { generateKidAdaptation, formatKidAdaptation } from '../services/kid-adapter.js';
import { findRecipeByTitle, loadRecipe, updateRecipe } from '../services/recipe-store.js';
import { isoNow, todayDate } from '../utils/date.js';
import type { ChildFoodLog, ChildProfile, FoodIntroduction, Recipe } from '../types.js';

// ─── Pending confirmation state (5-min TTL) ─────────────────────

const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingRemoval = new Map<string, { slug: string; expiresAt: number }>();

function setPendingRemoval(userId: string, slug: string): void {
	pendingRemoval.set(userId, { slug, expiresAt: Date.now() + PENDING_TTL_MS });
	if (pendingRemoval.size > 100) {
		const oldest = pendingRemoval.keys().next().value;
		if (oldest) pendingRemoval.delete(oldest);
	}
}

function consumePendingRemoval(userId: string): string | undefined {
	const entry = pendingRemoval.get(userId);
	pendingRemoval.delete(userId);
	if (!entry || Date.now() > entry.expiresAt) return undefined;
	return entry.slug;
}

// ─── /family Command ─────────────────────────────────────────────

export async function handleFamilyCommand(
	services: CoreServices,
	args: string[],
	userId: string,
	store: ScopedDataStore,
): Promise<{ text: string; buttons?: InlineButton[][] }> {
	const subcommand = args[0]?.toLowerCase();

	if (!subcommand) {
		// List all children
		const children = await loadAllChildren(store);
		if (children.length === 0) {
			return {
				text: 'No children registered yet.\n\nUse `/family add <name> <birthdate>` to add a child.\nExample: `/family add Margot June 15 2024`',
			};
		}
		const today = todayDate(services.timezone);
		return {
			text: children.map((c) => formatChildProfile(c, today)).join('\n\n---\n\n'),
		};
	}

	if (subcommand === 'add') {
		const name = args[1];
		const dateInput = args.slice(2).join(' ');
		if (!name || !dateInput) {
			return {
				text: 'Usage: `/family add <name> <birthdate>`\n\nExamples:\n• `/family add Margot June 15 2024`\n• `/family add Oliver 6/15/2024`\n• `/family add Emma 2024-06-15`',
			};
		}

		const birthDate = parseBirthDate(dateInput);
		if (!birthDate) {
			return {
				text: `I couldn't understand "${dateInput}" as a date.\n\nTry formats like: June 15 2024, 6/15/2024, or 2024-06-15`,
			};
		}

		const slug = slugifyChildName(name);
		const now = isoNow();
		const profile: ChildProfile = {
			name,
			slug,
			birthDate,
			allergenStage: 'pre-solids',
			knownAllergens: [],
			avoidAllergens: [],
			dietaryNotes: '',
			createdAt: now,
			updatedAt: now,
		};

		await saveChildProfile(store, { profile, introductions: [] });
		return {
			text: `Added child profile for **${name}** (born ${birthDate}).\n\nUse \`/family ${slug}\` to view or \`/family edit ${slug}\` to update allergen info.`,
		};
	}

	if (subcommand === 'remove') {
		const name = args[1];
		if (!name) {
			return { text: 'Usage: `/family remove <name>`' };
		}
		const slug = slugifyChildName(name);
		const log = await loadChildProfile(store, slug);
		if (!log) {
			return { text: `Child "${name}" not found.` };
		}
		// Show confirmation with buttons
		setPendingRemoval(userId, slug);
		return {
			text: `Remove **${log.profile.name}**'s profile and food log? This will archive the data.`,
			buttons: [
				[
					{ text: '🗑 Yes, remove', callbackData: `app:hearthstone:fa:rm:${slug}` },
					{ text: '❌ Cancel', callbackData: 'app:hearthstone:fa:rm-cancel' },
				],
			],
		};
	}

	if (subcommand === 'edit') {
		return await handleFamilyEdit(services, args.slice(1), store);
	}

	// View a specific child by slug
	const slug = slugifyChildName(subcommand);
	const log = await loadChildProfile(store, slug);
	if (!log) {
		return { text: `Child "${subcommand}" not found. Use \`/family\` to list all children.` };
	}
	const today = todayDate(services.timezone);
	return {
		text: formatChildProfile(log, today),
		buttons: buildProfileEditButtons(slug),
	};
}

// ─── /family edit ────────────────────────────────────────────────

async function handleFamilyEdit(
	services: CoreServices,
	args: string[],
	store: ScopedDataStore,
): Promise<{ text: string }> {
	const nameOrSlug = args[0];
	const field = args[1]?.toLowerCase();
	const value = args.slice(2).join(' ');

	if (!nameOrSlug) {
		return {
			text: 'Usage: `/family edit <name> <field> <value>`\n\n' +
				'Fields:\n' +
				'• `stage` — pre-solids, early-introduction, expanding, established\n' +
				'• `safe` — add a safe allergen (e.g., `safe milk`)\n' +
				'• `avoid` — add an allergen to avoid (e.g., `avoid peanuts`)\n' +
				'• `notes` — update dietary notes\n' +
				'• `unsafe` — remove a safe allergen\n' +
				'• `ok` — remove an avoid allergen',
		};
	}

	const slug = slugifyChildName(nameOrSlug);
	const log = await loadChildProfile(store, slug);
	if (!log) {
		return { text: `Child "${nameOrSlug}" not found.` };
	}

	if (!field || !value) {
		return {
			text: 'What would you like to update?\n\n' +
				'• `/family edit ' + slug + ' stage early-introduction`\n' +
				'• `/family edit ' + slug + ' safe milk`\n' +
				'• `/family edit ' + slug + ' avoid peanuts`\n' +
				'• `/family edit ' + slug + ' notes Prefers soft textures`',
		};
	}

	const VALID_STAGES = ['pre-solids', 'early-introduction', 'expanding', 'established'] as const;
	const profile = log.profile;

	switch (field) {
		case 'stage': {
			if (!VALID_STAGES.includes(value as any)) {
				return { text: `Invalid stage. Choose: ${VALID_STAGES.join(', ')}` };
			}
			profile.allergenStage = value as typeof VALID_STAGES[number];
			break;
		}
		case 'safe': {
			const allergen = value.toLowerCase();
			if (!profile.knownAllergens.includes(allergen)) {
				profile.knownAllergens.push(allergen);
			}
			profile.avoidAllergens = profile.avoidAllergens.filter((a) => a !== allergen);
			break;
		}
		case 'avoid': {
			const allergen = value.toLowerCase();
			if (!profile.avoidAllergens.includes(allergen)) {
				profile.avoidAllergens.push(allergen);
			}
			profile.knownAllergens = profile.knownAllergens.filter((a) => a !== allergen);
			break;
		}
		case 'unsafe': {
			profile.knownAllergens = profile.knownAllergens.filter((a) => a !== value.toLowerCase());
			break;
		}
		case 'ok': {
			profile.avoidAllergens = profile.avoidAllergens.filter((a) => a !== value.toLowerCase());
			break;
		}
		case 'notes': {
			profile.dietaryNotes = value;
			break;
		}
		default:
			return { text: `Unknown field "${field}". Use: stage, safe, avoid, unsafe, ok, notes` };
	}

	profile.updatedAt = isoNow();
	await saveChildProfile(store, log);
	return { text: `Updated **${profile.name}**: ${field} → ${value}` };
}

function buildProfileEditButtons(slug: string): InlineButton[][] {
	return [
		[
			{ text: '📝 Edit stage', callbackData: `app:hearthstone:fa:es:${slug}` },
			{ text: '✅ Add safe', callbackData: `app:hearthstone:fa:as:${slug}` },
			{ text: '⚠️ Add avoid', callbackData: `app:hearthstone:fa:aa:${slug}` },
		],
	];
}

// ─── Intent Detection ────────────────────────────────────────────

export function isKidAdaptIntent(text: string, childNames: string[]): boolean {
	const lower = text.toLowerCase();

	// Generic patterns that don't need a child name
	if (/\b(kid|baby|toddler|child)\s*(friendly|version|safe|appropriate)\b/.test(lower)) {
		return true;
	}
	if (/\bfor\s+the\s+(baby|toddler|kid|little one)\b/.test(lower)) {
		return true;
	}

	// Patterns with a child name
	if (childNames.length > 0) {
		const namePattern = childNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
		const nameRe = new RegExp(`\\b(make|adapt|prepare|cook)\\b.*\\bfor\\s+(${namePattern})\\b`, 'i');
		if (nameRe.test(lower)) return true;

		const forNameRe = new RegExp(`\\bfor\\s+(${namePattern})\\b`, 'i');
		if (forNameRe.test(lower) && /\b(adapt|version|make|how)\b/.test(lower)) return true;
	}

	return false;
}

export function isFoodIntroIntent(text: string): boolean {
	const lower = text.toLowerCase();
	if (/\b(introduc(e|ed|ing)|tried|gave|fed)\b.*\b(food|solid|first|baby|toddler)\b/.test(lower)) return true;
	if (/\bnew\s+food\b/.test(lower)) return true;
	if (/\bfirst\s+time\b.*\b(eat|try|tast)/.test(lower)) return true;
	if (/\blog\b.*\b(food|allergen|introduction)\b/.test(lower)) return true;
	// "Margot tried X today" — tried + today/yesterday is a food intro pattern
	if (/\btried\b/.test(lower) && /\b(today|yesterday|for the first)\b/.test(lower)) return true;
	// "introduced X to baby/child-name" — introduced + food context
	if (/\bintroduc(e|ed|ing)\b/.test(lower) && /\b(to|for|the|baby|toddler|child)\b/.test(lower)) return true;
	return false;
}

export function isChildApprovalIntent(text: string, childNames: string[]): boolean {
	if (childNames.length === 0) return false;
	const lower = text.toLowerCase();
	const namePattern = childNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	const re = new RegExp(
		`\\b(${namePattern})\\s+(liked|loved|approved|ate|enjoyed|hated|rejected|refused|wouldn'?t\\s+eat)\\b`,
		'i',
	);
	return re.test(lower);
}

// ─── Kid Adaptation Intent Handler ───────────────────────────────

export async function handleKidAdaptIntent(
	services: CoreServices,
	text: string,
	_userId: string,
	store: ScopedDataStore,
	cachedRecipe: Recipe | null,
	allRecipes: Recipe[],
): Promise<string | null> {
	// Try cached recipe first, then search by text
	let recipe = cachedRecipe;

	if (!recipe) {
		// Extract recipe name from text like "make the chili for Margot"
		const recipeMatch = text.match(
			/\b(?:make|adapt|prepare|cook)\s+(?:the\s+)?(.+?)\s+(?:for|version)\b/i,
		);
		const query = recipeMatch?.[1]?.trim();
		if (query && allRecipes.length > 0) {
			recipe = findRecipeByTitle(allRecipes, query) ?? null;
		}
	}

	if (!recipe) {
		return 'Which recipe would you like me to adapt? Search for a recipe first or say "adapt the [recipe name] for [child]".';
	}

	// Find the child to adapt for
	const children = await loadAllChildren(store);
	if (children.length === 0) {
		return 'No children registered. Add a child with `/family add <name> <birthdate>` first.';
	}

	// Try to find the child name in the text
	const lower = text.toLowerCase();
	let child = children.find((c) =>
		lower.includes(c.profile.slug) || lower.includes(c.profile.name.toLowerCase()),
	);

	// Default to first child if only one exists
	if (!child && children.length === 1) {
		child = children[0];
	}

	if (!child) {
		const names = children.map((c) => c.profile.name).join(', ');
		return `Which child? I have profiles for: ${names}`;
	}

	const today = todayDate(services.timezone);
	const ageMonths = computeAgeMonths(child.profile.birthDate, today);

	try {
		const adaptation = await generateKidAdaptation(services, recipe, child.profile, ageMonths);
		return formatKidAdaptation(adaptation);
	} catch (err) {
		const classified = classifyLLMError(err);
		return `Sorry, I couldn't generate an adaptation: ${classified.userMessage}`;
	}
}

// ─── Food Introduction Handler ───────────────────────────────────

export async function handleFoodIntroduction(
	services: CoreServices,
	text: string,
	userId: string,
	store: ScopedDataStore,
	waitDays: number,
): Promise<{ text: string; buttons?: InlineButton[][] }> {
	const children = await loadAllChildren(store);
	if (children.length === 0) {
		return { text: 'No children registered. Add a child with `/family add <name> <birthdate>` first.' };
	}

	// Find child in text, default to first if one child
	const lower = text.toLowerCase();
	let child = children.find((c) =>
		lower.includes(c.profile.slug) || lower.includes(c.profile.name.toLowerCase()),
	);
	if (!child && children.length === 1) {
		child = children[0];
	}
	if (!child) {
		const names = children.map((c) => c.profile.name).join(', ');
		return { text: `Which child? I have profiles for: ${names}` };
	}

	// Extract food name using LLM for better accuracy
	let food: string;
	try {
		const extractResult = await services.llm.complete(
			`Extract the food name from this message about introducing food to a baby/child. ` +
			`Return ONLY the food name, nothing else. No quotes, no punctuation.\n\n` +
			`Message: "${text}"`,
			{ tier: 'fast' },
		);
		food = extractResult.trim().replace(/^["']|["']$/g, '');
	} catch {
		// Fallback to regex extraction
		const foodMatch = text.match(
			/(?:tried|introduced|gave|fed)\s+(?:the\s+)?(?:baby\s+)?(?:some\s+)?(.+?)(?:\s+(?:today|yesterday|to\s|for\s)|\s*$)/i,
		);
		food = foodMatch?.[1]?.trim() || '';
	}

	if (!food || food.length < 2) {
		return { text: 'What food was introduced? Try something like:\n• "Margot tried peanut butter today"\n• "introduced eggs to the baby"\n• "gave her yogurt for the first time"' };
	}

	// Match allergen category using the expanded food-to-allergen map
	const allergenCategory = matchAllergenCategory(food);

	const today = todayDate(services.timezone);

	// Check allergen wait window if this is an allergenic food
	let warning = '';
	if (allergenCategory) {
		const waitCheck = checkAllergenWaitWindow(child, allergenCategory, today, waitDays);
		if (!waitCheck.safe) {
			warning = '\n\n' + formatAllergenWarning(
				waitCheck.lastIntroDate!,
				waitCheck.daysSince!,
				waitDays,
			);
		}
	}

	const entry: FoodIntroduction = {
		food,
		allergenCategory,
		date: today,
		reaction: 'none',
		accepted: true,
		notes: warning ? 'Logged with allergen wait warning' : '',
	};
	const updated = addFoodIntroduction(child, entry);
	await saveChildProfile(store, updated);

	const allergenNote = allergenCategory ? ` (allergen: ${allergenCategory})` : '';
	return {
		text: `✅ Logged: ${child.profile.name} tried **${food}**${allergenNote} on ${today}.${warning}\n\nAny reaction?`,
		buttons: [
			[
				{ text: '😊 None', callbackData: `app:hearthstone:fi:r:${child.profile.slug}:none` },
				{ text: '🤔 Mild', callbackData: `app:hearthstone:fi:r:${child.profile.slug}:mild` },
				{ text: '😟 Moderate', callbackData: `app:hearthstone:fi:r:${child.profile.slug}:moderate` },
				{ text: '🚨 Severe', callbackData: `app:hearthstone:fi:r:${child.profile.slug}:severe` },
			],
			[
				{ text: '👎 Rejected', callbackData: `app:hearthstone:fi:rej:${child.profile.slug}` },
			],
		],
	};
}

// ─── Child Approval Intent Handler ───────────────────────────────

export async function handleChildApprovalIntent(
	services: CoreServices,
	text: string,
	store: ScopedDataStore,
	allRecipes: Recipe[],
	childNames: string[],
): Promise<string | null> {
	const lower = text.toLowerCase();

	// Find which child
	const children = await loadAllChildren(store);
	let child: ChildFoodLog | undefined;
	for (const c of children) {
		if (lower.includes(c.profile.slug) || lower.includes(c.profile.name.toLowerCase())) {
			child = c;
			break;
		}
	}
	if (!child) return null;

	// Determine approval or rejection
	const isRejection = /\b(hated|rejected|refused|wouldn'?t\s+eat)\b/i.test(lower);

	// Extract recipe name — text between child name and approval word
	const namePattern = childNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	const extractRe = new RegExp(
		`\\b(?:${namePattern})\\s+(?:liked|loved|approved|ate|enjoyed|hated|rejected|refused|wouldn'?t\\s+eat)\\s+(?:the\\s+)?(.+?)\\s*$`,
		'i',
	);
	const recipeMatch = extractRe.exec(text);
	const query = recipeMatch?.[1]?.trim();

	if (!query || allRecipes.length === 0) {
		return 'Which recipe? Try "Margot loved the chicken stir fry" with the recipe name.';
	}

	const recipe = findRecipeByTitle(allRecipes, query);
	if (!recipe) {
		return `I couldn't find a recipe matching "${query}". Try \`/recipes ${query}\` to search.`;
	}

	if (!recipe.childApprovals) {
		recipe.childApprovals = {};
	}

	const status = isRejection ? 'rejected' : 'approved';
	recipe.childApprovals[child.profile.slug] = status;
	await updateRecipe(store, recipe);

	const emoji = isRejection ? '👎' : '👍';
	return `${emoji} Marked **${recipe.title}** as ${status} by ${child.profile.name}.`;
}

// ─── Approval Callback Handler ───────────────────────────────────

export async function handleApprovalCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	// Remove confirmation
	if (action === 'rm-cancel') {
		consumePendingRemoval(userId);
		await services.telegram.editMessage(chatId, messageId, 'Cancelled.');
		return;
	}
	if (action.startsWith('rm:')) {
		const slug = action.slice(3);
		const pending = consumePendingRemoval(userId);
		if (!pending || pending !== slug) {
			await services.telegram.editMessage(chatId, messageId, 'This removal request has expired. Use `/family remove` again.');
			return;
		}
		const removed = await deleteChildProfile(store, slug);
		if (!removed) {
			await services.telegram.editMessage(chatId, messageId, `Child not found.`);
			return;
		}
		await services.telegram.editMessage(chatId, messageId, `Child profile removed and archived.`);
		return;
	}

	// Edit stage prompt buttons
	if (action.startsWith('es:')) {
		const slug = action.slice(3);
		await services.telegram.editMessage(chatId, messageId, `Select allergen stage for this child:`, [
			[
				{ text: 'Pre-solids', callbackData: `app:hearthstone:fa:ss:${slug}:pre-solids` },
				{ text: 'Early intro', callbackData: `app:hearthstone:fa:ss:${slug}:early-introduction` },
			],
			[
				{ text: 'Expanding', callbackData: `app:hearthstone:fa:ss:${slug}:expanding` },
				{ text: 'Established', callbackData: `app:hearthstone:fa:ss:${slug}:established` },
			],
		]);
		return;
	}

	// Set stage callback
	if (action.startsWith('ss:')) {
		const parts = action.slice(3).split(':');
		const slug = parts[0];
		const stage = parts[1];
		if (!slug || !stage) return;
		const log = await loadChildProfile(store, slug);
		if (!log) {
			await services.telegram.editMessage(chatId, messageId, 'Child not found.');
			return;
		}
		log.profile.allergenStage = stage as ChildProfile['allergenStage'];
		log.profile.updatedAt = isoNow();
		await saveChildProfile(store, log);
		await services.telegram.editMessage(chatId, messageId, `Updated ${log.profile.name}'s stage to **${stage}**.`);
		return;
	}

	// Recipe approval/rejection
	if (action.startsWith('y:') || action.startsWith('n:') || action.startsWith('c:')) {
		const parts = action.split(':');
		const verb = parts[0];
		const slug = parts[1];
		const recipeId = parts[2];

		if (!slug || !recipeId) return;

		const childLog = await loadChildProfile(store, slug);
		if (!childLog) {
			await services.telegram.editMessage(chatId, messageId, `Child "${slug}" not found.`);
			return;
		}

		const recipe = await loadRecipe(store, recipeId);
		if (!recipe) {
			await services.telegram.editMessage(chatId, messageId, `Recipe not found.`);
			return;
		}

		if (!recipe.childApprovals) {
			recipe.childApprovals = {};
		}

		let statusText: string;
		if (verb === 'y') {
			recipe.childApprovals[slug] = 'approved';
			statusText = `👍 ${childLog.profile.name} approved`;
		} else if (verb === 'n') {
			recipe.childApprovals[slug] = 'rejected';
			statusText = `👎 ${childLog.profile.name} rejected`;
		} else {
			delete recipe.childApprovals[slug];
			statusText = `${childLog.profile.name} approval cleared`;
		}

		await updateRecipe(store, recipe);
		await services.telegram.editMessage(
			chatId,
			messageId,
			`${statusText}: **${recipe.title}**`,
		);
		return;
	}
}

// ─── Food Introduction Callback Handler ──────────────────────────

export async function handleFoodIntroCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	// Reaction recording: fi:r:<slug>:<severity>
	if (action.startsWith('r:')) {
		const parts = action.slice(2).split(':');
		const slug = parts[0];
		const reaction = parts[1] as FoodIntroduction['reaction'];
		if (!slug || !reaction) return;

		const log = await loadChildProfile(store, slug);
		if (!log || log.introductions.length === 0) {
			await services.telegram.editMessage(chatId, messageId, 'No recent food introduction found.');
			return;
		}

		// Update the most recent introduction's reaction
		const lastIntro = log.introductions[log.introductions.length - 1]!;
		lastIntro.reaction = reaction;
		await saveChildProfile(store, log);

		const emoji = reaction === 'none' ? '😊' : reaction === 'mild' ? '🤔' : reaction === 'moderate' ? '😟' : '🚨';
		await services.telegram.editMessage(
			chatId,
			messageId,
			`${emoji} Recorded ${reaction} reaction to **${lastIntro.food}** for ${log.profile.name}.`,
		);
		return;
	}

	// Rejection recording: fi:rej:<slug>
	if (action.startsWith('rej:')) {
		const slug = action.slice(4);
		const log = await loadChildProfile(store, slug);
		if (!log || log.introductions.length === 0) {
			await services.telegram.editMessage(chatId, messageId, 'No recent food introduction found.');
			return;
		}

		const lastIntro = log.introductions[log.introductions.length - 1]!;
		lastIntro.accepted = false;
		await saveChildProfile(store, log);

		await services.telegram.editMessage(
			chatId,
			messageId,
			`👎 Recorded: ${log.profile.name} rejected **${lastIntro.food}**.`,
		);
		return;
	}
}

// ─── Build approval buttons for recipe views ─────────────────────

export function buildRecipeApprovalButtons(
	recipeId: string,
	children: ChildFoodLog[],
	currentApprovals?: Record<string, 'approved' | 'rejected'>,
): InlineButton[][] {
	if (children.length === 0) return [];

	const buttons: InlineButton[] = [];
	for (const child of children) {
		const slug = child.profile.slug;
		const current = currentApprovals?.[slug];
		const emoji = current === 'approved' ? '👍' : current === 'rejected' ? '👎' : '❓';
		const action = current === 'approved' ? 'n' : 'y'; // toggle: approved -> reject, else approve
		buttons.push({
			text: `${emoji} ${child.profile.name}`,
			callbackData: `app:hearthstone:fa:${action}:${slug}:${recipeId}`,
		});
	}

	// Split into rows of 2
	const rows: InlineButton[][] = [];
	for (let i = 0; i < buttons.length; i += 2) {
		rows.push(buttons.slice(i, i + 2));
	}
	return rows;
}
