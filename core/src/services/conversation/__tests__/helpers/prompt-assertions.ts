import { expect } from 'vitest';

export function expectPasAwarePrompt(prompt: string): void {
	expect(prompt).toContain('PAS (Personal Automation System) assistant');
	expect(prompt).not.toContain('helpful, friendly AI assistant');
}

export function expectBasicPrompt(prompt: string): void {
	expect(prompt).toContain('helpful, friendly AI assistant');
	expect(prompt).not.toContain('PAS (Personal Automation System) assistant');
}

export function expectPromptIncludesSystemData(prompt: string): void {
	expect(prompt).toContain('Live system data');
}

export function expectPromptOmitsSystemData(prompt: string): void {
	expect(prompt).not.toContain('Live system data');
}

/** Assert that a <memory-context> block with the given label is present and
 *  contains `expectedSubstring`. */
export function assertMemoryContextBlock(
	prompt: string,
	label: string,
	expectedSubstring: string,
): void {
	const openTag = `<memory-context label="${label}">`;
	expect(prompt).toContain(openTag);
	expect(prompt).toContain('</memory-context>');
	const start = prompt.indexOf(openTag);
	const end = prompt.indexOf('</memory-context>', start) + '</memory-context>'.length;
	const block = prompt.slice(start, end);
	expect(block).toContain(expectedSubstring);
}

/** Assert that NO <memory-context> block with the given label is present. */
export function assertNoMemoryContextBlock(prompt: string, label: string): void {
	expect(prompt).not.toContain(`<memory-context label="${label}">`);
}

/** Assert that `value` does not appear anywhere in the prompt (regression guard
 *  for live ContextStore re-injection when a frozen snapshot is present). */
export function assertNoLiveContextStoreEntry(prompt: string, value: string): void {
	expect(prompt).not.toContain(value);
}
