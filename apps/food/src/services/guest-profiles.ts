/**
 * Guest profiles service — CRUD for frequent guest dietary profiles.
 *
 * Guests are stored as a YAML array in shared/guests.yaml.
 * Used by the hosting planner to check dietary restrictions when planning events.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { GuestProfile } from '../types.js';

const GUESTS_FILE = 'guests.yaml';

export function slugifyGuestName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export async function loadGuests(store: ScopedDataStore): Promise<GuestProfile[]> {
	const raw = await store.read(GUESTS_FILE);
	if (!raw) return [];

	try {
		const content = stripFrontmatter(raw);
		if (!content.trim()) return [];
		const data = parse(content);
		if (!Array.isArray(data)) return [];
		return data as GuestProfile[];
	} catch {
		return [];
	}
}

export async function saveGuests(store: ScopedDataStore, guests: GuestProfile[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Guest Profiles',
		date: new Date().toISOString(),
		tags: buildAppTags('food', 'guests'),
	});
	const body = stringify(guests);
	await store.write(GUESTS_FILE, fm + body);
}

export async function addGuest(store: ScopedDataStore, guest: GuestProfile): Promise<void> {
	if (!guest.name || guest.name.trim().length === 0) {
		throw new Error('Guest name cannot be empty');
	}
	if (guest.name.length > 100) {
		throw new Error('Guest name is too long (max 100 characters)');
	}
	const guests = await loadGuests(store);
	if (guests.some(g => g.slug === guest.slug)) {
		throw new Error(`Guest "${guest.name}" already exists`);
	}
	guests.push(guest);
	await saveGuests(store, guests);
}

export async function removeGuest(store: ScopedDataStore, slug: string): Promise<boolean> {
	const guests = await loadGuests(store);
	const idx = guests.findIndex(g => g.slug === slug);
	if (idx === -1) return false;
	guests.splice(idx, 1);
	await saveGuests(store, guests);
	return true;
}

export function findGuestByName(guests: GuestProfile[], name: string): GuestProfile | null {
	const lower = name.toLowerCase().trim();

	// Exact match (case-insensitive)
	const exact = guests.find(g => g.name.toLowerCase() === lower);
	if (exact) return exact;

	// Partial match (first name or last name)
	const partial = guests.find(g =>
		g.name.toLowerCase().includes(lower) || lower.includes(g.name.toLowerCase()),
	);
	return partial ?? null;
}

export function formatGuestProfile(guest: GuestProfile): string {
	const lines: string[] = [`**${guest.name}**`];

	if (guest.dietaryRestrictions.length > 0) {
		lines.push(`Diet: ${guest.dietaryRestrictions.join(', ')}`);
	}
	if (guest.allergies.length > 0) {
		lines.push(`Allergies: ${guest.allergies.join(', ')}`);
	}
	if (guest.dietaryRestrictions.length === 0 && guest.allergies.length === 0) {
		lines.push('No restrictions');
	}
	if (guest.notes) {
		lines.push(`Notes: ${guest.notes}`);
	}

	return lines.join('\n');
}

export function formatGuestList(guests: GuestProfile[]): string {
	if (guests.length === 0) {
		return 'No guest profiles saved yet. Use `/hosting guests add` to add one.';
	}

	return guests.map(g => formatGuestProfile(g)).join('\n\n');
}

export function getGuestsWithRestriction(guests: GuestProfile[], restriction: string): GuestProfile[] {
	const lower = restriction.toLowerCase();
	return guests.filter(g =>
		g.dietaryRestrictions.some(r => r.toLowerCase() === lower),
	);
}
