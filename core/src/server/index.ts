/**
 * Fastify server setup.
 *
 * Creates and configures the Fastify HTTP server with plugins
 * for cookies, static files, and template rendering.
 * Routes are registered by the caller (bootstrap).
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { Logger } from 'pino';

export interface ServerOptions {
	logger: Logger;
	/** Secret for signing cookies. */
	cookieSecret?: string;
	/** Enable trust proxy (set to true when behind a reverse proxy like Cloudflare Tunnel). */
	trustProxy?: boolean;
}

const moduleDir = join(fileURLToPath(import.meta.url), '..');
const guiDir = join(moduleDir, '..', 'gui');

/**
 * Create a configured Fastify instance.
 * Does NOT call listen() — that's done by bootstrap.
 */
export async function createServer(options: ServerOptions) {
	const server = Fastify({
		loggerInstance: options.logger as FastifyBaseLogger,
		trustProxy: options.trustProxy ?? false,
	});

	// Parse application/x-www-form-urlencoded POST bodies
	await server.register(fastifyFormbody);

	// Cookie plugin for auth
	await server.register(fastifyCookie, {
		secret: options.cookieSecret,
	});

	// Static file serving for GUI assets
	await server.register(fastifyStatic, {
		root: join(guiDir, 'public'),
		prefix: '/gui/public/',
		decorateReply: false,
	});

	// Template engine (Eta) for GUI views
	const eta = new Eta();
	await server.register(fastifyView, {
		engine: { eta },
		root: join(guiDir, 'views'),
		viewExt: 'eta',
		layout: 'layout',
	});

	return server;
}

// Re-export route registrations for convenience
export { registerHealthRoute } from './health.js';
export { registerWebhookRoute } from './webhook.js';
export type { WebhookRouteOptions } from './webhook.js';
