import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MigrationBackupError,
  createMigrationBackup,
} from '../migration-backup.js';

let tempDir: string;
let dataDir: string;
let destParentDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pas-migration-backup-test-'));
  dataDir = join(tempDir, 'data');
  destParentDir = join(tempDir, 'parent');
  await mkdir(dataDir, { recursive: true });
  await mkdir(destParentDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('createMigrationBackup', () => {
  it('happy path — copies 3 files in nested dirs and returns correct BackupResult', async () => {
    // Build a fixture with 3 files in nested directories.
    await mkdir(join(dataDir, 'sub', 'deep'), { recursive: true });
    await writeFile(join(dataDir, 'root.txt'), 'hello', 'utf-8');
    await writeFile(join(dataDir, 'sub', 'middle.txt'), 'world', 'utf-8');
    await writeFile(join(dataDir, 'sub', 'deep', 'leaf.md'), '# leaf', 'utf-8');

    const srcBytes =
      Buffer.byteLength('hello', 'utf-8') +
      Buffer.byteLength('world', 'utf-8') +
      Buffer.byteLength('# leaf', 'utf-8');

    const result = await createMigrationBackup(dataDir, destParentDir);

    // Shape of the returned result.
    expect(result.fileCount).toBe(3);
    expect(result.bytes).toBe(srcBytes);
    expect(result.path).toContain('data-backup-pre-household-migration-');

    // Backup dir is a sibling of dataDir, i.e. its parent is destParentDir.
    expect(result.path.startsWith(destParentDir)).toBe(true);

    // Verify content of one file.
    const copied = await readFile(join(result.path, 'root.txt'), 'utf-8');
    expect(copied).toBe('hello');
  });

  it('empty source dir — returns fileCount: 0, bytes: 0', async () => {
    // dataDir exists but has no files.
    const result = await createMigrationBackup(dataDir, destParentDir);

    expect(result.fileCount).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.path).toContain('data-backup-pre-household-migration-');
  });

  it('injectable _backupFn is called; mismatch causes MigrationBackupError', async () => {
    // Source has 2 files.
    await writeFile(join(dataDir, 'a.txt'), 'aaa', 'utf-8');
    await writeFile(join(dataDir, 'b.txt'), 'bbb', 'utf-8');

    let fnCalled = false;

    // The injected function creates the dest dir but leaves it empty.
    const _backupFn = vi.fn(async (_src: string, dest: string) => {
      fnCalled = true;
      await mkdir(dest, { recursive: true });
      // Deliberately copy nothing — verification should fail.
    });

    await expect(
      createMigrationBackup(dataDir, destParentDir, { _backupFn }),
    ).rejects.toThrow(MigrationBackupError);

    expect(fnCalled).toBe(true);
    expect(_backupFn).toHaveBeenCalledOnce();
  });

  it('verification fails when _backupFn does nothing (no dir created)', async () => {
    await writeFile(join(dataDir, 'file.txt'), 'data', 'utf-8');

    // Does absolutely nothing — backup dir never gets created.
    const _backupFn = vi.fn(async () => {
      // intentionally empty
    });

    await expect(
      createMigrationBackup(dataDir, destParentDir, { _backupFn }),
    ).rejects.toThrow(MigrationBackupError);
  });

  it('file count mismatch — throws MigrationBackupError with useful message', async () => {
    await writeFile(join(dataDir, 'one.txt'), 'one', 'utf-8');
    await writeFile(join(dataDir, 'two.txt'), 'two', 'utf-8');
    await writeFile(join(dataDir, 'three.txt'), 'three', 'utf-8');

    // Only copies 1 of the 3 source files.
    const _backupFn = vi.fn(async (_src: string, dest: string) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, 'one.txt'), 'one', 'utf-8');
    });

    const error = await createMigrationBackup(dataDir, destParentDir, {
      _backupFn,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationBackupError);
    expect((error as MigrationBackupError).message).toMatch(/3.*1|1.*3/);
  });
});
