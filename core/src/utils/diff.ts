/**
 * generateDiff - Generate a unified diff between two file versions
 *
 * Returns a human-readable unified diff string suitable for display in Telegram.
 * - If before === after, returns '' (empty string)
 * - Truncates output to ~3000 chars if it would exceed that (appends a truncation notice)
 * - Produces a minimal unified diff with file header and @@ hunk headers
 * - Context lines: 2 lines before/after each changed line
 */

export function generateDiff(
  before: string,
  after: string,
  filePath: string
): string {
  if (before === after) {
    return '';
  }

  // Split preserving all lines including trailing empty from final newline
  const beforeLines = before === '' ? [] : before.split('\n');
  const afterLines = after === '' ? [] : after.split('\n');

  // Find the longest common subsequence to identify matching lines
  const lcs = computeLCS(beforeLines, afterLines);

  if (beforeLines.length === afterLines.length && lcs.length === beforeLines.length) {
    // No changes detected
    return '';
  }

  // Build hunks with 2-line context
  const hunks = buildHunks(beforeLines, afterLines, lcs);

  if (hunks.length === 0) {
    return '';
  }

  // Build the diff output
  let output = `--- a/${filePath}\n+++ b/${filePath}\n`;

  for (const hunk of hunks) {
    output += formatHunk(hunk);
  }

  // Truncate if necessary
  const MAX_LENGTH = 3000;
  if (output.length > MAX_LENGTH) {
    output = output.substring(0, MAX_LENGTH);
    // Trim to last complete line
    const lastNewline = output.lastIndexOf('\n');
    if (lastNewline > 0) {
      output = output.substring(0, lastNewline);
    }
    output += '\n... (diff truncated)\n';
  }

  return output;
}

interface Hunk {
  lines: Array<{ type: 'context' | 'remove' | 'add'; text: string }>;
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
}

function computeLCS(before: string[], after: string[]): Array<[number, number]> {
  // Compute longest common subsequence to find matching lines
  const m = before.length;
  const n = after.length;

  // DP table: dp[i][j] = length of LCS of before[0..i-1] and after[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (before[i - 1] === after[j - 1]) {
        dp[i]![j] = (dp[i - 1]![j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0);
      }
    }
  }

  // Backtrack to find the actual matching pairs
  const matches: Array<[number, number]> = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (before[i - 1] === after[j - 1]) {
      matches.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if ((dp[i - 1]![j] ?? 0) > (dp[i]![j - 1] ?? 0)) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

function buildHunks(beforeLines: string[], afterLines: string[], matches: Array<[number, number]>): Hunk[] {
  // Build a map of which before/after lines are part of the LCS
  const matchedBefore = new Set(matches.map((m) => m[0]));
  const matchedAfter = new Set(matches.map((m) => m[1]));

  // Build operation list
  const ops: Array<{ type: 'context' | 'remove' | 'add'; beforeIdx?: number; afterIdx?: number }> = [];

  let bIdx = 0;
  let aIdx = 0;

  for (const [mb, ma] of matches) {
    // Add removes for unmatched before lines
    while (bIdx < mb) {
      ops.push({ type: 'remove', beforeIdx: bIdx });
      bIdx++;
    }

    // Add adds for unmatched after lines
    while (aIdx < ma) {
      ops.push({ type: 'add', afterIdx: aIdx });
      aIdx++;
    }

    // Add context for matched line
    ops.push({ type: 'context', beforeIdx: bIdx, afterIdx: aIdx });
    bIdx++;
    aIdx++;
  }

  // Handle trailing differences
  while (bIdx < beforeLines.length) {
    ops.push({ type: 'remove', beforeIdx: bIdx });
    bIdx++;
  }

  while (aIdx < afterLines.length) {
    ops.push({ type: 'add', afterIdx: aIdx });
    aIdx++;
  }

  // Group into hunks with 2-line context
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < ops.length) {
    if (ops[i]!.type === 'context') {
      i++;
      continue;
    }

    // Found a change - collect with 2-line context before and after
    const contextBefore = Math.max(0, i - 2);
    let changeEnd = i + 1;

    // Consume all change ops, merging nearby change regions (gap ≤ 4 context lines)
    while (changeEnd < ops.length) {
      if (ops[changeEnd]!.type !== 'context') {
        changeEnd++;
      } else {
        // Look ahead through up to 4 context lines to see if another change follows
        let peek = changeEnd;
        let contextCount = 0;
        while (peek < ops.length && ops[peek]!.type === 'context' && contextCount < 4) {
          peek++;
          contextCount++;
        }
        if (peek < ops.length && ops[peek]!.type !== 'context') {
          // Another change is nearby — extend changeEnd to consume the gap
          changeEnd = peek;
        } else {
          break;
        }
      }
    }

    // Collect 2 lines of context after
    let contextAfter = Math.min(ops.length - 1, changeEnd + 2);

    // Extract the hunk
    const hunkOps = ops.slice(contextBefore, contextAfter + 1);
    i = contextAfter + 1;

    // Count lines in hunk
    let beforeStart = Infinity;
    let beforeEnd = -Infinity;
    let afterStart = Infinity;
    let afterEnd = -Infinity;

    for (const op of hunkOps) {
      if (op.beforeIdx !== undefined) {
        beforeStart = Math.min(beforeStart, op.beforeIdx);
        beforeEnd = Math.max(beforeEnd, op.beforeIdx);
      }
      if (op.afterIdx !== undefined) {
        afterStart = Math.min(afterStart, op.afterIdx);
        afterEnd = Math.max(afterEnd, op.afterIdx);
      }
    }

    const hunk: Hunk = {
      beforeStart: beforeStart === Infinity ? 0 : beforeStart + 1,
      beforeCount: beforeEnd === -Infinity ? 0 : beforeEnd - beforeStart + 1,
      afterStart: afterStart === Infinity ? 0 : afterStart + 1,
      afterCount: afterEnd === -Infinity ? 0 : afterEnd - afterStart + 1,
      lines: hunkOps.map((op) => ({
        type: op.type,
        text:
          op.type === 'remove'
            ? (beforeLines[op.beforeIdx!] ?? '')
            : op.type === 'add'
              ? (afterLines[op.afterIdx!] ?? '')
              : (beforeLines[op.beforeIdx!] ?? ''),
      })),
    };

    hunks.push(hunk);
  }

  return hunks;
}

function formatHunk(hunk: Hunk): string {
  let output = `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@\n`;

  for (const line of hunk.lines) {
    const prefix = line.type === 'remove' ? '-' : line.type === 'add' ? '+' : ' ';
    output += prefix + line.text + '\n';
  }

  return output;
}
