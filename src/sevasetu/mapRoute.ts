/**
 * SevaSetu map route integration — NM-3 / NM-6.1
 *
 * Manages one active SevaSetu route on the Nashik Monitor MapLibre map:
 *   - A GeoJSON LineString source + line layer for the route geometry
 *   - A user-location marker (blue circle) — "You are here"          (NM-6.1)
 *   - A destination marker (terracotta pin) — the returned POI
 *   - fitBounds to include both markers after rendering
 *   - Replacement of the previous route/markers when a new one arrives
 *   - Remount after style.load (basemap / theme changes wipe custom sources)
 *
 * Responsibilities that stay elsewhere:
 *   - widget.ts  → chat UI, location state, API calls
 *   - client.ts  → POST /api/assist
 *   - main.ts    → map initialisation, existing NM layers
 *
 * Source/layer IDs use the 'sevasetu-' prefix so they cannot collide with
 * any existing Nashik Monitor layer (those are named after GeoJSON files).
 */

import type { Map, LngLatBoundsLike } from 'maplibre-gl';
import maplibregl from 'maplibre-gl';
import type { AssistRoute, AssistPOI, AssistLocation } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTE_SOURCE  = 'sevasetu-route';
const ROUTE_LAYER   = 'sevasetu-route-line';

/** Terracotta accent — matches --accent in the Nashik Monitor palette */
const ROUTE_COLOR   = '#b34a2e';
const ROUTE_WIDTH   = 4;
const ROUTE_OPACITY = 0.85;

/**
 * fitBounds padding (px).
 * Right side is generous to avoid the chat panel (≈374 px wide at 360px + 14px
 * each side). The other edges get comfortable room for both markers.
 */
const FIT_PADDING = { top: 80, bottom: 80, left: 80, right: 420 };

/**
 * Maximum zoom after fitBounds. Very short walking routes (a few metres)
 * would otherwise zoom past street level; cap at 17 so context remains.
 */
const FIT_MAX_ZOOM = 17;

// ─── State ────────────────────────────────────────────────────────────────────

/** The route currently rendered, or null if none. Retained for remount. */
let activeRoute: AssistRoute | null = null;
/** The POI currently shown, or null. Retained for remount. */
let activePoi: AssistPOI | null = null;
/** The user location used for the last request. Retained for remount. */
let activeUserLocation: AssistLocation | null = null;
/** Destination marker — terracotta pin (.ss-dest-marker). */
let destinationMarker: maplibregl.Marker | null = null;
/** User-location marker — blue circle (.ss-user-marker). */
let userMarker: maplibregl.Marker | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a new SevaSetu route (and both markers) on the map.
 *
 * Replaces any previously rendered SevaSetu route/markers.
 * If `route` is undefined/null the previous route is cleared, but the
 * user-location marker is still placed at `userLocation`.
 *
 * Both 'osrm' and 'fallback' routes are rendered — the chat card in widget.ts
 * already shows the "routing unavailable" notice for fallback routes.
 *
 * @param map          The active MapLibre map instance
 * @param route        The route from AssistResponse (may be absent)
 * @param poi          The POI from AssistResponse (may be absent)
 * @param userLocation The location sent to the API — used for the user marker
 *                     and for fitting both endpoints into view.
 */
export function renderSevasetuRoute(
  map: Map,
  route: AssistRoute | undefined,
  poi: AssistPOI | undefined,
  userLocation: AssistLocation,
): void {
  // Always clear the previous SevaSetu route/markers first.
  clearSevasetuRoute(map);

  // Always show the user-location marker at the exact coordinates sent to the
  // API, independent of whether a route was returned. This makes it easy to
  // verify that the correct position was used (Part B, NM-6.1).
  activeUserLocation = userLocation;
  _addUserMarker(map, userLocation);

  if (!route || route.coordinates.length < 2) {
    // No route — user marker stays, nothing else to render.
    return;
  }

  activeRoute = route;
  activePoi   = poi ?? null;

  _addRouteToMap(map, route);

  if (poi) {
    _addDestMarker(map, poi);
  }

  // Fit viewport to include user position, destination, and the full route.
  _fitToBoth(map, userLocation, route);
}

