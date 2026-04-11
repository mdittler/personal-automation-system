import type { AppModule, CoreServices, MessageContext } from '@pas/core/types';
import { escapeMarkdown } from '@pas/core/utils/escape-markdown';
import { generateFrontmatter } from '@pas/core/utils/frontmatter';

let services: CoreServices;

function buildLogFrontmatter(userId: string): string {
	return generateFrontmatter({
		title: 'Echo Log',
		tags: ['pas/log', 'pas/echo'],
		type: 'log',
		user: userId,
		source: 'pas-echo',
	});
}

export const init: AppModule['init'] = async (s) => {
	services = s;
};

export const handleMessage: AppModule['handleMessage'] = async (ctx: MessageContext) => {
	await services.telegram.send(ctx.userId, escapeMarkdown(ctx.text));

	const store = services.data.forUser(ctx.userId);
	await store.append('log.md', `- [${ctx.timestamp.toISOString()}] ${ctx.text}\n`, {
		frontmatter: buildLogFrontmatter(ctx.userId),
	});

	services.logger.debug('Echoed message to %s', ctx.userId);
};

export const handleCommand: AppModule['handleCommand'] = async (
	_command: string,
	args: string[],
	ctx: MessageContext,
) => {
	const joined = args.join(' ');
	await services.telegram.send(ctx.userId, joined ? escapeMarkdown(joined) : '(empty)');

	const store = services.data.forUser(ctx.userId);
	await store.append('log.md', `- [${ctx.timestamp.toISOString()}] /echo ${joined || '(empty)'}\n`, {
		frontmatter: buildLogFrontmatter(ctx.userId),
	});
};
