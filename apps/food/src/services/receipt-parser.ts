/**
 * Receipt parser — uses LLM vision to extract data from grocery receipt photos.
 */

import { getCurrentUserId } from '@pas/core/services/context/request-context';
import type { CoreServices } from '@pas/core/types';
import type { ReceiptLineItem, ReceiptVerificationWarning } from '../types.js';
import { todayDate } from '../utils/date.js';
import {
	isValidReceiptAmount,
	isValidReceiptLineItem,
	normalizeReceiptLineItem,
	validateReceiptIntegrity,
} from '../utils/photo-validators.js';
import { fenceCaption } from '../utils/sanitize.js';
import { parseJsonResponse } from './recipe-parser.js';

export const MAX_RECEIPT_AGE_DAYS = 90;

/**
 * Returns true if `value` is a valid YYYY-MM-DD receipt date:
 * - correct string format, calendar-valid (no Feb 30, etc.)
 * - not in the future relative to todayISO
 * - not older than MAX_RECEIPT_AGE_DAYS days
 */
export function isValidReceiptDate(value: unknown, todayISO: string): boolean {
	if (typeof value !== 'string') return false;
	const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return false;
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false;
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;

	// Calendar-strict: construct and round-trip to catch Feb 30, Apr 31, etc.
	const candidate = new Date(Date.UTC(y, mo - 1, d));
	if (
		candidate.getUTCFullYear() !== y ||
		candidate.getUTCMonth() !== mo - 1 ||
		candidate.getUTCDate() !== d
	)
		return false;

	const todayMatch = todayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!todayMatch) return false;
	const todayDateObj = new Date(
		Date.UTC(Number(todayMatch[1]), Number(todayMatch[2]) - 1, Number(todayMatch[3])),
	);

	// Reject future dates
	if (candidate.getTime() > todayDateObj.getTime()) return false;
	// Reject dates older than MAX_RECEIPT_AGE_DAYS
	const minMs = todayDateObj.getTime() - MAX_RECEIPT_AGE_DAYS * 86400000;
	if (candidate.getTime() < minMs) return false;

	return true;
}

/** Parsed receipt data (before ID/path assignment). */
export interface ParsedReceipt {
	store: string;
	date: string;
	/** The date string extracted by the LLM, preserved only when the sanity-check rejected it. */
	rawExtractedDate?: string;
	lineItems: ReceiptLineItem[];
	subtotal: number | null;
	tax: number | null;
	total: number;
	/** Integrity-check warnings; omitted when the parse is clean. */
	verification_warnings?: ReceiptVerificationWarning[];
}

export function buildReceiptPrompt(todayISO: string): string {
	return `Today is ${todayISO}. You are a grocery receipt parser. Extract data from this receipt photo.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "store": "Store Name",
  "date": "2026-04-05",
  "lineItems": [
    { "name": "Item Name", "quantity": 1, "unitPrice": 3.99, "totalPrice": 3.99, "packageSize": "12 oz" }
  ],
  "subtotal": 25.50,
  "tax": 1.53,
  "total": 27.03
}

Rules:
- store is the store/retailer name
- date is ISO format (YYYY-MM-DD); if unclear, use today (${todayISO})
- lineItems: extract as many items as you can read clearly
- unitPrice can be null if not visible
- packageSize: emit a parseable size token from the recognized unit set, or null if unknown.
  Recognized units:
    - mass: g, kg, oz, lb (e.g. "12 oz", "5 lb", "1 kg", "100 g")
    - volume: ml, l, fl oz, gal (e.g. "750 ml", "1.5 L", "12 fl oz", "1 gal")
    - count: ct, count, pack, pk, dozen (e.g. "60 ct", "1 pack", "2 dozen")
  Use null when the package size is not visible or not interpretable.
- subtotal and tax can be null if not visible
- total is REQUIRED — emit total exactly as printed on the receipt

IMPORTANT — accuracy over reconciliation:
- Do NOT adjust line item prices to make them sum to the printed subtotal or total.
  It is acceptable for the line items not to sum to the subtotal — the user wants the
  raw data as printed.
- If a line item is partially obscured or you cannot read it confidently, omit it from
  lineItems entirely. Do not guess prices, do not merge two items into one, and do not
  redistribute missing items' cost across the other items.
- Some lines may have a negative totalPrice (discounts, coupons, returns, bottle
  deposits, tender adjustments). Emit those exactly as printed with the negative sign.
- Emit total as printed on the receipt, even if it does not match the sum of your
  extracted line items.`;
}

