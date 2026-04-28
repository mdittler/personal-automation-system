export class InvalidSessionKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSessionKeyError';
	}
}

export class CorruptTranscriptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CorruptTranscriptError';
	}
}
