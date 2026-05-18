/**
 * Tests for `detectCommandShadowing`.
 *
 * Shadowing detection is a build-failing gate: any app-manifest slash command
 * that collides with a built-in (`/ask`, `/edit`, `/notes`, …) or with another
 * app's manifest command is reported. The production case loads every
 * `apps/*\/manifest.yaml` off disk so a real collision (today: Notes' `/notes`
 * shadowing the conversation `/notes` toggle) fails the suite until renamed.
 *
 * Drift guard: `ManifestCommand` uses `name`, NOT `command`. The override
 * shape below mirrors the real manifest shape so a fixture using `{command:}`
 * would fail to typecheck.
 */

import { describe, expect, it } from 'vitest';
import { detectCommandShadowing } from '../command-catalog.js';

describe('command shadowing detection', () => {
	it('reports zero collisions for the current production manifests', async () => {
		const collisions = await detectCommandShadowing();
		expect(collisions, JSON.stringify(collisions, null, 2)).toEqual([]);
	});

	it('detects a manifest command colliding with a built-in', async () => {
		const collisions = await detectCommandShadowing({
			builtins: new Set(['/notes']),
			manifests: [{ appId: 'fake', commands: [{ name: '/notes', description: 'x' }] }],
		});
		expect(collisions).toHaveLength(1);
		expect(collisions[0]).toMatchObject({
			command: '/notes',
			conflictWith: 'builtin',
		});
	});

	it('detects two manifests declaring the same command', async () => {
		const collisions = await detectCommandShadowing({
			builtins: new Set(),
			manifests: [
				{ appId: 'a', commands: [{ name: '/dup', description: 'a' }] },
				{ appId: 'b', commands: [{ name: '/dup', description: 'b' }] },
			],
		});
		expect(collisions).toHaveLength(1);
		expect(collisions[0]).toMatchObject({
			command: '/dup',
			conflictWith: 'app:a',
		});
	});
});