/**
 * Remove the active SevaSetu route, layers, sources, and all markers.
 * Safe to call when nothing is rendered.
 */
export function clearSevasetuRoute(map: Map): void {
  activeRoute        = null;
  activePoi          = null;
  activeUserLocation = null;

  if (map.getLayer(ROUTE_LAYER)) map.removeLayer(ROUTE_LAYER);
  if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);

  destinationMarker?.remove();
  destinationMarker = null;

  userMarker?.remove();
  userMarker = null;
}

/**
 * Re-add the active SevaSetu route and markers after a style reload.
 *
 * MapLibre's setStyle() wipes all custom sources and layers. DOM-based
 * Markers survive style changes but are remove+re-added to ensure correct
 * anchoring after the map canvas is replaced.
 *
 * Does NOT call fitBounds — viewport should not jump on a theme/basemap change.
 */
export function remountSevasetuRoute(map: Map): void {
  // Re-add user marker if we have a stored location.
  userMarker?.remove();
  userMarker = null;
  if (activeUserLocation) {
    _addUserMarker(map, activeUserLocation);
  }

  if (!activeRoute) return;

  // Sources/layers were wiped by setStyle — add them back.
  _addRouteToMap(map, activeRoute);

  destinationMarker?.remove();
  destinationMarker = null;
  if (activePoi) {
    _addDestMarker(map, activePoi);
  }
}

/**
 * Place (or update) the user-location marker without affecting any existing
 * route or destination marker.
 *
 * Called immediately after successful GPS acquisition so the "You are here"
 * marker appears before the user makes any query.
 */
export function setUserLocationMarker(map: Map, location: AssistLocation): void {
  userMarker?.remove();
  userMarker = null;
  activeUserLocation = location;
  _addUserMarker(map, location);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _addRouteToMap(map: Map, route: AssistRoute): void {
  if (map.getSource(ROUTE_SOURCE)) return; // guard against redundant add

  map.addSource(ROUTE_SOURCE, {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: route.coordinates, // already [lng, lat][]
      },
      properties: {},
    },
  });

  map.addLayer({
    id: ROUTE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_COLOR,
      'line-width': ROUTE_WIDTH,
      'line-opacity': ROUTE_OPACITY,
    },
  });
}

/** Destination marker — terracotta pin (matches existing .ss-dest-marker CSS). */
function _addDestMarker(map: Map, poi: AssistPOI): void {
  const el = document.createElement('div');
  el.className = 'ss-dest-marker';
  el.setAttribute('aria-label', `Destination: ${poi.name}`);
  el.title = `Destination: ${poi.name}`;

  destinationMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([poi.lng, poi.lat])
    .addTo(map);
}

/** User-location marker — blue circle (.ss-user-marker CSS). */
function _addUserMarker(map: Map, loc: AssistLocation): void {
  const el = document.createElement('div');
  el.className = 'ss-user-marker';
  el.setAttribute('aria-label', 'Your location');
  el.title = loc.label ? `Your location: ${loc.label}` : 'Your location';

  userMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat([loc.lng, loc.lat])
    .addTo(map);
}

/**
 * Fit the viewport to include both the user position and the full route
 * bounding box, ensuring both markers are visible after a response.
 */
function _fitToBoth(map: Map, userLoc: AssistLocation, route: AssistRoute): void {
  if (route.coordinates.length === 0) return;

  // Seed bounds with the user location so it is always included.
  let minLng = userLoc.lng, maxLng = userLoc.lng;
  let minLat = userLoc.lat, maxLat = userLoc.lat;

  for (const [lng, lat] of route.coordinates) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  const bounds: LngLatBoundsLike = [[minLng, minLat], [maxLng, maxLat]];

  map.fitBounds(bounds, {
    padding: FIT_PADDING,
    maxZoom: FIT_MAX_ZOOM,
    duration: 600,
  });
}
