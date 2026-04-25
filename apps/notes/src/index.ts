import type { AppModule, CoreServices, MessageContext } from '@pas/core/types';
import { escapeMarkdown } from '@pas/core/utils/escape-markdown';
import { generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { classifyLLMError } from '@pas/core/utils/llm-errors';

let services: CoreServices;

const DEFAULT_NOTES_PER_PAGE = 10;

function todayFile(): string {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: services.timezone ?? 'UTC',
	});
	const date = formatter.format(new Date());
	return `daily-notes/${date}.md`;
}

function formatNote(text: string): string {
	const formatter = new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: services.timezone ?? 'UTC',
	});
	const time = formatter.format(new Date());
	return `- [${time}] ${text}\n`;
}

export const init: AppModule['init'] = async (s) => {
	services = s;
};

export const handleMessage: AppModule['handleMessage'] = async (ctx: MessageContext) => {
	if (!ctx.text.trim()) {
		await services.telegram.send(ctx.userId, 'Empty note — nothing to save.');
		return;
	}

	const store = services.data.forUser(ctx.userId);
	await store.append(todayFile(), formatNote(ctx.text), {
		frontmatter: buildDailyNoteFrontmatter(ctx.userId),
	});
	await services.telegram.send(ctx.userId, 'Noted.');
	services.logger.debug('Saved note for %s', ctx.userId);
};

export const handleCommand: AppModule['handleCommand'] = async (
	command: string,
	args: string[],
	ctx: MessageContext,
) => {
	switch (command) {
		case 'note':
			await saveNote(args.join(' '), ctx);
			break;
		case 'notes':
			await listNotes(ctx);
			break;
		case 'summarize':
			await summarizeNotes(ctx);
			break;
	}
};

async function saveNote(text: string, ctx: MessageContext): Promise<void> {
	if (!text.trim()) {
		await services.telegram.send(ctx.userId, 'Usage: /note <text>');
		return;
	}

	const store = services.data.forUser(ctx.userId);
	await store.append(todayFile(), formatNote(text), {
		frontmatter: buildDailyNoteFrontmatter(ctx.userId),
	});
	await services.telegram.send(ctx.userId, 'Noted.');
}

async function listNotes(ctx: MessageContext): Promise<void> {
	const store = services.data.forUser(ctx.userId);
	const raw = await store.read(todayFile());
	const content = stripFrontmatter(raw);

	if (!content.trim()) {
		await services.telegram.send(ctx.userId, 'No notes today.');
		return;
	}

	const lines = content.trim().split('\n');
	const notesPerPage =
		(await services.config.get<number>('notes_per_page')) ?? DEFAULT_NOTES_PER_PAGE;
	const recent = lines.slice(-notesPerPage);
	const header = `Today's notes (${recent.length}/${lines.length}):\n`;
	await services.telegram.send(ctx.userId, header + recent.map(escapeMarkdown).join('\n'));
}

async function summarizeNotes(ctx: MessageContext): Promise<void> {
	const store = services.data.forUser(ctx.userId);
	const raw = await store.read(todayFile());
	const content = stripFrontmatter(raw);

	if (!content.trim()) {
		await services.telegram.send(ctx.userId, 'No notes to summarize today.');
		return;
	}

	try {
		const summary = await services.llm.complete(
			`Summarize these notes concisely in 2-3 sentences:\n\n${content}`,
			{ tier: 'fast' },
		);
		await services.telegram.send(ctx.userId, `Summary:\n${summary}`);
	} catch (err) {
		services.logger.error(
			'Failed to summarize notes: %s',
			err instanceof Error ? err.message : String(err),
		);
		const { userMessage } = classifyLLMError(err);
		await services.telegram.send(ctx.userId, userMessage);
	}
}

function buildDailyNoteFrontmatter(userId: string): string {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: services.timezone ?? 'UTC',
	});
	const dateStr = formatter.format(new Date());
	return generateFrontmatter({
		title: `Daily Notes - ${dateStr}`,
		date: dateStr,
		tags: ['pas/daily-note', 'pas/notes'],
		type: 'daily-note',
		user: userId,
		source: 'pas-notes',
	});
}
