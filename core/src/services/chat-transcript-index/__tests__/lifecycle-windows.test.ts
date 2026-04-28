import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTranscriptIndexImpl } from '../chat-transcript-index.js';

describe('ChatTranscriptIndex lifecycle (Windows-safe)', () => {
  it('open → write → close → rm -rf temp dir succeeds', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pas-fts-lifecycle-'));
    const index = new ChatTranscriptIndexImpl(join(tempDir, 'test.db'));
    await index.upsertSession({
      id: 's1',
      user_id: 'u1',
      household_id: null,
      source: 'telegram',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: null,
      model: null,
      title: null,
    });
    await index.close();
    await expect(rm(tempDir, { recursive: true, force: true })).resolves.not.toThrow();
  });

  it('calling close() twice does not throw', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pas-fts-lifecycle-'));
    try {
      const index = new ChatTranscriptIndexImpl(join(tempDir, 'test.db'));
      await index.close();
      await expect(index.close()).resolves.not.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
