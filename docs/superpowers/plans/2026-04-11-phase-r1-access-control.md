# Phase R1: Critical Security — Access Control & Race Conditions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two high-severity security findings: route-verifier bypassing app access checks (F1) and non-atomic invite redemption (F2).

**Architecture:** F1 is fixed by filtering verifier candidates to user-enabled apps and adding `isAppEnabled` checks at both dispatch points (Router verifier auto-route + bootstrap callback). F2 is fixed by moving the `AsyncLock` utility from `apps/food` to `core/` and adding an atomic `claimAndRedeem()` method to `InviteService`.

**Tech Stack:** TypeScript, Vitest, existing AsyncLock pattern

---

### Task 1: Add access check for verifier-selected app in Router.routeMessage

**Files:**
- Modify: `core/src/services/router/index.ts:188-210` (routeMessage verifier block)
- Modify: `core/src/services/router/index.ts:262-282` (routePhoto verifier block)
- Test: `core/src/services/router/__tests__/router-verification.test.ts`

- [ ] **Step 1: Write failing test — verifier routes to disabled app in routeMessage**

Add this test to the `routeMessage` describe block in `core/src/services/router/__tests__/router-verification.test.ts`:

```typescript
it('rejects verifier-selected app when user does not have access', async () => {
	// User has echo enabled but NOT grocery
	const restrictedUser = {
		id: '123',
		name: 'test',
		isAdmin: false,
		enabledApps: ['echo'],
		sharedScopes: [] as string[],
	};
	const config = createMockConfig([restrictedUser]);
	const greyZoneLlm = createMockLLM({ category: 'echo', confidence: 0.55 });
	const groceryModule = createMockModule();
	// Verifier disagrees with classifier and picks grocery
	const verifier = createMockVerifier({ action: 'route', appId: 'grocery' });

	const cache = new ManifestCache();
	cache.add(echoManifest, '/apps/echo');
	cache.add(groceryManifest, '/apps/grocery');

	const apps = [
		{ manifest: echoManifest, module: echoModule },
		{ manifest: groceryManifest, module: groceryModule },
	];
	const registry = {
		getApp: (id: string) => {
			const app = apps.find((a) => a.manifest.app.id === id);
			if (!app) return undefined;
			return { manifest: app.manifest, module: app.module, appDir: `/apps/${id}` } as RegisteredApp;
		},
		getManifestCache: () => cache,
		getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();
	const router = new Router({
		registry,
		llm: greyZoneLlm,
		telegram,
		fallback: createMockFallback(),
		config,
		logger: createMockLogger(),
		confidenceThreshold: 0.4,
		routeVerifier: verifier,
	});
	router.buildRoutingTables();

	await router.routeMessage(createTextCtx('something ambiguous'));

	// Verifier was called
	expect(verifier.verify).toHaveBeenCalledOnce();
	// Grocery handler NOT called (user doesn't have access)
	expect(groceryModule.handleMessage).not.toHaveBeenCalled();
	// User told they don't have access
	expect(telegram.send).toHaveBeenCalledWith('123', expect.stringContaining("don't have access"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run core/src/services/router/__tests__/router-verification.test.ts`
Expected: FAIL — grocery `handleMessage` is called because there's no access check on verifier result.

- [ ] **Step 3: Write failing test — verifier routes to disabled app in routePhoto**

Add this test to the `routePhoto` describe block:

