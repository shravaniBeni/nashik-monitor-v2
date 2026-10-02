/**
 * Browser GPS service for SevaSetu / Nashik Monitor
 *
 * Wraps navigator.geolocation.watchPosition() in a Promise that resolves once
 * a sufficiently accurate fix arrives, or rejects gracefully after the timeout.
 *
 * Why watchPosition() instead of getCurrentPosition():
 *   On mobile, getCurrentPosition() with enableHighAccuracy:true often returns
 *   the first available fix immediately — which is an IP/WiFi-based network
 *   location (accuracy 50 000 m or worse) before the GPS chip has warmed up.
 *   watchPosition() lets us keep watching and accept only the first fix whose
 *   accuracy is within GPS_ACCURACY_THRESHOLD_M.  Once a good fix arrives the
 *   watcher is cleared immediately so continuous tracking never happens.
 *
 * IMPORTANT:
 *   On failure this module returns a typed error — it does NOT substitute
 *   any default or approximate coordinates. The caller is responsible for
 *   presenting the volunteer with a manual location selection UI.
 *   Fake coordinates must never be sent to POST /api/assist, because they
 *   would return an incorrect nearest POI.
 */

import type { AssistLocation } from './types';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface GpsPosition extends AssistLocation {
  /** Accuracy in metres reported by the browser */
  accuracyMeters: number;
}

export type GpsFailureReason =
  | 'unsupported'   // navigator.geolocation not available in this browser
  | 'denied'        // user denied permission
  | 'unavailable'   // position unavailable (hardware / signal)
  | 'timeout';      // no accurate-enough fix within GPS_TIMEOUT_MS

export interface GpsFailure {
  reason: GpsFailureReason;
  /**
   * Human-readable message suitable for display to the volunteer.
   * Guides them toward the manual location selection fallback.
   */
  userMessage: string;
}

export type GpsResult =
  | { ok: true; position: GpsPosition }
  | { ok: false; error: GpsFailure };

// ─── Configuration ────────────────────────────────────────────────────────────

const GPS_TIMEOUT_MS = 10_000;

/**
 * Maximum age of a cached browser position to accept, in milliseconds.
 *
 * Set to 0 (always fresh) because SevaSetu is a nearest-POI assistant —
 * a position from 30 seconds ago could place the volunteer tens of metres
 * from their actual position, resulting in a different "nearest" facility.
 */
const GPS_MAX_AGE_MS = 0;

/**
 * Accuracy threshold in metres.
 *
 * Fixes with accuracy > this value are logged and skipped; we keep watching
 * for a better fix. The threshold is 200 m — coarse network/IP positions
 * (50 000 m, 5 000 m) are rejected while a reasonable GPS hardware fix
 * (typically 5–50 m outdoors) is accepted.
 *
 * Deliberately not city-specific — no Nashik/Pune coordinates anywhere here.
 */
const GPS_ACCURACY_THRESHOLD_M = 200;

// GeolocationPositionError numeric codes (ECMA-262 / W3C Geolocation spec).
// Using literals rather than GeolocationPositionError.PERMISSION_DENIED etc.
// because the static class properties are absent in Safari ≤ 15 and some
// server-side / test environments that expose the error object but not the class.
const GEO_PERMISSION_DENIED    = 1 as const;  // GeolocationPositionError.PERMISSION_DENIED
const GEO_POSITION_UNAVAILABLE = 2 as const;  // GeolocationPositionError.POSITION_UNAVAILABLE
const GEO_TIMEOUT              = 3 as const;  // GeolocationPositionError.TIMEOUT

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Watches for GPS positions and resolves with the first fix whose accuracy
 * is within GPS_ACCURACY_THRESHOLD_M, or resolves with a failure after
 * GPS_TIMEOUT_MS if no accurate-enough fix arrives.
 *
 * Always resolves — never rejects. Check `result.ok` to distinguish success
 * from failure.
 *
 * Flow:
 *   1. watchPosition() starts — enableHighAccuracy:true, maximumAge:0
 *   2. Each incoming position is checked:
 *        accuracy <= 200m → ACCEPTED: clearWatch(), resolve ok
 *        accuracy >  200m → REJECTED: keep watching, log and discard
 *   3. Any geolocation error → clearWatch(), resolve with typed failure
 *   4. After GPS_TIMEOUT_MS with no accepted fix → clearWatch(), resolve
 *      with a 'timeout' failure so the caller shows the manual-location UI
 *
 * On failure:
 *   - Returns a typed failure reason
 *   - Returns a userMessage explaining what happened and what the volunteer
 *     should do (select a location manually)
 *   - Does NOT substitute any default coordinates
 */
