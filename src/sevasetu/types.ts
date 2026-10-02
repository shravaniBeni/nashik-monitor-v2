/**
 * SevaSetu Assist API — public contract types for Nashik Monitor
 *
 * This file contains only the subset of the SevaSetu /api/assist contract
 * that Nashik Monitor needs to consume. It does not import from sevasetu-api.
 * The two codebases remain independent; this file is the integration boundary.
 *
 * Source of truth: sevasetu-api/src/types/index.ts
 * API reference:   sevasetu-api/README.md
 */

// ─── Language ─────────────────────────────────────────────────────────────────

export type SupportedLanguageCode =
  | 'en-IN'
  | 'hi-IN'
  | 'mr-IN'
  | 'ta-IN'
  | 'gu-IN'
  | 'bn-IN'
  | 'te-IN'
  | 'kn-IN';

// ─── Location sent to the API ─────────────────────────────────────────────────

/**
 * Location coordinates passed to POST /api/assist.
 * These must be real coordinates from GPS or an explicit volunteer selection.
 * Never substitute approximate or default coordinates when location is unknown.
 */
export interface AssistLocation {
  lat: number;
  lng: number;
  /** Optional human-readable label for diagnostics/display */
  label?: string;
}

// ─── Request ──────────────────────────────────────────────────────────────────

export interface AssistRequest {
  message: string;
  location: AssistLocation;
  /**
   * Language code or 'auto' (server-side detection).
   * Defaults to 'auto' when omitted.
   */
  language?: SupportedLanguageCode | 'auto';
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface AssistIntent {
  intent: 'find_location' | 'directions' | 'emergency' | 'clarify' | 'greeting' | 'current_location' | 'ambiguous_vehicle';
  /** POI category — absent for greetings, clarifications, current_location, ambiguous_vehicle */
  category?: string;
  urgency: 'normal' | 'high' | 'critical';
  /** Suggested reply text when intent is 'clarify', 'greeting', or 'ambiguous_vehicle' */
  clarificationPrompt?: string;
  /** NM-9: type of clarification needed — 'vehicle_type' means car vs two-wheeler */
  clarificationType?: 'vehicle_type';
}

/** Nearest matching point of interest */
export interface AssistPOI {
  id: string;
  name: string;
  categoryLabel: string;
  lat: number;
  lng: number;
  address?: string;
  phone?: string;
  facilityType?: string;
}

export interface AssistRouteStep {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Walking route returned by the engine.
 *
 * IMPORTANT — always check `provider` before displaying steps:
 *
 *   'osrm'     Real turn-by-turn route. Steps are authoritative navigation.
 *              May be displayed and read aloud.
 *
 *   'fallback' Approximate straight-line trajectory. Steps are generic
 *              placeholders, NOT real navigation instructions.
 *              Show destination + distance only; do NOT read steps aloud.
 */
export interface AssistRoute {
  /** [longitude, latitude] pairs — ready for MapLibre GL LineString coordinates */
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  durationMinutes: number;
  steps: AssistRouteStep[];
  provider: 'osrm' | 'fallback';
}

/**
 * Full structured response from POST /api/assist.
 *
 * `poi`, `route`, `distanceMeters`, `durationMinutes` are absent when
 * intent is 'greeting' or 'clarify' — always check before accessing.
 */
export interface AssistResponse {
  /** Localised natural-language reply — safe to display or pass to TTS */
  replyText: string;
  /** Language detected from the input query */
  detectedLanguage: SupportedLanguageCode;
  /** English-normalised query used internally by the engine */
  englishQuery: string;
  intent: AssistIntent;
  /** Present when a facility was found */
  poi?: AssistPOI;
  distanceMeters?: number;
  durationMinutes?: number;
  route?: AssistRoute;
  /**
   * NM-9: Which resolution path fired — 'keyword' | 'sarvam' | 'heuristic' | 'pattern'.
   * Useful for observability — tells you whether the deterministic layer or Sarvam
   * handled the query.
   */
  intentResolution?: 'keyword' | 'sarvam' | 'heuristic' | 'pattern';
}

// ─── Error ────────────────────────────────────────────────────────────────────

export interface AssistErrorResponse {
  error: string;
  code: 'INVALID_REQUEST' | 'NO_POI_FOUND' | 'INTERNAL_ERROR' | string;
}
