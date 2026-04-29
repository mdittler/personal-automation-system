export { generateTitle, type TitleGeneratorDeps } from './title-generator.js';
export { TitleService, type TitleServiceDeps, type ApplyTitleResult } from './title-service.js';
export {
	runTitleAfterFirstExchange,
	scheduleTitleAfterFirstExchange,
	type AutoTitleHookParams,
	type AutoTitleHookDeps,
} from './auto-title-hook.js';
