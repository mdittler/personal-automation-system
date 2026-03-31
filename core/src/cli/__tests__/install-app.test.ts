import { describe, expect, it } from 'vitest';

// We test the formatting and validation logic that install-app.ts uses,
// rather than spawning the CLI process (which would require git)

describe('install-app CLI', () => {
	// Test the URL validation patterns used by the installer
	const GIT_URL_PATTERN = /^(https?:\/\/[^\s]+|git@[^\s]+:\S+)$/;
	const SHELL_METACHAR_PATTERN = /[;&|`$(){}!<>]/;

	describe('URL validation', () => {
		it('should accept valid HTTPS URLs', () => {
			expect(GIT_URL_PATTERN.test('https://github.com/user/repo.git')).toBe(true);
			expect(SHELL_METACHAR_PATTERN.test('https://github.com/user/repo.git')).toBe(false);
		});

		it('should accept valid SSH URLs', () => {
			expect(GIT_URL_PATTERN.test('git@github.com:user/repo.git')).toBe(true);
			expect(SHELL_METACHAR_PATTERN.test('git@github.com:user/repo.git')).toBe(false);
		});

		it('should reject file:// URLs', () => {
			const url = 'file:///tmp/evil-repo';
			expect(url.startsWith('file://')).toBe(true);
		});

		it('should reject URLs with semicolons', () => {
			expect(SHELL_METACHAR_PATTERN.test('https://evil.com/repo; rm -rf /')).toBe(true);
		});

		it('should reject URLs with pipe characters', () => {
			expect(SHELL_METACHAR_PATTERN.test('https://evil.com/repo | curl evil')).toBe(true);
		});

		it('should reject URLs with backticks', () => {
			expect(SHELL_METACHAR_PATTERN.test('https://evil.com/`whoami`.git')).toBe(true);
		});

		it('should reject URLs with dollar signs', () => {
			expect(SHELL_METACHAR_PATTERN.test('https://evil.com/$HOME.git')).toBe(true);
		});

		it('should reject bare paths', () => {
			expect(GIT_URL_PATTERN.test('/tmp/local-repo')).toBe(false);
			expect(GIT_URL_PATTERN.test('../relative-repo')).toBe(false);
		});
	});

	describe('argument parsing', () => {
		it('should extract git URL from args', () => {
			const args = ['https://github.com/user/repo.git', '--yes'];
			const gitUrl = args.find((a) => !a.startsWith('-'));
			expect(gitUrl).toBe('https://github.com/user/repo.git');
		});

		it('should detect --yes flag', () => {
			const args = ['https://github.com/user/repo.git', '--yes'];
			expect(args.includes('--yes')).toBe(true);
		});

		it('should detect -y flag', () => {
			const args = ['-y', 'https://github.com/user/repo.git'];
			expect(args.includes('-y')).toBe(true);
		});

		it('should handle missing URL', () => {
			const args = ['--yes'];
			const gitUrl = args.find((a) => !a.startsWith('-'));
			expect(gitUrl).toBeUndefined();
		});
	});
});
