#!/usr/bin/env node
/**
 * Fake regression CLI for integration tests (Codex I9).
 *
 * Mirrors the NDJSON contract of the real `regression/src/runner/cli-main.ts`
 * without needing tsx, env vars, or any LLM provider. Behavior is controlled
 * via env vars set by the test:
 *
 *   FAKE_CLI_MODE=list        — emit one case-list-entry + case-list-end, exit 0
 *   FAKE_CLI_MODE=happy       — emit case-result + summary + exit 0 (=> complete)
 *   FAKE_CLI_MODE=gate-failed — emit summary + exit 1 (=> gate-failed)
 *   FAKE_CLI_MODE=crash       — emit nothing on stdout, write to stderr, exit 2
 *   FAKE_CLI_MODE=pino-noise  — emit a Pino-shaped line then a summary
 *
 * The test verifies that the GUI's run-registry + subprocess + SSE pipeline
 * produces the right terminal SSE event for each mode.
 */

const mode = process.env.FAKE_CLI_MODE ?? 'happy';

function emit(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

switch (mode) {
	case 'list':
		emit({
			type: 'case-list-entry',
			caseId: 'fake-case',
			bucket: 'routing',
			routingTarget: 'food-shadow',
			description: 'fake case for integration test',
			oracle: 'structural',
			coverage: ['x.ts'],
			inputs: [{ payload: 'p', expected: {} }],
			inputCount: 1,
			budgetUsd: 0.05,
			currentCacheKey: 'a'.repeat(64),
		});
		emit({
			type: 'case-list-end',
			totalCases: 1,
			totalInputs: 1,
			modelIds: { fast: 'fake-fast', standard: 'fake-std', reasoning: null },
		});
		process.exit(0);
		break;

	case 'happy':
		emit({ type: 'case-result', result: { caseId: 'a', verdict: 'pass' } });
		emit({ type: 'summary', summary: { totalCases: 1, pass: 1 } });
		process.exit(0);
		break;

	case 'gate-failed':
		emit({ type: 'summary', summary: { routingAccuracy: 0.5 } });
		process.exit(1);
		break;

	case 'crash':
		process.stderr.write('fatal: simulated crash\n');
		process.exit(2);
		break;

	case 'pino-noise':
		emit({ level: 30, msg: 'pino info that leaked to stdout' });
		emit({ type: 'summary', summary: { totalCases: 0 } });
		process.exit(0);
		break;

	default:
		process.stderr.write(`unknown FAKE_CLI_MODE: ${mode}\n`);
		process.exit(99);
}
