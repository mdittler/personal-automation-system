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

export class NoActiveSessionError extends Error {
	constructor(message = 'No active session') {
		super(message);
		this.name = 'NoActiveSessionError';
	}
}

export class SessionCasMismatchError extends Error {
	constructor(message = 'Session changed during rebuild') {
		super(message);
		this.name = 'SessionCasMismatchError';
	}
}
