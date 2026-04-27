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
