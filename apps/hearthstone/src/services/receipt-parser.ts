/**
 * Receipt parser — uses LLM vision to extract data from grocery receipt photos.
 */

import type { CoreServices } from '@pas/core/types';
import type { ReceiptLineItem } from '../types.js';
import { parseJsonResponse } from './recipe-parser.js';

/** Parsed receipt data (before ID/path assignment). */
export interface ParsedReceipt {
	store: string;
	date: string;
	lineItems: ReceiptLineItem[];
	subtotal: number | null;
	tax: number | null;
	total: number;
}

const RECEIPT_PROMPT = `You are a grocery receipt parser. Extract data from this receipt photo.

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
- date is ISO format (YYYY-MM-DD), use today if unclear
- lineItems: extract as many items as you can read clearly
- unitPrice can be null if not visible
- subtotal and tax can be null if not visible
- total is REQUIRED — estimate from lineItems if necessary`;

/**
 * Parse a grocery receipt from a photo using LLM vision.
 */
export async function parseReceiptFromPhoto(
	services: CoreServices,
	photo: Buffer,
	mimeType: string,
): Promise<ParsedReceipt> {
	const result = await services.llm.complete(
		`${RECEIPT_PROMPT}\n\nExtract the receipt data from the attached photo.`,
		{
			tier: 'standard',
			images: [{ data: photo, mimeType }],
		},
	);

	const parsed = parseJsonResponse(result, 'receipt parse') as Record<string, unknown>;

	if (typeof parsed.total !== 'number') {
		throw new Error('Could not extract a total from the receipt. Please ensure the receipt is clearly visible.');
	}

	return {
		store: typeof parsed.store === 'string' ? parsed.store : 'Unknown',
		date: typeof parsed.date === 'string' ? parsed.date : new Date().toISOString().slice(0, 10),
		lineItems: Array.isArray(parsed.lineItems) ? (parsed.lineItems as ReceiptLineItem[]) : [],
		subtotal: typeof parsed.subtotal === 'number' ? parsed.subtotal : null,
		tax: typeof parsed.tax === 'number' ? parsed.tax : null,
		total: parsed.total as number,
	};
}
