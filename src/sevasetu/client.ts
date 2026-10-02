/**
 * SevaSetu Assist API client for Nashik Monitor
 *
 * Thin typed wrapper around POST /api/assist.
 * No framework, no external dependencies — pure browser fetch.
 * No credentials required or accepted on the client side.
 *
 * API base URL is configured via VITE_SEVASETU_API_URL (set in .env.local).
 * In development the Vite proxy transparently forwards /api/assist to the
 * locally running sevasetu-api server.
 */

import type {
  AssistRequest,
  AssistResponse,
  AssistErrorResponse,
  SupportedLanguageCode,
  AssistLocation,
} from './types';

// ─── API URL ──────────────────────────────────────────────────────────────────

// VITE_SEVASETU_API_URL is replaced at build time by Vite.
// For local development a proxy in vite.config.ts forwards /api/assist,
// so the base URL can remain '' (same-origin). In production this is the
// full deployed SevaSetu API URL, e.g. https://api.sevasetu.example
const API_BASE: string =
  (import.meta.env.VITE_SEVASETU_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const ASSIST_ENDPOINT = `${API_BASE}/api/assist`;

const REQUEST_TIMEOUT_MS = 15_000;

// ─── Error types ──────────────────────────────────────────────────────────────

/** Thrown when the network request could not be completed (timeout, offline). */
export class SevasetuNetworkError extends Error {
  readonly originalCause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SevasetuNetworkError';
    this.originalCause = cause;
  }
}

/** Thrown when the server responded with a 4xx or 5xx status. */
export class SevasetuApiError extends Error {
  readonly statusCode: number;
  readonly apiCode: string | undefined;
  constructor(message: string, statusCode: number, apiCode?: string) {
    super(message);
    this.name = 'SevasetuApiError';
    this.statusCode = statusCode;
    this.apiCode = apiCode;
  }
}

// ─── Main client function ─────────────────────────────────────────────────────

/**
 * Calls POST /api/assist and returns a typed AssistResponse.
 *
 * @param message   The volunteer's raw query in any supported language
 * @param location  Real coordinates from GPS or explicit volunteer selection.
 *                  MUST be actual coordinates — never pass default/fake values.
 * @param language  Language code or 'auto' (default). Server detects language
 *                  automatically when 'auto'; explicit code skips detection.
 *
 * @throws SevasetuNetworkError  on timeout or network failure
 * @throws SevasetuApiError      on 4xx/5xx response
 */
export async function askSevaSetu(
  message: string,
  location: AssistLocation,
  language?: SupportedLanguageCode | 'auto',
): Promise<AssistResponse> {
  const body: AssistRequest = { message, location, language };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(ASSIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error)?.name === 'AbortError') {
      throw new SevasetuNetworkError(
        'SevaSetu assistance timed out. Please check your connection and try again.',
        err,
      );
    }
    throw new SevasetuNetworkError(
      'Could not reach the SevaSetu service. Please check your connection.',
      err,
    );
  } finally {
    clearTimeout(timeout);
  }

  // Parse body regardless of status — error responses are also JSON
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new SevasetuNetworkError('SevaSetu returned an unexpected response format.');
  }

  if (!response.ok) {
    const err = data as AssistErrorResponse;
    throw new SevasetuApiError(
      err?.error ?? `Request failed with status ${response.status}`,
      response.status,
      err?.code,
    );
  }

  return data as AssistResponse;
}