```typescript
it('rejects verifier-selected photo app when user does not have access', async () => {
	const restrictedUser = {
		id: '123',
		name: 'test',
		isAdmin: false,
		enabledApps: ['photos'],
		sharedScopes: [] as string[],
	};
	const config = createMockConfig([restrictedUser]);
	const greyZoneLlm = createMockLLM({ category: 'landscape', confidence: 0.55 });
	const groceryModule = createMockModule();
	const photoModule2 = createMockModule();
	// Verifier disagrees and picks grocery
	const verifier = createMockVerifier({ action: 'route', appId: 'grocery' });

	const cache = new ManifestCache();
	cache.add(groceryManifest, '/apps/grocery');
	cache.add(photoManifest2, '/apps/photos');

	const apps = [
		{ manifest: groceryManifest, module: groceryModule },
		{ manifest: photoManifest2, module: photoModule2 },
	];
	const registry = {
		getApp: (id: string) => {
			const app = apps.find((a) => a.manifest.app.id === id);
			if (!app) return undefined;
			return { manifest: app.manifest, module: app.module, appDir: `/apps/${id}` } as RegisteredApp;
		},
		getManifestCache: () => cache,
		getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();
	const router = new Router({
		registry,
		llm: greyZoneLlm,
		telegram,
		fallback: createMockFallback(),
		config,
		logger: createMockLogger(),
		confidenceThreshold: 0.4,
		routeVerifier: verifier,
	});
	router.buildRoutingTables();

	await router.routePhoto(createPhotoCtx('some receipt'));

	expect(verifier.verify).toHaveBeenCalledOnce();
	expect(groceryModule.handlePhoto).not.toHaveBeenCalled();
	expect(telegram.send).toHaveBeenCalledWith('123', expect.stringContaining("don't have access"));
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run core/src/services/router/__tests__/router-verification.test.ts`
Expected: FAIL — grocery `handlePhoto` is called.

- [ ] **Step 5: Implement access check in Router.routeMessage verifier block**

In `core/src/services/router/index.ts`, replace lines 200-209 (the verifier block in `routeMessage`):

```typescript
				const result = await this.routeVerifier.verify(enrichedCtx, match);
				if (result.action === 'held') return;
				// Verifier confirmed (possibly different app) — check access before dispatch
				const verifiedAppId = (result as { action: 'route'; appId: string }).appId;
				if (!(await this.isAppEnabled(enrichedCtx.userId, verifiedAppId, user.enabledApps))) {
					await this.trySend(enrichedCtx.userId, `You don't have access to the ${verifiedAppId} app.`);
					return;
				}
				const verifiedApp = this.registry.getApp(verifiedAppId);
				if (verifiedApp) {
					await this.dispatchMessage(verifiedApp, enrichedCtx);
					return;
				}
```

- [ ] **Step 6: Implement access check in Router.routePhoto verifier block**

In `core/src/services/router/index.ts`, replace lines 269-281 (the verifier block in `routePhoto`):

```typescript
				const result = await this.routeVerifier.verify(ctx, {
					appId: match.appId,
					intent: match.photoType,
					confidence: match.confidence,
				});
				if (result.action === 'held') return;
				const verifiedAppId = (result as { action: 'route'; appId: string }).appId;
				if (!(await this.isAppEnabled(ctx.userId, verifiedAppId, user.enabledApps))) {
					await this.trySend(ctx.userId, `You don't have access to the ${verifiedAppId} app.`);
					return;
				}
				const verifiedApp = this.registry.getApp(verifiedAppId);
				if (verifiedApp?.module.handlePhoto) {
					await this.dispatchPhoto(verifiedApp, ctx);
					return;
				}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/router/__tests__/router-verification.test.ts`
Expected: All tests PASS including the two new ones.

- [ ] **Step 8: Commit**

```bash
git add core/src/services/router/index.ts core/src/services/router/__tests__/router-verification.test.ts
git commit -m "fix(router): add access check for verifier-selected apps

The route verifier could suggest an app the user doesn't have access to.
Now both routeMessage and routePhoto check isAppEnabled on the verifier's
chosen appId before dispatching, matching the existing pre-verifier check.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Filter verifier candidate apps to user-enabled apps

**Files:**
- Modify: `core/src/services/router/route-verifier.ts:89-265`
- Modify: `core/src/services/router/index.ts:194-210,264-282` (pass enabledApps to verify)
- Test: `core/src/services/router/__tests__/route-verifier.test.ts`

- [ ] **Step 1: Read the existing route-verifier test file to understand patterns**

Read: `core/src/services/router/__tests__/route-verifier.test.ts` (full file)

- [ ] **Step 2: Write failing test — verifier candidates are filtered by enabled apps**

Add a test to `core/src/services/router/__tests__/route-verifier.test.ts` that verifies the LLM prompt only contains enabled apps. The exact test depends on the existing test patterns (read in step 1), but should assert:

```typescript
it('filters candidate apps to only enabled apps', async () => {
	// Set up: 3 apps registered but only 2 enabled for user
	// When verify() is called with enabledApps: ['echo', 'notes']
	// The LLM prompt should NOT contain the disabled app
	// Assert: llm.complete prompt argument does not mention the disabled app
});
```

