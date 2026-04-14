import { describe, expect, it } from 'vitest';
import { validateManifest } from '../validate-manifest.js';

// ========================================================================
// Fixtures
// ========================================================================

/** Minimal valid manifest — the echo app from PAS-APP-SPEC-001 Section 13. */
const echoManifest = {
	app: {
		id: 'echo',
		name: 'Echo',
		version: '1.0.0',
		description: 'Echoes your messages back. A minimal example app.',
		author: 'PAS Team',
	},
	capabilities: {
		messages: {
			intents: ['echo', 'repeat'],
			commands: [
				{
					name: '/echo',
					description: 'Echo back your message',
					args: ['message'],
				},
			],
		},
	},
	requirements: {
		services: ['telegram', 'data-store'],
		data: {
			user_scopes: [
				{
					path: 'echo/log.md',
					access: 'read-write',
					description: 'Message echo log',
				},
			],
		},
	},
};

/** Full-featured manifest exercising all optional fields. */
const fullManifest = {
	app: {
		id: 'grocery',
		name: 'Grocery Manager',
		version: '2.1.0',
		description: 'Manages your grocery lists, meal plans, and recipe collection.',
		author: 'Matthew',
		repository: 'https://github.com/example/grocery',
	},
	capabilities: {
		messages: {
			intents: ['grocery', 'shopping list', 'add to list', 'meal plan'],
			commands: [
				{ name: '/grocery', description: 'Show the current grocery list' },
				{ name: '/mealplan', description: 'Generate a meal plan', args: ['days'] },
				{ name: '/recipe', description: 'Look up a recipe', args: ['name'] },
			],
			accepts_photos: true,
			photo_intents: ['receipt', 'recipe_image'],
		},
		schedules: [
			{
				id: 'weekly-mealplan',
				description: 'Generate weekly meal plan suggestion',
				cron: '0 9 * * 0',
				handler: 'schedules/weekly-mealplan.ts',
				user_scope: 'shared',
			},
			{
				id: 'stale-check',
				description: 'Check for stale grocery list',
				cron: '0 18 * * *',
				handler: 'schedules/stale-check.ts',
				user_scope: 'all',
			},
		],
		rules: {
			files: ['rules/grocery-rules.md'],
		},
		events: {
			emits: [
				{
					id: 'grocery.list.updated',
					description: 'Fired when the grocery list changes',
					payload: {
						type: 'object',
						properties: {
							item_count: { type: 'number' },
						},
					},
				},
			],
			subscribes: [
				{
					event: 'mealplan.generated',
					handler: 'handlers/on-mealplan.ts',
					required: false,
				},
			],
		},
	},
	requirements: {
		services: ['telegram', 'llm:ollama', 'llm:claude', 'data-store', 'scheduler', 'event-bus'],
		external_apis: [
			{
				id: 'spoonacular',
				description: 'Recipe search and nutrition data',
				required: false,
				env_var: 'SPOONACULAR_API_KEY',
				fallback_behavior: 'Recipe search disabled. Manual recipe entry still works.',
			},
		],
		data: {
			user_scopes: [
				{ path: 'grocery/list.md', access: 'read-write', description: 'Active grocery list' },
				{ path: 'grocery/archive.md', access: 'read-write', description: 'Archived lists' },
				{ path: 'grocery/recipes/', access: 'read-write', description: 'Saved recipes' },
				{
					path: 'grocery/meal-plans/',
					access: 'read-write',
					description: 'Generated meal plans',
				},
			],
			shared_scopes: [
				{
					path: 'grocery/shared-list.md',
					access: 'read-write',
					description: 'Shared grocery list',
				},
			],
			context_reads: ['food-preferences', 'pantry-staples'],
		},
		integrations: [
			{
				app: 'briefings',
				description: 'Reports summary data in morning brief',
				required: false,
			},
		],
	},
	user_config: [
		{
			key: 'default_store',
			type: 'string' as const,
			default: '',
			description: 'Preferred grocery store name',
		},
		{
			key: 'auto_categorize',
			type: 'boolean' as const,
			default: true,
			description: 'Automatically categorize grocery items by department',
		},
		{
			key: 'meal_plan_days',
			type: 'number' as const,
			default: 7,
			description: 'Number of days in generated meal plans',
		},
		{
			key: 'difficulty_level',
			type: 'select' as const,
			default: 'medium',
			options: ['easy', 'medium', 'hard'],
			description: 'Recipe difficulty preference',
		},
	],
};

// ========================================================================
// Tests
// ========================================================================

