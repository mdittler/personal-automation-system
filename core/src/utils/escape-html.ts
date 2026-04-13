/**
 * HTML escaping utilities for safe output in templates and partials.
 */

/**
 * Escape HTML special characters to prevent XSS in rendered HTML.
 * Use in htmx partials and anywhere user data is interpolated into HTML strings.
 */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Serialize data as JSON safe for embedding inside a `<script>` block.
 *
 * `JSON.stringify` alone does NOT escape `</script>`, so a value containing
 * that sequence would break out of the script tag and enable XSS.
 * This function replaces `<` with `\u003c`, which the browser JS engine
 * decodes back to `<` inside the JS value while preventing the HTML parser
 * from seeing a closing `</script>` tag.
 *
 * Usage in Eta templates:
 *   var PAS_USERS = <%~ it.safeJsonForScript(users) %>;
 */
export function safeJsonForScript(data: unknown): string {
	return JSON.stringify(data).replace(/</g, '\\u003c');
}