- [ ] **Step 3: Add enabledApps parameter to verify() method signature**

In `core/src/services/router/route-verifier.ts`, update the `verify` method signature:

```typescript
async verify(
	ctx: MessageContext | PhotoContext,
	classifierResult: { appId: string; intent: string; confidence: number },
	photoPath?: string,
	enabledApps?: string[],
): Promise<VerifyAction> {
```

- [ ] **Step 4: Filter candidate apps by enabledApps in verify()**

In the `verify` method body, after building `allApps` from `this.registry.getAll()` and before building `candidateApps`, add filtering:

```typescript
const allApps = this.registry.getAll();

// Filter to user-enabled apps only (prevents LLM from suggesting inaccessible apps)
const accessibleApps = enabledApps
	? allApps.filter((app) => {
			const id = app.manifest.app.id;
			return enabledApps.includes('*') || enabledApps.includes(id);
		})
	: allApps;

// Skip verification when there's 0–1 candidate apps (no alternatives to verify against)
if (accessibleApps.length <= 1) {
	this.logger.debug('RouteVerifier: skipping verification — 1 or fewer accessible apps');
	return { action: 'route', appId: classifierResult.appId };
}

const candidateApps = accessibleApps.map((app) => ({
```

Also update the `suggestedApp` lookup and the button-building section to use `accessibleApps` instead of `allApps` (for validation that the suggested app is accessible):

```typescript
const suggestedApp = accessibleApps.find((a) => a.manifest.app.id === rawSuggestedId);
```

- [ ] **Step 5: Pass enabledApps from Router to verify()**

In `core/src/services/router/index.ts`, update both call sites:

In `routeMessage` (~line 200):
```typescript
const result = await this.routeVerifier.verify(enrichedCtx, match, undefined, user.enabledApps);
```