/** Parsed receipt data WITHOUT integrity warnings — internal staging shape. */
type ParsedReceiptBody = Omit<ParsedReceipt, 'verification_warnings'>;

/**
 * Parse the raw JSON response from the receipt LLM call into the
 * `ParsedReceiptBody` shape, applying date sanity checks and line-item
 * normalization. Throws when the response is missing a usable `total`.
 */
function parseReceiptResponse(
	rawText: string,
	todayISO: string,
	services: CoreServices,
	context: string,
): ParsedReceiptBody {
	const parsed = parseJsonResponse(rawText, context) as Record<string, unknown>;

	if (!isValidReceiptAmount(parsed.total)) {
		throw new Error(
			'Could not extract a total from the receipt. Please ensure the receipt is clearly visible.',
		);
	}

	const lineItems = Array.isArray(parsed.lineItems)
		? ((parsed.lineItems as unknown[])
				.filter(isValidReceiptLineItem)
				.map(normalizeReceiptLineItem) as ReceiptLineItem[])
		: [];

	let date = todayISO;
	let rawExtractedDate: string | undefined;
	if (typeof parsed.date === 'string') {
		if (isValidReceiptDate(parsed.date, todayISO)) {
			date = parsed.date;
		} else {
			rawExtractedDate = parsed.date;
			services.logger.warn('Receipt date failed sanity check; falling back to today: %o', {
				userId: getCurrentUserId(),
				rejectedDate: parsed.date,
				fallbackDate: todayISO,
			});
		}
	} else if (parsed.date !== undefined && parsed.date !== null) {
		services.logger.warn('Receipt date is non-string; falling back to today: %o', {
			userId: getCurrentUserId(),
			rejectedDate: parsed.date,
			fallbackDate: todayISO,
		});
	}

	return {
		store: typeof parsed.store === 'string' ? parsed.store : 'Unknown',
		date,
		...(rawExtractedDate !== undefined ? { rawExtractedDate } : {}),
		lineItems,
		subtotal: isValidReceiptAmount(parsed.subtotal) ? parsed.subtotal : null,
		tax: isValidReceiptAmount(parsed.tax) ? parsed.tax : null,
		total: parsed.total,
	};
}

const CONTINUATION_INSTRUCTION = `

You previously parsed this receipt and emitted the following line items (do NOT repeat them):

{ALREADY_PARSED}

The receipt's printed subtotal is {SUBTOTAL}. Your previous output was truncated before you could enumerate every line item.

List ONLY the items you have not yet emitted, in this JSON format:
{ "lineItems": [ { "name": "...", "quantity": ..., "unitPrice": ..., "totalPrice": ..., "packageSize": "..." } ] }

Rules:
- Do NOT repeat items already in the list above.
- Do NOT adjust prices to make the math tie out.
- If you cannot read additional items clearly, return { "lineItems": [] }.
- Emit ONLY valid JSON (no markdown, no commentary).`;

function buildContinuationPrompt(parsed: ReceiptLineItem[], subtotal: number | null): string {
	const list = parsed
		.map((li, i) => `${i + 1}. ${li.name} — $${li.totalPrice.toFixed(2)}`)
		.join('\n');
	return CONTINUATION_INSTRUCTION.replace('{ALREADY_PARSED}', list || '(none)').replace(
		'{SUBTOTAL}',
		subtotal != null ? `$${subtotal.toFixed(2)}` : 'not visible',
	);
}

