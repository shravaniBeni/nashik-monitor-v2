/**
 * SevaSetu predefined fallback locations for Nashik Monitor
 *
 * When GPS is unavailable, denied, or timed out, the volunteer must select
 * a known location manually. This module provides the typed location list
 * and the location shape that maps directly to AssistLocation.
 *
 * Design decisions:
 *   - Completely independent from the widget UI — no DOM, no imports from
 *     widget.ts or any UI module. The widget imports from here, not the reverse.
 *   - Uses AssistLocation as the coordinate shape so selected coordinates
 *     can be passed directly to askSevaSetu() without transformation.
 *   - These are named volunteer posts / checkpoints, not city-centre guesses.
 *     They are meaningful to a volunteer on the ground.
 *
 * IMPORTANT:
 *   None of these locations is used automatically. A location is only sent to
 *   POST /api/assist after the volunteer explicitly selects it. GPS failure
 *   must surface a selection prompt — never silently pick a default.
 */

import type { AssistLocation } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PredefinedLocation {
  /** Stable identifier for selection state */
  id: string;
  /** Display name shown to the volunteer */
  name: string;
  /** Coordinates passed directly to askSevaSetu() */
  coords: AssistLocation;
}

// ─── Predefined volunteer post locations ─────────────────────────────────────
// These correspond to major volunteer deployment zones around the Kumbh Mela
// pilgrimage area in Nashik–Trimbakeshwar. Each is a named, specific location —
// not an area centroid or city guess.

export const PREDEFINED_LOCATIONS: readonly PredefinedLocation[] = [
  {
    id: 'ramkund-gate',
    name: 'Ramkund Gate Post',
    coords: { lat: 20.0055, lng: 73.7911, label: 'Ramkund Gate Post' },
  },
  {
    id: 'panchavati-north',
    name: 'Panchavati North',
    coords: { lat: 20.0122, lng: 73.7928, label: 'Panchavati North' },
  },
  {
    id: 'tapovan-transit',
    name: 'Tapovan Transit',
    coords: { lat: 20.0274, lng: 73.8171, label: 'Tapovan Transit' },
  },
  {
    id: 'mahamarg-bus-stand',
    name: 'Mahamarg Bus Stand',
    coords: { lat: 19.9905, lng: 73.7810, label: 'Mahamarg Bus Stand' },
  },
  {
    id: 'trimbakeshwar-temple',
    name: 'Trimbakeshwar Temple Gate',
    coords: { lat: 19.9373, lng: 73.5308, label: 'Trimbakeshwar Temple Gate' },
  },
  {
    id: 'nashik-road-station',
    name: 'Nashik Road Railway Station',
    coords: { lat: 19.9523, lng: 73.8327, label: 'Nashik Road Railway Station' },
  },
  {
    id: 'cbs-bus-stand',
    name: 'CBS (Central Bus Stand)',
    coords: { lat: 20.0016, lng: 73.7845, label: 'CBS (Central Bus Stand)' },
  },
] as const;

// ─── Lookup helper ────────────────────────────────────────────────────────────

/**
 * Find a predefined location by its stable id.
 * Returns undefined if the id is not found — callers must handle this.
 */
export function findLocationById(id: string): PredefinedLocation | undefined {
  return PREDEFINED_LOCATIONS.find((loc) => loc.id === id);
}