In `routePhoto` (~line 269):
```typescript
const result = await this.routeVerifier.verify(ctx, {
	appId: match.appId,
	intent: match.photoType,
	confidence: match.confidence,
}, undefined, user.enabledApps);
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run core/src/services/router/__tests__/route-verifier.test.ts core/src/services/router/__tests__/router-verification.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/services/router/route-verifier.ts core/src/services/router/index.ts core/src/services/router/__tests__/route-verifier.test.ts
git commit -m "fix(router): filter verifier candidates to user-enabled apps

The route verifier now receives enabledApps and filters candidate apps
before sending them to the LLM. This prevents the verifier from suggesting
apps the user doesn't have access to, and prevents those apps from
appearing as inline buttons.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add access check in bootstrap callback handler

**Files:**
- Modify: `core/src/bootstrap.ts:613-644`
- Test: (bootstrap callback is hard to unit test directly; the Router-level tests from Task 1 cover the main dispatch path. Add a targeted integration test if feasible, otherwise document the coverage gap.)

- [ ] **Step 1: Read bootstrap callback context to understand available variables**

The callback handler at bootstrap.ts:613 has access to `userId`, `userManager`, `appToggle`, `registry`, and `callbackLogger`. The `app:`-prefixed callback handler at line 659 already does an `isEnabled` check — we replicate that pattern.

- [ ] **Step 2: Add access check to route-verifier callback in bootstrap.ts**

In `core/src/bootstrap.ts`, after `const appEntry = registry.getApp(chosenAppId);` (line 623), add:

```typescript
					const resolved = await routeVerifier.resolveCallback(pendingId, chosenAppId);
					if (!resolved) return;

					const { entry } = resolved;
					const appEntry = registry.getApp(chosenAppId);

					// Verify user has access to the chosen app
					if (chosenAppId !== 'chatbot') {
						const enabledApps = userManager.getUserApps(userId);
						if (!(await appToggle.isEnabled(userId, chosenAppId, enabledApps))) {
							callbackLogger.debug({ chosenAppId, userId }, 'Verification callback for disabled app');
							return;
						}
					}

					// Dispatch to chosen app (wrap in LLM context for cost tracking)
					await requestContext.run({ userId }, async () => {
```

- [ ] **Step 3: Run full test suite to ensure no regressions**

Run: `pnpm vitest run core/src/services/router/__tests__/router-verification.test.ts core/src/services/router/__tests__/router.test.ts`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add core/src/bootstrap.ts
git commit -m "fix(bootstrap): add access check to route-verifier callback

The Telegram callback handler for route-verification inline buttons now
checks appToggle.isEnabled before dispatching to the chosen app, matching
the existing check in the app-specific callback handler.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Move AsyncLock to core

**Files:**
- Create: `core/src/utils/async-lock.ts`
- Modify: `apps/food/src/utils/async-lock.ts` (re-export from core)
- Test: `core/src/utils/__tests__/async-lock.test.ts`

- [ ] **Step 1: Read existing food async-lock tests**

Read: `apps/food/src/utils/__tests__/async-lock.test.ts` to understand existing coverage.

- [ ] **Step 2: Copy AsyncLock to core**

Create `core/src/utils/async-lock.ts` with the exact same implementation:

```typescript
/**
 * Tiny per-key promise-chain lock used to serialize read-modify-write
 * sequences against shared stores.
 *
 * Usage:
 *   const lock = new AsyncLock();
 *   await lock.run('key', async () => {
 *     const data = await readFile(store);
 *     mutate(data);
 *     await writeFile(store, data);
 *   });
 */

export class AsyncLock {
	private readonly chains = new Map<string, Promise<unknown>>();

	async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(() => fn());
		this.chains.set(key, next);
		try {
			return await next;
		} finally {
			if (this.chains.get(key) === next) {
				this.chains.delete(key);
			}
		}
	}
}
```

- [ ] **Step 3: Update food's async-lock to re-export from core**

Replace `apps/food/src/utils/async-lock.ts` with:

```typescript
/**
 * Re-export from core — the canonical AsyncLock now lives in core/src/utils/async-lock.ts.
 */
export { AsyncLock } from '@core/utils/async-lock.js';
```

- [ ] **Step 4: Create core async-lock test**

Create `core/src/utils/__tests__/async-lock.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { AsyncLock } from '../async-lock.js';

describe('AsyncLock', () => {
	it('serializes operations on the same key', async () => {
		const lock = new AsyncLock();
		const order: number[] = [];

		const p1 = lock.run('k', async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push(1);
		});
		const p2 = lock.run('k', async () => {
			order.push(2);
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});

	it('allows concurrent operations on different keys', async () => {
		const lock = new AsyncLock();
		const order: string[] = [];

		const p1 = lock.run('a', async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push('a');
		});
		const p2 = lock.run('b', async () => {
			order.push('b');
		});

		await Promise.all([p1, p2]);
		// 'b' should complete before 'a' since they're independent
		expect(order).toEqual(['b', 'a']);
	});

	it('does not poison the chain on error', async () => {
		const lock = new AsyncLock();

		await expect(lock.run('k', async () => {
			throw new Error('fail');
		})).rejects.toThrow('fail');

		// Subsequent operation should still work
		const result = await lock.run('k', async () => 'ok');
		expect(result).toBe('ok');
	});
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run core/src/utils/__tests__/async-lock.test.ts apps/food/src/utils/__tests__/async-lock.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add core/src/utils/async-lock.ts core/src/utils/__tests__/async-lock.test.ts apps/food/src/utils/async-lock.ts
git commit -m "refactor: move AsyncLock to core for reuse by InviteService

The per-key promise-chain lock is now in core/src/utils/async-lock.ts.
The food app re-exports from core so existing imports are unaffected.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Add atomic claimAndRedeem to InviteService

**Files:**
- Modify: `core/src/services/invite/index.ts`
- Test: `core/src/services/invite/__tests__/index.test.ts`

- [ ] **Step 1: Write failing test — concurrent redemptions produce exactly one success**

Add to `core/src/services/invite/__tests__/index.test.ts`:

```typescript
describe('claimAndRedeem', () => {
	it('atomically validates and redeems a code', async () => {
		const svc = makeService();
		const code = await svc.createInvite('Alice', 'admin');

		const result = await svc.claimAndRedeem(code, '111');
		expect('invite' in result).toBe(true);

		const store = await svc.listInvites();
		expect(store[code].usedBy).toBe('111');
		expect(store[code].usedAt).not.toBeNull();
	});

	it('rejects expired codes', async () => {
		const svc = makeService();
		const code = await svc.createInvite('Alice', 'admin');

		// Force expiry by modifying the store
		const store = await svc.listInvites();
		store[code].expiresAt = new Date(Date.now() - 1000).toISOString();
		// Write back via createInvite workaround — we need writeStore access
		// Instead, use a second svc instance that reads the manipulated file
		const { writeYamlFile } = await import('../../../../utils/yaml.js');
		const { join } = await import('node:path');
		await writeYamlFile(join(tempDir, 'system', 'invites.yaml'), store);

		const result = await svc.claimAndRedeem(code, '111');
		expect(result).toEqual({ error: 'This invite code has expired. Ask the admin for a new one.' });
	});

	it('rejects already-used codes', async () => {
		const svc = makeService();
		const code = await svc.createInvite('Alice', 'admin');
		await svc.claimAndRedeem(code, '111');

		const result = await svc.claimAndRedeem(code, '222');
		expect(result).toEqual({ error: 'This invite code has already been used.' });
	});

	it('allows exactly one winner in concurrent redemptions', async () => {
		const svc = makeService();
		const code = await svc.createInvite('Alice', 'admin');

		const results = await Promise.all([
			svc.claimAndRedeem(code, '111'),
			svc.claimAndRedeem(code, '222'),
		]);

		const successes = results.filter((r) => 'invite' in r);
		const failures = results.filter((r) => 'error' in r);

		expect(successes).toHaveLength(1);
		expect(failures).toHaveLength(1);

		// The winner's ID is persisted
		const store = await svc.listInvites();
		const winner = successes[0] as { invite: { usedBy: string } };
		expect(store[code].usedBy).toBe(
			results.indexOf(successes[0]) === 0 ? '111' : '222',
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/invite/__tests__/index.test.ts`
Expected: FAIL — `claimAndRedeem` does not exist.

- [ ] **Step 3: Implement claimAndRedeem on InviteService**

In `core/src/services/invite/index.ts`, add the import and lock:

```typescript
import { AsyncLock } from '../../utils/async-lock.js';
```

Add to the class:

```typescript
export class InviteService {
	private readonly invitesPath: string;
	private readonly logger: Logger;
	private readonly lock = new AsyncLock();

	// ... existing constructor and methods ...

	/**
	 * Atomically validate and redeem an invite code.
	 * Returns the invite on success, or an error message on failure.
	 * Serialized per-code to prevent race conditions.
	 */
	async claimAndRedeem(
		code: string,
		usedBy: string,
	): Promise<{ invite: InviteCode } | { error: string }> {
		return this.lock.run(`invite:${code}`, async () => {
			const store = await this.readStore();
			const invite = store[code];

			if (!invite) {
				return { error: 'Invalid invite code.' };
			}

			if (invite.usedBy !== null) {
				return { error: 'This invite code has already been used.' };
			}

			if (new Date(invite.expiresAt) <= new Date()) {
				return { error: 'This invite code has expired. Ask the admin for a new one.' };
			}

			invite.usedBy = usedBy;
			invite.usedAt = new Date().toISOString();

			await this.writeStore(store);
			this.logger.info({ code, usedBy }, 'Invite code claimed and redeemed');

			return { invite };
		});
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/invite/__tests__/index.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/invite/index.ts core/src/services/invite/__tests__/index.test.ts
git commit -m "fix(invite): add atomic claimAndRedeem to prevent race conditions

InviteService.claimAndRedeem() validates and redeems in a single
per-code-locked operation. Concurrent /start requests for the same
code now correctly produce exactly one winner.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Update callers to use claimAndRedeem

**Files:**
- Modify: `core/src/services/user-manager/user-guard.ts:70-95`
- Modify: `core/src/services/router/index.ts:736-760`
- Test: `core/src/services/user-manager/__tests__/user-guard.test.ts` (verify existing tests still pass)

- [ ] **Step 1: Read UserGuard.checkUser invite flow**

Read: `core/src/services/user-manager/user-guard.ts` lines 49-95.

- [ ] **Step 2: Read Router.handleInviteRedemption**

Read: `core/src/services/router/index.ts` lines 736-760.

- [ ] **Step 3: Update UserGuard.checkUser to use claimAndRedeem**

Replace the validate-register-redeem sequence with:

```typescript
if (potentialCode) {
	const result = await this.inviteService.claimAndRedeem(potentialCode, userId);
	if ('invite' in result) {
		const newUser = { id: userId, name: result.invite.name, isAdmin: false, enabledApps: ['*'], sharedScopes: [] };
		await this.userMutationService.registerUser(newUser);
		// ... send welcome message (keep existing code) ...
		return true;
	}
	// ... send error message (keep existing code) ...
	return false;
}
```

Note: registration now happens AFTER the code is claimed, so if registration fails the code is used but the user isn't registered. This is safer — an admin can manually create a new code. The alternative (registering first) leaves phantom users on failure.

- [ ] **Step 4: Update Router.handleInviteRedemption to use claimAndRedeem**

Replace the validate-register-redeem sequence with the same pattern:

```typescript
private async handleInviteRedemption(code: string, userId: string): Promise<void> {
	if (!this.inviteService || !this.userMutationService) return;
	const result = await this.inviteService.claimAndRedeem(code, userId);
	if ('error' in result) {
		await this.trySend(userId, result.error);
		return;
	}
	const newUser = { id: userId, name: result.invite.name, isAdmin: false, enabledApps: ['*'], sharedScopes: [] };
	await this.userMutationService.registerUser(newUser);
	await this.trySend(userId, `Welcome to PAS, ${result.invite.name}! ...`);
}
```

- [ ] **Step 5: Run related tests**

Run: `pnpm vitest run core/src/services/user-manager/__tests__/user-guard.test.ts core/src/services/router/__tests__/invite-command.test.ts core/src/services/router/__tests__/realistic-invite-journey.test.ts core/src/services/invite/__tests__/index.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add core/src/services/user-manager/user-guard.ts core/src/services/router/index.ts
git commit -m "fix(invite): switch callers to atomic claimAndRedeem

UserGuard.checkUser and Router.handleInviteRedemption now use
claimAndRedeem instead of separate validateCode + redeemCode calls.
Registration happens after the code is atomically claimed.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Harden redeemCode to reject already-used codes

**Files:**
- Modify: `core/src/services/invite/index.ts:94-107`
- Test: `core/src/services/invite/__tests__/index.test.ts`

- [ ] **Step 1: Write failing test — redeemCode rejects already-used code**

Update the misleading existing test and add a new one:

```typescript
it('redeemCode rejects already-used codes', async () => {
	const svc = makeService();
	const code = await svc.createInvite('Alice', 'admin');
	await svc.redeemCode(code, '111');

	await expect(svc.redeemCode(code, '222')).rejects.toThrow('already been used');
});

it('redeemCode rejects expired codes', async () => {
	const svc = makeService();
	const code = await svc.createInvite('Alice', 'admin');

	const store = await svc.listInvites();
	store[code].expiresAt = new Date(Date.now() - 1000).toISOString();
	const { writeYamlFile } = await import('../../../../utils/yaml.js');
	const { join } = await import('node:path');
	await writeYamlFile(join(tempDir, 'system', 'invites.yaml'), store);

	await expect(svc.redeemCode(code, '111')).rejects.toThrow('expired');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run core/src/services/invite/__tests__/index.test.ts`
Expected: FAIL — redeemCode currently doesn't check `usedBy` or expiry.

- [ ] **Step 3: Harden redeemCode**

Update `redeemCode` in `core/src/services/invite/index.ts`:

```typescript
async redeemCode(code: string, usedBy: string): Promise<void> {
	const store = await this.readStore();
	const invite = store[code];

	if (!invite) {
		throw new Error(`Invite code not found: ${code}`);
	}

	if (invite.usedBy !== null) {
		throw new Error('This invite code has already been used.');
	}

	if (new Date(invite.expiresAt) <= new Date()) {
		throw new Error('This invite code has expired.');
	}

	invite.usedBy = usedBy;
	invite.usedAt = new Date().toISOString();

	await this.writeStore(store);
	this.logger.info({ code, usedBy }, 'Invite code redeemed');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run core/src/services/invite/__tests__/index.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/invite/index.ts core/src/services/invite/__tests__/index.test.ts
git commit -m "fix(invite): harden redeemCode to reject used and expired codes

redeemCode now validates usedBy and expiresAt before writing, providing
defense-in-depth even though the primary path uses claimAndRedeem.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass with no regressions.

- [ ] **Step 2: Update findings document**

Mark F1 and F2 as `fixed` in `docs/codebase-review-findings.md`.
