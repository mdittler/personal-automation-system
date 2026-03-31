import type { AppModule, CoreServices, MessageContext } from '@pas/core/types';
import { buildAppTags, generateFrontmatter } from '@pas/core/utils/frontmatter';

let services: CoreServices;

function buildLogFrontmatter(): string {
	return generateFrontmatter({
		title: '{{APP_NAME}} Log',
		tags: buildAppTags('{{APP_ID}}', 'log'),
		type: 'log',
		app: '{{APP_ID}}',
		source: 'pas-{{APP_ID}}',
		// Cross-app linking: add aliases for alternative names
		// aliases: ['{{APP_NAME}} Activity'],
		// Cross-app linking: reference files in other apps
		// related: ['[[other-app/some-file]]'],
		// Dataview fields: add queryable numeric/string fields for your domain
		// calories: 450, duration: 30, rating: 4,
	});
}

export const init: AppModule['init'] = async (s) => {
	services = s;
};

export const handleMessage: AppModule['handleMessage'] = async (ctx: MessageContext) => {
	await services.telegram.send(ctx.userId, `Received: ${ctx.text}`);

	const store = services.data.forUser(ctx.userId);
	await store.append('log.md', `- [${ctx.timestamp.toISOString()}] ${ctx.text}\n`, {
		frontmatter: buildLogFrontmatter(),
	});

	services.logger.debug('Handled message from %s', ctx.userId);
};

export const handleCommand: AppModule['handleCommand'] = async (
	command: string,
	args: string[],
	ctx: MessageContext,
) => {
	// Tip: For LLM calls, wrap in try/catch with classifyLLMError for user-friendly errors.
	// See "Handling LLM Errors" in docs/CREATING_AN_APP.md
	// Tip: Emit custom events for n8n integration (requires event-bus service):
	// services.eventBus.emit('{{APP_ID}}:action-completed', { key: 'value' });
	const message = args.join(' ') || '(no arguments)';
	await services.telegram.send(ctx.userId, message);

	const store = services.data.forUser(ctx.userId);
	await store.append('log.md', `- [${ctx.timestamp.toISOString()}] /${command} ${message}\n`, {
		frontmatter: buildLogFrontmatter(),
	});

	services.logger.debug('Handled command %s from %s', command, ctx.userId);
};
