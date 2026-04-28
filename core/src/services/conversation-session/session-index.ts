import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { withFileLock } from '../../utils/file-mutex.js';
import type { ScopedDataStore } from '../../types/data-store.js';

const INDEX_FILE = 'conversation/active-sessions.yaml';

export interface ActiveSessionEntry {
	id: string;
	started_at: string;
	model: string | null;
}

type SessionMap = Record<string, ActiveSessionEntry>;

async function readMap(store: ScopedDataStore): Promise<SessionMap> {
	const raw = await store.read(INDEX_FILE);
	// ScopedDataStore.read returns '' for missing files
	if (!raw) return {};
	try {
		const parsed = parseYaml(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as SessionMap;
		}
		return {};
	} catch {
		return {};
	}
}

export async function getActive(
	store: ScopedDataStore,
	userId: string,
	key: string,
): Promise<ActiveSessionEntry | undefined> {
	const map = await readMap(store);
	return map[key];
}

export async function setActive(
	store: ScopedDataStore,
	userId: string,
	key: string,
	entry: ActiveSessionEntry,
): Promise<void> {
	await withFileLock(`conversation-session-index:${userId}`, async () => {
		const map = await readMap(store);
		map[key] = entry;
		await store.write(INDEX_FILE, stringifyYaml(map));
	});
}

export async function clearActive(store: ScopedDataStore, userId: string, key: string): Promise<void> {
	await withFileLock(`conversation-session-index:${userId}`, async () => {
		const map = await readMap(store);
		delete map[key];
		await store.write(INDEX_FILE, stringifyYaml(map));
	});
}