describe('validateManifest', () => {
	describe('valid manifests', () => {
		it('accepts the echo app manifest (minimal)', () => {
			const result = validateManifest(echoManifest);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.manifest.app.id).toBe('echo');
				expect(result.manifest.app.version).toBe('1.0.0');
			}
		});

		it('accepts a full-featured manifest with all optional fields', () => {
			const result = validateManifest(fullManifest);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.manifest.app.id).toBe('grocery');
				expect(result.manifest.capabilities?.schedules).toHaveLength(2);
				expect(result.manifest.requirements?.external_apis).toHaveLength(1);
				expect(result.manifest.user_config).toHaveLength(4);
			}
		});

		it('accepts a bare minimum manifest (only app identity)', () => {
			const result = validateManifest({
				app: {
					id: 'minimal',
					name: 'Minimal',
					version: '0.1.0',
					description: 'The bare minimum.',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('missing required fields', () => {
		it('rejects manifest without app block', () => {
			const result = validateManifest({});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes("'app'"))).toBe(true);
			}
		});

		it('rejects manifest without app.id', () => {
			const result = validateManifest({
				app: {
					name: 'Test',
					version: '1.0.0',
					description: 'Missing ID',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes("'id'"))).toBe(true);
			}
		});

		it('rejects manifest without app.name', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					version: '1.0.0',
					description: 'Missing name',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes("'name'"))).toBe(true);
			}
		});

		it('rejects manifest without app.version', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					description: 'Missing version',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes("'version'"))).toBe(true);
			}
		});
	});

	describe('invalid patterns', () => {
		it('rejects app.id with uppercase letters', () => {
			const result = validateManifest({
				app: {
					id: 'MyApp',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad ID',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes('MyApp'))).toBe(true);
			}
		});

		it('rejects app.id starting with a number', () => {
			const result = validateManifest({
				app: {
					id: '123app',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad ID',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(false);
		});

		it('rejects invalid semver version', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: 'v1.0',
					description: 'Bad version',
					author: 'Test',
				},
			});
			expect(result.valid).toBe(false);
		});

		it('rejects command not starting with /', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad command',
					author: 'Test',
				},
				capabilities: {
					messages: {
						commands: [{ name: 'noSlash', description: 'Missing slash' }],
					},
				},
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes('noSlash'))).toBe(true);
			}
		});

		it('rejects invalid cron expression', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad cron',
					author: 'Test',
				},
				capabilities: {
					schedules: [
						{
							id: 'bad-cron',
							description: 'Bad cron',
							cron: 'not a cron',
							handler: 'handler.ts',
							user_scope: 'system',
						},
					],
				},
			});
			expect(result.valid).toBe(false);
		});
	});

	describe('integration constraints', () => {
		it('rejects integration with required: true', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad integration',
					author: 'Test',
				},
				requirements: {
					integrations: [
						{
							app: 'other-app',
							description: 'Required dependency',
							required: true,
						},
					],
				},
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes('const'))).toBe(true);
			}
		});
	});

	describe('user_config constraints', () => {
		it('rejects select type without options', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad config',
					author: 'Test',
				},
				user_config: [
					{
						key: 'my_setting',
						type: 'select',
						default: 'a',
						description: 'Missing options for select type',
					},
				],
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes("'options'"))).toBe(true);
			}
		});

		it('accepts select type with options provided', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Good config',
					author: 'Test',
				},
				user_config: [
					{
						key: 'my_setting',
						type: 'select',
						default: 'a',
						description: 'Select with options',
						options: ['a', 'b', 'c'],
					},
				],
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('service enum validation', () => {
		it('rejects unknown service names', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad service',
					author: 'Test',
				},
				requirements: {
					services: ['telegram', 'not-a-real-service'],
				},
			});
			expect(result.valid).toBe(false);
		});

		it('accepts all valid service names', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'All services',
					author: 'Test',
				},
				requirements: {
					services: [
						'telegram',
						'llm:ollama',
						'llm:claude',
						'scheduler',
						'data-store',
						'condition-eval',
						'audio',
						'event-bus',
						'context-store',
						'data-query',
					],
				},
			});
			expect(result.valid).toBe(true);
		});
	});

	describe('additional properties', () => {
		it('rejects unknown top-level properties', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Extra prop',
					author: 'Test',
				},
				unknown_field: 'should fail',
			});
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.errors.some((e) => e.includes('unknown_field'))).toBe(true);
			}
		});
	});

	describe('v2 manifest fields', () => {
		it('accepts manifest with all v2 fields', () => {
			const result = validateManifest({
				app: {
					id: 'test-v2',
					name: 'Test V2',
					version: '1.0.0',
					description: 'V2 manifest test.',
					author: 'Test',
					pas_core_version: '>=0.1.0',
					license: 'MIT',
					tags: ['test', 'utility'],
					category: 'utility',
					homepage: 'https://example.com',
				},
			});
			expect(result.valid).toBe(true);
		});

		it('rejects homepage with javascript: protocol', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'XSS attempt.',
					author: 'Test',
					homepage: 'javascript:alert(1)',
				},
			});
			expect(result.valid).toBe(false);
		});

		it('rejects homepage with data: protocol', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Data URI attempt.',
					author: 'Test',
					homepage: 'data:text/html,<script>alert(1)</script>',
				},
			});
			expect(result.valid).toBe(false);
		});

		it('accepts homepage with https:// URL', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Valid homepage.',
					author: 'Test',
					homepage: 'https://github.com/user/repo',
				},
			});
			expect(result.valid).toBe(true);
		});

		it('rejects tag exceeding maxLength', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Long tag.',
					author: 'Test',
					tags: ['a'.repeat(51)],
				},
			});
			expect(result.valid).toBe(false);
		});

		it('accepts tag at maxLength boundary', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Max tag.',
					author: 'Test',
					tags: ['a'.repeat(50)],
				},
			});
			expect(result.valid).toBe(true);
		});

		it('rejects more than 20 tags', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Too many tags.',
					author: 'Test',
					tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
				},
			});
			expect(result.valid).toBe(false);
		});

		it('rejects invalid category value', () => {
			const result = validateManifest({
				app: {
					id: 'test',
					name: 'Test',
					version: '1.0.0',
					description: 'Bad category.',
					author: 'Test',
					category: 'gaming',
				},
			});
			expect(result.valid).toBe(false);
		});
	});

	describe('error formatting', () => {
		it('returns human-readable error strings', () => {
			const result = validateManifest({ app: {} });
			expect(result.valid).toBe(false);
			if (!result.valid) {
				// Errors should be strings, not objects
				for (const err of result.errors) {
					expect(typeof err).toBe('string');
					expect(err.length).toBeGreaterThan(0);
				}
			}
		});
	});
});
