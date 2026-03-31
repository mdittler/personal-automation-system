/**
 * User management types.
 *
 * Users are identified by Telegram user ID. Registration is a
 * manual configuration step in config/pas.yaml.
 */

/** A registered user of the system. */
export interface RegisteredUser {
	/** Telegram user ID. */
	id: string;
	/** Display name. */
	name: string;
	/** Whether this user has admin access (management GUI, system config). */
	isAdmin: boolean;
	/** App IDs enabled for this user. ["*"] means all apps. */
	enabledApps: string[];
	/** Shared scope IDs this user can access. */
	sharedScopes: string[];
}
