import { describe, it, expect } from 'vitest';
import { generateDiff } from '../diff.js';

describe('generateDiff', () => {
  it('returns empty string when before === after', () => {
    const content = 'line 1\nline 2\nline 3\n';
    const result = generateDiff(content, content, 'test.md');
    expect(result).toBe('');
  });

  it('generates diff for single-line change', () => {
    const before = 'line 1\nline 2\nline 3\n';
    const after = 'line 1\nline 2 modified\nline 3\n';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toContain('--- a/test.md');
    expect(result).toContain('+++ b/test.md');
    expect(result).toContain('-line 2');
    expect(result).toContain('+line 2 modified');
    expect(result).toContain('@@');
  });

  it('generates diff for multi-line changes across different parts', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
    const after = 'a\nB\nc\nd\nE\nf\ng\nH\ni\nj\n';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toContain('--- a/test.md');
    expect(result).toContain('+++ b/test.md');

    // All three changed lines must appear
    expect(result).toContain('-b');
    expect(result).toContain('+B');
    expect(result).toContain('-e');
    expect(result).toContain('+E');
    expect(result).toContain('-h');
    expect(result).toContain('+H');

    // Trailing context after the last change must be present
    // After h→H, lines i and j should appear as context
    expect(result).toContain(' i');
    expect(result).toContain(' j');

    // There must be at least one @@ hunk header and no more than three
    const hunkHeaders = result.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g) ?? [];
    expect(hunkHeaders.length).toBeGreaterThanOrEqual(1);
    expect(hunkHeaders.length).toBeLessThanOrEqual(3);
  });

  it('includes trailing context after last change in a merged hunk', () => {
    // Changes at b→B and d→D are 2 context lines apart; they should merge.
    // After the merge, trailing context lines e and f must be present.
    const before = 'a\nb\nc\nd\ne\nf\n';
    const after = 'a\nB\nc\nD\ne\nf\n';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toContain('-b');
    expect(result).toContain('+B');
    expect(result).toContain('-d');
    expect(result).toContain('+D');

    // Trailing context lines after the last change must be present
    expect(result).toContain(' e');
    expect(result).toContain(' f');

    // Should be a single merged hunk
    const hunkHeaders = result.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g) ?? [];
    expect(hunkHeaders.length).toBe(1);
  });

  it('generates diff for lines added', () => {
    const before = 'line 1\nline 3\n';
    const after = 'line 1\nline 2\nline 2.5\nline 3\n';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toContain('+line 2');
    expect(result).toContain('+line 2.5');
    expect(result).not.toContain('-line 2');
  });

  it('generates diff for lines deleted', () => {
    const before = 'line 1\nline 2\nline 2.5\nline 3\n';
    const after = 'line 1\nline 3\n';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toContain('-line 2');
    expect(result).toContain('-line 2.5');
    expect(result).not.toContain('+line 2');
  });

  it('includes file header with correct path', () => {
    const before = 'a\n';
    const after = 'b\n';
    const result = generateDiff(before, after, 'path/to/file.md');

    expect(result).toContain('--- a/path/to/file.md');
    expect(result).toContain('+++ b/path/to/file.md');
  });

  it('includes hunk headers with @@ markers', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nc\nd\ne\n';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it('truncates output exceeding 3000 chars with truncation notice', () => {
    // Create a large diff
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const before = lines.join('\n');

    // Modify alternating lines to create a large diff
    const modifiedLines = lines.map((line, i) =>
      i % 2 === 0 ? line + ' modified' : line
    );
    const after = modifiedLines.join('\n');

    const result = generateDiff(before, after, 'large.md');

    expect(result.length).toBeLessThanOrEqual(3000 + 100); // Allow some margin for truncation notice
    expect(result).toContain('... (diff truncated)');
  });

  it('preserves context lines in diff output', () => {
    const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n';
    const after = '1\n2\n3\n4\nX\n6\n7\n8\n9\n10\n';
    const result = generateDiff(before, after, 'test.md');

    // Should have context before and after the change
    expect(result).toContain('3');
    expect(result).toContain('4');
    expect(result).toContain('-5');
    expect(result).toContain('+X');
    expect(result).toContain('6');
    expect(result).toContain('7');
  });

  it('handles empty strings correctly', () => {
    const result1 = generateDiff('', '', 'test.md');
    expect(result1).toBe('');

    const result2 = generateDiff('', 'content', 'test.md');
    expect(result2).toContain('+content');

    const result3 = generateDiff('content', '', 'test.md');
    expect(result3).toContain('-content');
  });

  it('handles files without trailing newlines', () => {
    const before = 'line 1\nline 2';
    const after = 'line 1\nline 2 modified';
    const result = generateDiff(before, after, 'test.md');

    expect(result).toContain('-line 2');
    expect(result).toContain('+line 2 modified');
  });

  it('produces minimal diffs with proper line counts', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nc\nd\ne\n';
    const result = generateDiff(before, after, 'test.md');

    // The hunk header should indicate the correct number of lines
    expect(result).toMatch(/@@ -1,5 \+1,5 @@/);
  });
});
