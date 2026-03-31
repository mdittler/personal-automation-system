import type { AppModule, CoreServices, MessageContext } from '@pas/core/types';
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
	await services.telegram.send(ctx.userId, ctx.text);

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
	const message = args.join(' ') || '(empty)';
	await services.telegram.send(ctx.userId, message);

	const store = services.data.forUser(ctx.userId);
	await store.append('log.md', `- [${ctx.timestamp.toISOString()}] /echo ${message}\n`, {
		frontmatter: buildLogFrontmatter(ctx.userId),
	});
};
