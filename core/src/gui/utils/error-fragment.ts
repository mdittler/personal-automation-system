/**
 * Shared styled error fragment for htmx failure responses (audit I5).
 *
 * `reply.viewAsync()` cannot render a template without the global page
 * layout in this codebase — `@fastify/view`'s eta renderer wraps every
 * `viewAsync` call in `layout.eta` when a global `layout` option is
 * configured (see gui/index.ts view registration), and passing a
 * per-call `opts.layout` throws ("layout can either be set globally or
 * on render, not both"). That is why existing htmx fragments in this
 * codebase (e.g. the settings confirm modal, per-row setting HTML) are
 * built as raw HTML strings rather than rendered through the view
 * engine. `sendErrorFragment` follows the same pattern so the resulting
 * markup swaps cleanly into an htmx target without the surrounding
 * `<html>`/`<nav>` shell.
 *
 * Content is plain-language only — never a raw enum, exception message,
 * or stack trace (see CLAUDE.md voice rules).
 *
 * `views/partials/error-fragment.eta` documents the equivalent markup for
 * routes that DO render through the view engine into a layout-free
 * response (none currently do, given the constraint above) — keep the two
 * in sync if this markup changes.
 */
import type { FastifyReply } from 'fastify';
import { escapeHtml } from '../../utils/escape-html.js';

/** Render the shared styled error fragment for htmx responses (audit I5). */
export function sendErrorFragment(
	reply: FastifyReply,
	status: number,
	title: string,
	hint?: string,
): FastifyReply {
	const hintHtml = hint ? `<p>${escapeHtml(hint)}</p>` : '';
	const html = `<div class="pas-error-card" role="alert"><strong>${escapeHtml(title)}</strong>${hintHtml}</div>`;
	return reply.status(status).type('text/html').send(html);
}
