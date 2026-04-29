/**
 * Receipt parser — uses LLM vision to extract data from grocery receipt photos.
 */

import type { CoreServices } from '@pas/core/types';
import type { ReceiptLineItem } from '../types.js';
import { parseJsonResponse } from './recipe-parser.js';
import { fenceCaption } from '../utils/sanitize.js';
import { isValidReceiptLineItem, isValidReceiptAmount } from '../utils/photo-validators.js';
import { todayDate } from '../utils/date.js';

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
	const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
	if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false;
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;

	// Calendar-strict: construct and round-trip to catch Feb 30, Apr 31, etc.
	const candidate = new Date(Date.UTC(y, mo - 1, d));
	if (
		candidate.getUTCFullYear() !== y ||
		candidate.getUTCMonth() !== mo - 1 ||
		candidate.getUTCDate() !== d
	) return false;

	const todayMatch = todayISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!todayMatch) return false;
	const todayDateObj = new Date(Date.UTC(
		Number(todayMatch[1]), Number(todayMatch[2]) - 1, Number(todayMatch[3]),
	));

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
}

function buildReceiptPrompt(todayISO: string): string {
	return `Today is ${todayISO}. You are a grocery receipt parser. Extract data from this receipt photo.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "store": "Store Name",
  "date": "2026-04-05",
  "lineItems": [
    { "name": "Item Name", "quantity": 1, "unitPrice": 3.99, "totalPrice": 3.99 }
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
- subtotal and tax can be null if not visible
- total is REQUIRED — estimate from lineItems if necessary`;
}

/**
 * Parse a grocery receipt from a photo using LLM vision.
 */
export async function parseReceiptFromPhoto(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
	caption?: string,
): Promise<ParsedReceipt> {
	const todayISO = todayDate(services.timezone);
	const captionContext = fenceCaption(caption);
	const result = await services.llm.complete(
		`${buildReceiptPrompt(todayISO)}${captionContext}\n\nExtract the receipt data from the attached photo.`,
		{
			tier: 'standard',
			images: [{ data: photo, mimeType }],
		},
	);

	const parsed = parseJsonResponse(result, 'receipt parse') as Record<string, unknown>;

	if (!isValidReceiptAmount(parsed.total)) {
		throw new Error('Could not extract a total from the receipt. Please ensure the receipt is clearly visible.');
	}

	const lineItems = Array.isArray(parsed.lineItems)
		? (parsed.lineItems as unknown[]).filter(isValidReceiptLineItem) as ReceiptLineItem[]
		: [];

	let date = todayISO;
	let rawExtractedDate: string | undefined;
	if (typeof parsed.date === 'string') {
		if (isValidReceiptDate(parsed.date, todayISO)) {
			date = parsed.date;
		} else {
			rawExtractedDate = parsed.date;
			services.logger.warn('Receipt date failed sanity check; falling back to today: %o', {
				rejectedDate: parsed.date,
				fallbackDate: todayISO,
			});
		}
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
