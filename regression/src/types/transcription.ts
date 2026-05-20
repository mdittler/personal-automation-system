export type TranscriptionConfidence = 'high' | 'low';

export interface TranscriptionLineItem {
	name: string;
	quantity?: number;
	unitPrice?: number | null;
	totalPrice: number;
	confidence: TranscriptionConfidence;
}

export interface ReceiptTranscription {
	store?: string;
	date?: string;
	subtotal?: number;
	tax?: number;
	total: number;
	lineItems: TranscriptionLineItem[];
}