export function getCurrentGpsPosition(): Promise<GpsResult> {
  return new Promise((resolve) => {
    // ── Unsupported ───────────────────────────────────────────────────────────
    if (!('geolocation' in navigator)) {
      resolve({
        ok: false,
        error: {
          reason: 'unsupported',
          userMessage:
            'This browser does not support GPS. Please select your location from the list below.',
        },
      });
      return;
    }

    let watchId: number | null = null;
    let settled = false;

    // ── Resolve exactly once ──────────────────────────────────────────────────
    // Clears the watcher and the timeout before resolving so neither can fire
    // after the promise has already settled.
    const settle = (result: GpsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      resolve(result);
    };

    // ── Manual timeout ────────────────────────────────────────────────────────
    // watchPosition()'s own timeout option resets on every position event, so
    // it does not bound the total acquisition time. We manage the overall
    // deadline ourselves.
    const timeoutHandle = setTimeout(() => {
      settle({
        ok: false,
        error: {
          reason: 'timeout',
          userMessage:
            'Location acquisition timed out. ' +
            'Please select your location from the list below or try again.',
        },
      });
    }, GPS_TIMEOUT_MS);

    // ── Start watching ────────────────────────────────────────────────────────
    watchId = navigator.geolocation.watchPosition(
      // Position callback — may fire multiple times
      (pos) => {
        const accuracyMeters = Math.round(pos.coords.accuracy);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        if (accuracyMeters <= GPS_ACCURACY_THRESHOLD_M) {
          // Good fix — accept and stop watching
          console.info(
            `[SevaSetu GPS] ACCEPTED — lat: ${lat.toFixed(6)}, ` +
            `lng: ${lng.toFixed(6)}, accuracy: ${accuracyMeters}m`,
          );
          settle({ ok: true, position: { lat, lng, accuracyMeters } });
        } else {
          // Too coarse — log and keep watching
          console.info(
            `[SevaSetu GPS] REJECTED — lat: ${lat.toFixed(6)}, ` +
            `lng: ${lng.toFixed(6)}, accuracy: ${accuracyMeters}m ` +
            `(threshold: ${GPS_ACCURACY_THRESHOLD_M}m, still watching…)`,
          );
        }
      },

      // Error callback — any geolocation error ends the watch
      (err) => {
        let reason: GpsFailureReason;
        let userMessage: string;

        switch (err.code) {
          case GEO_PERMISSION_DENIED:
            reason = 'denied';
            userMessage =
              'Location access was denied. Please select your location from the list below, ' +
              'or allow location access in your browser settings and try again.';
            break;
          case GEO_POSITION_UNAVAILABLE:
            reason = 'unavailable';
            userMessage =
              'Your location could not be determined right now. ' +
              'Please select your location from the list below.';
            break;
          case GEO_TIMEOUT:
            // watchPosition fires TIMEOUT if a single position event takes
            // longer than the options.timeout value. We override with our own
            // deadline message so the UX is consistent.
            reason = 'timeout';
            userMessage =
              'Location acquisition timed out. ' +
              'Please select your location from the list below or try again.';
            break;
          default:
            reason = 'unavailable';
            userMessage =
              'Location could not be obtained. ' +
              'Please select your location from the list below.';
        }

        settle({ ok: false, error: { reason, userMessage } });
      },

      // Options
      // enableHighAccuracy: true forces GPS hardware over the IP/WiFi network
      // path. Without it the first fix is often an IP-geolocation result that
      // is hundreds of kilometres off (e.g. ISP PoP in another city).
      //
      // timeout here is set to GPS_TIMEOUT_MS so that if a single position
      // event stalls the error callback fires and our manual timeout also
      // cleans up. Both paths call settle() which is idempotent.
      {
        enableHighAccuracy: true,
        timeout: GPS_TIMEOUT_MS,
        maximumAge: GPS_MAX_AGE_MS,
      },
    );
  });
}
