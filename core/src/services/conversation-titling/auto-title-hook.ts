import { generateTitle } from './title-generator.js';
import type { TitleService } from './title-service.js';
import type { LLMService } from '../llm/index.js';

export interface AutoTitleHookParams {
	userId: string;
	sessionId: string;
	userContent: string;
	assistantContent: string;
}

export interface AutoTitleHookDeps {
	titleService: TitleService;
	llm: LLMService;
	// Narrow logger shape — matches recall-classifier.ts.
	logger: { warn(obj: unknown, msg?: string): void };
}

export async function runTitleAfterFirstExchange(
	params: AutoTitleHookParams,
	deps: AutoTitleHookDeps,
): Promise<void> {
	let title: string | null;
	try {
		title = await generateTitle(params.userContent, params.assistantContent, {
			llm: deps.llm,
			logger: deps.logger,
		});
	} catch (err) {
		deps.logger.warn({ err, userId: params.userId, sessionId: params.sessionId }, 'auto-title-hook: generateTitle threw');
		return;
	}
	if (title === null) return;

	try {
		await deps.titleService.applyTitle(params.userId, params.sessionId, title, { skipIfTitled: true });
	} catch (err) {
		deps.logger.warn({ err, userId: params.userId, sessionId: params.sessionId }, 'auto-title-hook: applyTitle threw');
	}
}

/**
 * Fire-and-forget wrapper. Returns void synchronously after scheduling the work.
 * The promise is intentionally unawaited; all errors are caught inside `runTitleAfterFirstExchange`.
 */
export function scheduleTitleAfterFirstExchange(
	params: AutoTitleHookParams,
	deps: AutoTitleHookDeps,
): void {
	void runTitleAfterFirstExchange(params, deps);
}