/** Multiset key: normalized name + totalPrice in cents. Same name at different prices stays distinct. */
function lineItemKey(li: ReceiptLineItem): string {
	return `${li.name.toLowerCase().trim()}|${Math.round(li.totalPrice * 100)}`;
}

/**
 * Merge first-call line items with continuation line items. Items whose
 * multiset key already appears in the first call's output are dropped from
 * the continuation (the model sometimes re-lists previously emitted items).
 * Items with the same name but different totalPrice are kept distinct.
 */
function mergeLineItems(
	first: ReceiptLineItem[],
	continuation: ReceiptLineItem[],
): ReceiptLineItem[] {
	const seen = new Set<string>(first.map(lineItemKey));
	const out = [...first];
	for (const li of continuation) {
		const key = lineItemKey(li);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(li);
	}
	return out;
}

/**
 * Parse a grocery receipt from a photo using LLM vision.
 *
 * When the first call hits the model's max-output-tokens cap
 * (`finishReason === 'length'`), fires exactly one continuation call asking
 * the model for the items it didn't have room to emit. Merges by multiset.
 * Single-retry cap — never makes a third call regardless of outcome.
 */
export async function parseReceiptFromPhoto(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
	caption?: string,
): Promise<ParsedReceipt> {
	const todayISO = todayDate(services.timezone);
	const captionContext = fenceCaption(caption);
	const first = await services.llm.completeWithMeta(
		`${buildReceiptPrompt(todayISO)}${captionContext}\n\nExtract the receipt data from the attached photo.`,
		{
			tier: 'standard',
			images: [{ data: photo, mimeType }],
			maxTokens: 8192,
		},
	);

	let body = parseReceiptResponse(first.text, todayISO, services, 'receipt parse');
	const initialFinishReason = first.finishReason;
	let continuationParsedOk = true;
	let continuationTruncated = false;

	if (initialFinishReason === 'length') {
		services.logger.warn('Receipt parse output truncated; firing continuation pass: %o', {
			userId: getCurrentUserId(),
			itemsSoFar: body.lineItems.length,
		});
		const cont = await services.llm.completeWithMeta(
			buildContinuationPrompt(body.lineItems, body.subtotal),
			{
				tier: 'standard',
				images: [{ data: photo, mimeType }],
				maxTokens: 8192,
			},
		);
		// Codex P1: the continuation call's own finishReason matters. If it
		// also hits 'length' the merged result is incomplete by construction —
		// even if the partial enumeration happens to make the sum tie out, we
		// owe the user a "still truncated" warning. Hard one-retry cap remains.
		continuationTruncated = cont.finishReason === 'length';
		try {
			const contRaw = parseJsonResponse(cont.text, 'receipt continuation') as Record<
				string,
				unknown
			>;
			const contItems = Array.isArray(contRaw.lineItems)
				? ((contRaw.lineItems as unknown[])
						.filter(isValidReceiptLineItem)
						.map(normalizeReceiptLineItem) as ReceiptLineItem[])
				: [];
			body = { ...body, lineItems: mergeLineItems(body.lineItems, contItems) };
		} catch (err) {
			continuationParsedOk = false;
			services.logger.warn('Receipt continuation parse failed: %o', {
				userId: getCurrentUserId(),
				error: (err as Error).message,
			});
		}
	}

	// Run integrity against the merged data. Pass 'stop' (not the initial
	// finishReason) so output_truncated only fires when the merged state
	// still looks suspect; we re-derive that below.
	const integrityWarnings = validateReceiptIntegrity(body, 'stop');

	const warnings: ReceiptVerificationWarning[] = [...integrityWarnings];
	if (initialFinishReason === 'length') {
		const stillSuspect =
			!continuationParsedOk || continuationTruncated || integrityWarnings.includes('sum_mismatch');
		if (stillSuspect) {
			if (!warnings.includes('output_truncated')) warnings.push('output_truncated');
			if (!warnings.includes('continuation_unresolved')) warnings.push('continuation_unresolved');
		}
	}

	return {
		...body,
		...(warnings.length > 0 ? { verification_warnings: warnings } : {}),
	};
}
