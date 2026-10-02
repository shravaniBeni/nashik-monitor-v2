/**
 * SevaSetu assistant widget for Nashik Monitor — NM-5
 *
 * Provides a floating "Ask SevaSetu" button over #map. Clicking it opens a
 * compact assistant panel where a volunteer can:
 *   1. Acquire their location (GPS or manual selection)
 *   2. Type a query or tap a quick-action chip
 *   3. Speak a query via browser SpeechRecognition (NM-5)
 *   4. Receive a multilingual assistance response
 *   5. See basic destination info (name, category, distance, ETA)
 *   6. See the route drawn on the map, with a destination marker (NM-3)
 *   7. Read turn-by-turn directions (NM-4)
 *   8. Hear the response spoken via browser SpeechSynthesis (NM-5)
 *
 * Voice security: microphone audio never leaves the browser.
 * The recognised text string is sent to POST /api/assist via the existing
 * client.ts — the same path as typed text. No Sarvam credentials on the client.
 *
 * Framework: none — vanilla TypeScript DOM.
 * Styling: uses only Nashik Monitor CSS variables.
 * Dependencies: client, gps, locations, mapRoute, speech.
 */

import type { Map } from 'maplibre-gl';

import {
  askSevaSetu,
  SevasetuApiError,
  SevasetuNetworkError,
} from './client';
import { getCurrentGpsPosition } from './gps';
import { PREDEFINED_LOCATIONS, type PredefinedLocation } from './locations';
import { renderSevasetuRoute, remountSevasetuRoute, setUserLocationMarker } from './mapRoute';
import {
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  startSpeechRecognition,
  stopTts,
  speakText,
  type SttHandle,
  type SttErrorReason,
} from './speech';
import type {
  AssistResponse,
  AssistLocation,
  AssistRoute,
  AssistRouteStep,
  SupportedLanguageCode,
} from './types';

// ─── Public API ───────────────────────────────────────────────────────────────

/** Handle returned by initSevasetuWidget */
export interface SevasetuWidgetHandle {
  /**
   * Re-add the active SevaSetu route source/layer after a style reload.
   * Call this from restyle()'s style.load handler in main.ts, after the
   * existing NM data layers have been remounted.
   */
  remount(): void;
}

/**
 * Initialise the SevaSetu assistant widget.
 * Call once inside map.once('load', ...) in main.ts.
 */
export function initSevasetuWidget(map: Map): SevasetuWidgetHandle {
  const widget = new SevasetuWidget(map);
  widget.mount();
  return {
    remount: () => remountSevasetuRoute(map),
  };
}

// ─── Language options ─────────────────────────────────────────────────────────

interface LangOption { code: SupportedLanguageCode | 'auto'; label: string }
const LANGUAGES: LangOption[] = [
  { code: 'auto',   label: '🌐 Auto-detect' },
  { code: 'hi-IN',  label: '🇮🇳 हिन्दी' },
  { code: 'mr-IN',  label: '🚩 मराठी' },
  { code: 'en-IN',  label: '🌐 English' },
  { code: 'ta-IN',  label: '🇮🇳 தமிழ்' },
  { code: 'gu-IN',  label: '🇮🇳 ગુજરાતી' },
  { code: 'te-IN',  label: '🇮🇳 తెలుగు' },
  { code: 'kn-IN',  label: '🇮🇳 ಕನ್ನಡ' },
  { code: 'bn-IN',  label: '🇮🇳 বাংলা' },
];

// ─── Quick actions ────────────────────────────────────────────────────────────

const QUICK_ACTIONS: { label: string; query: string }[] = [
  { label: '🚻 Toilet',   query: 'Where is the nearest toilet?' },
  { label: '🏥 Hospital', query: 'Where is the nearest hospital?' },
  { label: '👮 Police',   query: 'Where is the nearest police chowki?' },
  { label: '💧 Water',    query: 'Where can I find drinking water?' },
  { label: '🅿️ Parking',  query: 'Where is the nearest parking zone?' },
  { label: '🚌 Bus',      query: 'Where is the nearest bus stop?' },
];

// ─── Location state ───────────────────────────────────────────────────────────

type LocationState =
  | { kind: 'none' }                            // not yet attempted
  | { kind: 'acquiring' }                       // GPS in-flight
  | { kind: 'gps'; coords: AssistLocation }     // live GPS obtained
  | { kind: 'manual'; location: PredefinedLocation }  // volunteer selected
  | { kind: 'failed'; reason: string }          // GPS failed, no selection yet

// ─── Message model ────────────────────────────────────────────────────────────

interface UserMessage { role: 'user'; text: string }
interface BotMessage  { role: 'bot';  response: AssistResponse }
interface ErrorMessage { role: 'error'; text: string }
type Message = UserMessage | BotMessage | ErrorMessage

// ─── Widget class ─────────────────────────────────────────────────────────────

class SevasetuWidget {
  private readonly map: Map;

  private locationState: LocationState = { kind: 'none' };
  private language: SupportedLanguageCode | 'auto' = 'auto';
  private messages: Message[] = [];
  private loading = false;
  private panelOpen = false;

  // Root elements — set in mount()
  private toggleBtn!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private conversationEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private locationBar!: HTMLDivElement;
  private locationDropdown!: HTMLSelectElement;
  private chipsContainer!: HTMLDivElement;

  // NM-5: voice state
  private micBtn!: HTMLButtonElement;
  private voiceToggleBtn!: HTMLButtonElement;
  private listeningBanner!: HTMLDivElement;
  private sttHandle: SttHandle | null = null;
  private isListening = false;
  private voiceOutputEnabled = false; // off by default — user opts in

  // NM-6.1: track whether the current/last message was spoken or typed.
  // Voice input → always speak response.
  // Text input  → speak only if voiceOutputEnabled toggle is on.
  private messageSource: 'text' | 'voice' = 'text';

  // NM-9: pending clarification state.
  // When the server returns 'ambiguous_vehicle', we store the clarification type
  // so the next user message is interpreted as the answer.
  private pendingClarification: 'vehicle_type' | null = null;

  constructor(map: Map) {
    this.map = map;
  }

  // ── Public ───────────────────────────────────────────────────────────────────

  mount(): void {
    this.buildDOM();
    this.attachEvents();
    this.renderLocationBar();
    this.renderMessages();
  }

  // ── DOM construction ──────────────────────────────────────────────────────────

  private buildDOM(): void {
    // Floating toggle button
    this.toggleBtn = el('button', 'ss-toggle');
    this.toggleBtn.type = 'button';
    this.toggleBtn.setAttribute('aria-label', 'Open SevaSetu assistant');
    this.toggleBtn.innerHTML =
      '<span class="ss-toggle-icon" aria-hidden="true">✦</span>' +
      '<span class="ss-toggle-label">Ask SevaSetu</span>' +
      '<span class="ss-toggle-badge" aria-hidden="true">हिन्दी · मराठी · En</span>';

    // Panel
    this.panel = el('div', 'ss-panel');
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-label', 'SevaSetu field assistant');
    this.panel.hidden = true;

    // Panel header
    const header = el('div', 'ss-header');
    const identity = el('div', 'ss-identity');
    identity.innerHTML =
      '<span class="ss-identity-mark" aria-hidden="true">S</span>' +
      '<span class="ss-identity-name">SevaSetu Field Guide</span>';
    const controls = el('div', 'ss-controls');

    // Language selector
    const langSelect = el('select', 'ss-lang') as HTMLSelectElement;
    langSelect.setAttribute('aria-label', 'Response language');
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.label;
      if (lang.code === this.language) opt.selected = true;
      langSelect.append(opt);
    }
    langSelect.addEventListener('change', () => {
      this.language = langSelect.value as SupportedLanguageCode | 'auto';
    });

    // Close button
    const closeBtn = el('button', 'ss-close') as HTMLButtonElement;
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close assistant');
    closeBtn.addEventListener('click', (e) => {
      // Stop propagation so the click does not reach the map container
      // and trigger MapLibre's click handler or any parent listener.
      e.stopPropagation();
      this.closePanel();
    });

    // NM-5: voice output toggle — in header controls, before close button
    this.voiceToggleBtn = el('button', 'ss-voice-toggle') as HTMLButtonElement;
    this.voiceToggleBtn.type = 'button';
    this.voiceToggleBtn.setAttribute('aria-label', 'Toggle voice response');
    if (!isSpeechSynthesisSupported()) {
      this.voiceToggleBtn.disabled = true;
      this.voiceToggleBtn.title = 'Voice output is not supported in this browser';
    }
    this.updateVoiceOutputState();
    this.voiceToggleBtn.addEventListener('click', () => this.toggleVoiceOutput());

    controls.append(langSelect, this.voiceToggleBtn, closeBtn);
    header.append(identity, controls);

    // Location bar
    this.locationBar = el('div', 'ss-location-bar');
    this.locationDropdown = el('select', 'ss-location-select') as HTMLSelectElement;
    this.locationDropdown.setAttribute('aria-label', 'Select location manually');

    // Add a placeholder option that forces explicit selection
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— Select a location —';
    placeholder.disabled = true;
    placeholder.selected = true;
    this.locationDropdown.append(placeholder);

    for (const loc of PREDEFINED_LOCATIONS) {
      const opt = document.createElement('option');
      opt.value = loc.id;
      opt.textContent = loc.name;
      this.locationDropdown.append(opt);
    }
    this.locationDropdown.addEventListener('change', () => {
      const id = this.locationDropdown.value;
      if (!id) return;
      const loc = PREDEFINED_LOCATIONS.find((l) => l.id === id);
      if (loc) this.selectManualLocation(loc);
    });

    // GPS button
    const gpsBtn = el('button', 'ss-gps-btn') as HTMLButtonElement;
    gpsBtn.type = 'button';
    gpsBtn.textContent = '📡 Use GPS';
    gpsBtn.setAttribute('aria-label', 'Use current GPS location');
    gpsBtn.addEventListener('click', () => void this.acquireGps());

    this.locationBar.append(gpsBtn, this.locationDropdown);

    // Quick chips
    this.chipsContainer = el('div', 'ss-chips');
    this.chipsContainer.setAttribute('role', 'group');
    this.chipsContainer.setAttribute('aria-label', 'Quick actions');
    for (const action of QUICK_ACTIONS) {
      const chip = el('button', 'ss-chip') as HTMLButtonElement;
      chip.type = 'button';
      chip.textContent = action.label;
      chip.addEventListener('click', () => void this.sendMessage(action.query));
      this.chipsContainer.append(chip);
    }

    // Conversation area
    this.conversationEl = el('div', 'ss-conversation');
    this.conversationEl.setAttribute('role', 'log');
    this.conversationEl.setAttribute('aria-live', 'polite');
    this.conversationEl.setAttribute('aria-label', 'Conversation');

    // NM-5: listening banner — shown above input bar while recognition is active.
    // Hidden by default; shown/hidden by updateListeningState().
    this.listeningBanner = el('div', 'ss-listening-banner');
    this.listeningBanner.setAttribute('role', 'status');
    // role="status" implies aria-live="polite" — no explicit aria-live needed
    this.listeningBanner.hidden = true;

    const listeningDot = el('span', 'ss-listening-dot');
    listeningDot.setAttribute('aria-hidden', 'true');

    // Class ss-listening-lang lets updateListeningState() refresh this text
    // if the user changes the language selector while the banner is visible.
    const listeningText = el('span', 'ss-listening-text ss-listening-lang');
    listeningText.textContent = this.listeningLabel();

    const cancelBtn = el('button', 'ss-listening-cancel') as HTMLButtonElement;
    cancelBtn.type = 'button';
    cancelBtn.textContent = '✕ Cancel';
    cancelBtn.setAttribute('aria-label', 'Cancel voice recognition');
    cancelBtn.addEventListener('click', () => {
      this.inputEl.value = '';
      this.stopListening(true);
    });

    this.listeningBanner.append(listeningDot, listeningText, cancelBtn);

    // Input bar
    const inputBar = el('form', 'ss-input-bar') as HTMLFormElement;

    // NM-5: microphone button — left of the text input
    this.micBtn = el('button', 'ss-mic-btn') as HTMLButtonElement;
    this.micBtn.type = 'button';
    this.micBtn.textContent = '🎙';
    this.micBtn.setAttribute('aria-label', 'Start voice input');
    this.micBtn.setAttribute('aria-pressed', 'false');
    if (!isSpeechRecognitionSupported()) {
      this.micBtn.disabled = true;
      this.micBtn.title = 'Voice input is not supported in this browser';
    } else {
      this.micBtn.title = 'Speak your question';
      this.micBtn.addEventListener('click', () => {
        if (this.isListening) {
          this.stopListening(true); // abort — user changed their mind
        } else {
          this.startListening();
        }
      });
    }
    this.inputEl = el('input', 'ss-input') as HTMLInputElement;
    this.inputEl.type = 'text';
    this.inputEl.placeholder = 'Ask: nearest toilet, hospital…';
    this.inputEl.setAttribute('aria-label', 'Query');
    this.inputEl.autocomplete = 'off';

    this.sendBtn = el('button', 'ss-send') as HTMLButtonElement;
    this.sendBtn.type = 'submit';
    this.sendBtn.textContent = '➤';
    this.sendBtn.setAttribute('aria-label', 'Send');

    inputBar.append(this.micBtn, this.inputEl, this.sendBtn);
    inputBar.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.sendMessage();
    });

    // Assemble panel
    this.panel.append(
      header,
      this.locationBar,
      this.chipsContainer,
      this.listeningBanner,  // NM-5: between chips and conversation
      this.conversationEl,
      inputBar,
    );

    // Add to map container (not body — stays within #map)
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.append(this.toggleBtn, this.panel);
    } else {
      document.body.append(this.toggleBtn, this.panel);
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private attachEvents(): void {
    this.toggleBtn.addEventListener('click', (e) => {
      // Stop propagation so clicks on the toggle don't also reach
      // MapLibre's map click handler on the parent #map element.
      e.stopPropagation();
      if (this.panelOpen) {
        this.closePanel();
      } else {
        this.openPanel();
      }
    });
  }

  // ── Panel open/close ────────────────────────────────────────────────────────

  private openPanel(): void {
    this.panelOpen = true;
    this.panel.hidden = false;
    this.toggleBtn.classList.add('ss-toggle--open');
    this.toggleBtn.setAttribute('aria-expanded', 'true');
    this.inputEl.focus();

    // Attempt GPS on first open if location not yet known
    if (this.locationState.kind === 'none') {
      void this.acquireGps();
    }
  }

  private closePanel(): void {
    this.panelOpen = false;
    this.panel.hidden = true;
    this.toggleBtn.classList.remove('ss-toggle--open');
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    // NM-5: stop any in-progress speech/recognition when panel closes
    this.stopListening(true);
    stopTts();
    // NM-6.1: reset location state on close so the next open always acquires a
    // fresh GPS position rather than reusing a potentially stale one from a
    // previous session. This also ensures the browser's getCurrentPosition() is
    // called on each open, which is what triggers the permission prompt on first
    // use and returns a current position on subsequent opens.
    //
    // Exception: if the user explicitly selected a manual location, preserve it
    // so they do not have to re-select every time they reopen the panel.
    if (this.locationState.kind === 'gps' || this.locationState.kind === 'failed' || this.locationState.kind === 'acquiring') {
      this.locationState = { kind: 'none' };
    }
  }

  // ── Location ────────────────────────────────────────────────────────────────

  private async acquireGps(): Promise<void> {
    this.locationState = { kind: 'acquiring' };
    this.renderLocationBar();

    const result = await getCurrentGpsPosition();

    if (result.ok) {
      this.locationState = { kind: 'gps', coords: result.position };
      // Log the accepted fix so it is visible in DevTools during testing.
      // gps.ts already logs each ACCEPTED/REJECTED position as it arrives;
      // this line confirms which fix the widget actually used.
      console.info(
        `[SevaSetu widget] GPS fix in use — lat: ${result.position.lat.toFixed(6)}, ` +
        `lng: ${result.position.lng.toFixed(6)}, ` +
        `accuracy: ${result.position.accuracyMeters}m`,
      );
      // NM-6.1: show the "You are here" marker immediately on GPS success,
      // before any query is made, so the user can verify their position.
      setUserLocationMarker(this.map, result.position);
    } else {
      // GPS failed — do NOT substitute any default coordinates.
      // Volunteer must explicitly select a location.
      this.locationState = { kind: 'failed', reason: result.error.userMessage };
    }
    this.renderLocationBar();
  }

  private selectManualLocation(loc: PredefinedLocation): void {
    this.locationState = { kind: 'manual', location: loc };
    this.renderLocationBar();
  }

  /** Resolve current location for use in a request. Returns null if unknown. */
  private resolveLocation(): AssistLocation | null {
    if (this.locationState.kind === 'gps') return this.locationState.coords;
    if (this.locationState.kind === 'manual') return this.locationState.location.coords;
    return null;
  }

  // ── Sending a message ────────────────────────────────────────────────────────

  /**
   * @param text    The message text. If omitted, reads from the input field.
   * @param source  'voice' when called from STT recognition; 'text' otherwise.
   *                Voice input always gets a spoken response regardless of the
   *                global voice-output toggle.
   */
  private async sendMessage(text?: string, source: 'text' | 'voice' = 'text'): Promise<void> {
    let query = (text ?? this.inputEl.value).trim();
    if (!query || this.loading) return;

    // NM-9/NM-10: if a vehicle-type clarification was pending, send the user's
    // raw reply directly to the backend. The backend owns the resolution logic:
    // "car" → car_service, "bike"/"two-wheeler" → two_wheeler_service.
    // The frontend must not contain its own regex or hardcoded category strings
    // to resolve this — that is backend business logic.
    if (this.pendingClarification === 'vehicle_type') {
      this.pendingClarification = null;
      // Send query as-is. If the backend can't classify it (e.g. user typed
      // something unrelated), it will return a normal clarify response.
      // No transformation happens here.
    }

    // Require a valid location — never send a request with unknown coordinates
    const location = this.resolveLocation();
    if (!location) {
      this.messages.push({
        role: 'error',
        text: 'Please select your location before asking a question.',
      });
      this.renderMessages();
      return;
    }

    // Record the source of this message for TTS decision after response.
    this.messageSource = source;

    this.inputEl.value = '';
    this.messages.push({ role: 'user', text: query });
    this.loading = true;
    this.renderMessages();
    this.updateInputState();

    try {
      const response = await askSevaSetu(query, location, this.language);
      this.messages.push({ role: 'bot', response });

      // NM-9: if the server returned a vehicle-type clarification, store it
      // so the next message is interpreted as the answer (car vs bike).
      if (response.intent.intent === 'ambiguous_vehicle' && response.intent.clarificationType) {
        this.pendingClarification = response.intent.clarificationType;
      } else {
        this.pendingClarification = null;
      }
      // NM-3/NM-6.1: render route + both markers. Pass user location so the
      // "You are here" marker is always shown at the exact coordinates sent to
      // the API — making it easy to verify location correctness.
      renderSevasetuRoute(this.map, response.route, response.poi, location);
      // NM-5/NM-6.1: voice-first rule:
      //   voice input  → always speak response
      //   text input   → speak only if global voice toggle is on
      this.speakResponse(response.replyText, response.detectedLanguage);
    } catch (err) {
      let userText: string;
      if (err instanceof SevasetuNetworkError) {
        userText = err.message;
      } else if (err instanceof SevasetuApiError) {
        userText =
          err.statusCode === 400
            ? 'Your request could not be understood. Please rephrase and try again.'
            : err.statusCode === 503
            ? 'SevaSetu service data is temporarily unavailable. Please try again shortly.'
            : 'SevaSetu encountered an error. Please try again.';
      } else {
        userText = 'SevaSetu assistance is temporarily unavailable. Please try again.';
      }
      this.messages.push({ role: 'error', text: userText });
    } finally {
      this.loading = false;
      this.renderMessages();
      this.updateInputState();
    }
  }

  // ── Render: location bar ────────────────────────────────────────────────────

  private renderLocationBar(): void {
    const gpsBtn = this.locationBar.querySelector<HTMLButtonElement>('.ss-gps-btn');
    const select = this.locationDropdown;

    // Remove previous status elements before rebuilding
    this.locationBar.querySelectorAll('.ss-loc-status').forEach((el) => el.remove());

    const state = this.locationState;

    if (state.kind === 'acquiring') {
      if (gpsBtn) { gpsBtn.textContent = '📡 Locating…'; gpsBtn.disabled = true; }
      select.style.display = 'none';
    } else if (state.kind === 'gps') {
      if (gpsBtn) {
        gpsBtn.textContent = '📡 Live GPS';
        gpsBtn.disabled = false;
        gpsBtn.classList.add('ss-gps-btn--active');
      }
      select.style.display = 'none';
      // Add a small "switch to manual" link
      const sw = el('button', 'ss-loc-status ss-switch-btn') as HTMLButtonElement;
      sw.type = 'button';
      sw.textContent = 'Switch to manual';
      sw.addEventListener('click', () => {
        this.locationState = { kind: 'none' };
        this.renderLocationBar();
      });
      this.locationBar.append(sw);
    } else if (state.kind === 'manual') {
      if (gpsBtn) {
        gpsBtn.textContent = '📡 Use GPS';
        gpsBtn.disabled = false;
        gpsBtn.classList.remove('ss-gps-btn--active');
      }
      select.style.display = '';
      // Reflect selection in dropdown
      const idx = Array.from(select.options).findIndex(
        (o) => o.value === state.location.id,
      );
      if (idx >= 0) select.selectedIndex = idx;
    } else if (state.kind === 'failed') {
      if (gpsBtn) {
        gpsBtn.textContent = '📡 Retry GPS';
        gpsBtn.disabled = false;
        gpsBtn.classList.remove('ss-gps-btn--active');
      }
      select.style.display = '';
      // Reset dropdown to placeholder
      select.selectedIndex = 0;
      // Show failure reason
      const warn = el('p', 'ss-loc-status ss-loc-warn');
      warn.textContent = `⚠ ${state.reason}`;
      // Insert before the dropdown
      this.locationBar.insertBefore(warn, select);
    } else {
      // kind: 'none'
      if (gpsBtn) {
        gpsBtn.textContent = '📡 Use GPS';
        gpsBtn.disabled = false;
        gpsBtn.classList.remove('ss-gps-btn--active');
      }
      select.style.display = '';
      select.selectedIndex = 0;
    }
  }

  // ── Render: messages ────────────────────────────────────────────────────────

  private renderMessages(): void {
    // Clear and rebuild
    this.conversationEl.innerHTML = '';

    if (this.messages.length === 0) {
      const welcome = el('div', 'ss-welcome');
      welcome.innerHTML =
        '<p>नमस्ते! 🙏 Ask for the nearest toilet, hospital, police chowki, ' +
        'water point, parking, or bus stop.</p>' +
        '<p>Hindi · Marathi · Tamil · Gujarati · English — all supported.</p>';
      this.conversationEl.append(welcome);
    }

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        const row = el('div', 'ss-row ss-row--user');
        const bubble = el('div', 'ss-bubble ss-bubble--user');
        bubble.textContent = msg.text;
        row.append(bubble);
        this.conversationEl.append(row);
      } else if (msg.role === 'bot') {
        this.conversationEl.append(this.renderBotMessage(msg.response));
      } else {
        const row = el('div', 'ss-row ss-row--error');
        const bubble = el('div', 'ss-bubble ss-bubble--error');
        bubble.textContent = msg.text;
        row.append(bubble);
        this.conversationEl.append(row);
      }
    }

    if (this.loading) {
      const row = el('div', 'ss-row ss-row--bot');
      const typing = el('div', 'ss-typing');
      typing.setAttribute('aria-label', 'Searching…');
      typing.innerHTML = '<span></span><span></span><span></span>';
      const label = el('p', 'ss-typing-label');
      label.textContent = 'Searching nearby services…';
      row.append(typing, label);
      this.conversationEl.append(row);
    }

    // Scroll to bottom
    this.conversationEl.scrollTop = this.conversationEl.scrollHeight;
  }

  private renderBotMessage(response: AssistResponse): HTMLElement {
    const row = el('div', 'ss-row ss-row--bot');
    const avatar = el('span', 'ss-avatar');
    avatar.textContent = 'S';
    avatar.setAttribute('aria-hidden', 'true');

    const content = el('div', 'ss-bubble ss-bubble--bot');

    // Reply text — render **bold** markers
    const replyEl = el('div', 'ss-reply');
    renderMarkdownBold(response.replyText, replyEl);
    content.append(replyEl);

    // NM-9: Clarification chips for ambiguous_vehicle
    if (response.intent.intent === 'ambiguous_vehicle' && response.intent.clarificationType === 'vehicle_type') {
      const chipsEl = el('div', 'ss-clarify-chips');

      const carBtn = el('button', 'ss-clarify-chip') as HTMLButtonElement;
      carBtn.type = 'button';
      carBtn.textContent = '🚗 Car';
      carBtn.setAttribute('aria-label', 'Car service');
      carBtn.addEventListener('click', () => void this.sendMessage('car'));

      const bikeBtn = el('button', 'ss-clarify-chip') as HTMLButtonElement;
      bikeBtn.type = 'button';
      bikeBtn.textContent = '🛵 Two-wheeler';
      bikeBtn.setAttribute('aria-label', 'Two-wheeler service');
      bikeBtn.addEventListener('click', () => void this.sendMessage('bike'));

      chipsEl.append(carBtn, bikeBtn);
      content.append(chipsEl);
    }

    // POI destination card
    if (response.poi) {
      const isFallback = response.route?.provider === 'fallback';
      const card = el('div', 'ss-poi-card');
      if (isFallback) card.classList.add('ss-poi-card--fallback');

      // Header row: category pill + name
      const cardHeader = el('div', 'ss-poi-header');

      const catPill = el('span', 'ss-poi-cat-pill');
      catPill.textContent = response.poi.categoryLabel;
      cardHeader.append(catPill);

      const nameEl = el('h4', 'ss-poi-name');
      nameEl.textContent = response.poi.name;
      card.append(cardHeader, nameEl);

      // Stats row: distance + ETA as chips
      if (response.distanceMeters !== undefined && response.durationMinutes !== undefined) {
        const statsEl = el('div', 'ss-poi-stats');

        const distChip = el('span', 'ss-stat-chip');
        distChip.innerHTML = `<span class="ss-stat-icon">📍</span><span class="ss-stat-value">${formatDistance(response.distanceMeters)}</span>`;

        const etaChip = el('span', 'ss-stat-chip');
        etaChip.innerHTML = `<span class="ss-stat-icon">🚶</span><span class="ss-stat-value">~${response.durationMinutes} min</span>`;

        statsEl.append(distChip, etaChip);
        card.append(statsEl);
      }

      if (response.poi.address) {
        const addrEl = el('p', 'ss-poi-addr');
        addrEl.innerHTML = `<span class="ss-poi-addr-icon">📍</span>${response.poi.address}`;
        card.append(addrEl);
      }

      if (isFallback) {
        const note = el('p', 'ss-fallback-note');
        note.textContent = '⚠ Detailed routing is temporarily unavailable.';
        card.append(note);
      }

      content.append(card);
    }

    // NM-4: navigation directions panel
    if (response.route) {
      content.append(renderDirections(response.route));
    }

    row.append(avatar, content);
    return row;
  }

  // ── Input state ────────────────────────────────────────────────────────────

  private updateInputState(): void {
    this.inputEl.disabled = this.loading;
    this.sendBtn.disabled = this.loading;
    this.chipsContainer.querySelectorAll<HTMLButtonElement>('.ss-chip').forEach((b) => {
      b.disabled = this.loading;
    });
    // Mic stays enabled while listening (so the user can cancel recognition)
    // but is disabled while an API request is in flight and we're not listening.
    this.micBtn.disabled = this.loading && !this.isListening;
  }

  // ── NM-5: Voice input ──────────────────────────────────────────────────────

  private startListening(): void {
    if (this.isListening) return;

    // Stop any TTS that is currently playing so recognition isn't picking up
    // the synthesised speech.
    stopTts();
    this.updateVoiceOutputState();

    const handle = startSpeechRecognition(this.language, {
      onStart: () => {
        this.isListening = true;
        this.updateListeningState();
      },
      onInterim: (transcript) => {
        // Show interim result in the input field so the user sees what was heard
        this.inputEl.value = transcript;
      },
      onResult: (transcript) => {
        this.inputEl.value = '';
        void this.sendMessage(transcript, 'voice');
      },
      onError: (reason: SttErrorReason) => {
        this.isListening = false;
        this.sttHandle = null;
        this.updateListeningState();

        // Show a brief error in the conversation rather than an alert()
        let text: string;
        switch (reason) {
          case 'unsupported':
            text = 'Voice input is not available in this browser. Please use Chrome or Edge, or type your question.';
            break;
          case 'not-allowed':
            text = 'Microphone permission was denied. Please allow microphone access in your browser settings, then try again.';
            break;
          case 'no-speech':
            // Not an error worth showing — user just didn't speak
            return;
          case 'network':
            text = 'Voice recognition requires a network connection. Please check your connection or type your question.';
            break;
          case 'aborted':
            // Cancelled by the user — no message needed
            return;
          default:
            text = 'Voice recognition encountered an error. Please type your question.';
        }
        this.messages.push({ role: 'error', text });
        this.renderMessages();
      },
      onEnd: () => {
        this.isListening = false;
        this.sttHandle = null;
        this.updateListeningState();
      },
    });

    // handle is null when unsupported — onError already handled above.
    // Assign after the call so it's available before any async callbacks fire.
    if (handle) {
      this.sttHandle = handle;
    }
  }

  /**
   * Stop or abort recognition.
   * @param abort  true = abort (no result), false = stop gracefully (may fire result)
   */
  private stopListening(abort = false): void {
    if (!this.isListening || !this.sttHandle) return;
    if (abort) {
      this.sttHandle.abort();
    } else {
      this.sttHandle.stop();
    }
    // State will be cleaned up in onEnd callback
  }

  private updateListeningState(): void {
    const listening = this.isListening;
    this.micBtn.classList.toggle('ss-mic-btn--active', listening);
    this.micBtn.setAttribute('aria-pressed', String(listening));
    this.micBtn.title = listening ? 'Stop listening' : 'Speak your question';
    this.micBtn.textContent = listening ? '⏹' : '🎙';
    this.listeningBanner.hidden = !listening;
    // Refresh the language label in case the user changed it since last open
    const langEl = this.listeningBanner.querySelector('.ss-listening-lang');
    if (langEl) langEl.textContent = this.listeningLabel();
    if (!listening) {
      // Clear interim text from input when recognition ends without a result
      if (this.inputEl.value && !this.loading) this.inputEl.value = '';
    }
  }

  /** Human-readable label for the language currently used by STT. */
  private listeningLabel(): string {
    if (this.language === 'auto') {
      // Mirror speech.ts: STT uses navigator.language, show it to the user
      const nav = navigator.language || 'hi-IN';
      const prefixMap: Record<string, string> = {
        'hi': 'हिन्दी', 'mr': 'मराठी', 'en': 'English',
        'ta': 'தமிழ்', 'gu': 'ગુજરાતી',
        'te': 'తెలుగు', 'kn': 'ಕನ್ನಡ', 'bn': 'বাংলা',
      };
      const prefix = nav.split('-')[0] ?? 'en';
      return `Listening (${prefixMap[prefix] ?? nav})… speak now`;
    }
    const langMap: Record<string, string> = {
      'hi-IN': 'हिन्दी', 'mr-IN': 'मराठी', 'en-IN': 'English',
      'ta-IN': 'தமிழ்', 'gu-IN': 'ગુજરાતી',
      'te-IN': 'తెలుగు', 'kn-IN': 'ಕನ್ನಡ', 'bn-IN': 'বাংলা',
    };
    return `Listening (${langMap[this.language] ?? this.language})… बोलिए`;
  }

  // ── NM-5: Voice output ─────────────────────────────────────────────────────

  private toggleVoiceOutput(): void {
    this.voiceOutputEnabled = !this.voiceOutputEnabled;
    if (!this.voiceOutputEnabled) stopTts();
    this.updateVoiceOutputState();
  }

  private updateVoiceOutputState(): void {
    const on = this.voiceOutputEnabled;
    this.voiceToggleBtn.classList.toggle('ss-voice-toggle--on', on);
    this.voiceToggleBtn.setAttribute('aria-pressed', String(on));
    this.voiceToggleBtn.title = on ? 'Turn off voice response' : 'Turn on voice response';
    this.voiceToggleBtn.textContent = on ? '🔊' : '🔇';
  }

  /**
   * Speak the replyText from a successful response.
   *
   * Voice-first rule (NM-6.1):
   *   - Voice input  → always speak, regardless of the toggle
   *   - Text input   → speak only if voiceOutputEnabled toggle is on
   *
   * Uses response.detectedLanguage (authoritative from the API) so the TTS
   * voice matches what the API actually answered in.
   * Only replyText is spoken — not raw route steps.
   */
  private speakResponse(replyText: string, detectedLang: string): void {
    const shouldSpeak = this.messageSource === 'voice' || this.voiceOutputEnabled;
    if (!shouldSpeak) return;
    if (!isSpeechSynthesisSupported()) return;
    speakText(replyText, detectedLang as Parameters<typeof speakText>[1]);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a typed element with a class string */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/** Render **text** bold markers into a container element */
function renderMarkdownBold(text: string, container: HTMLElement): void {
  for (const para of text.split('\n')) {
    const p = document.createElement('p');
    for (const segment of para.split(/(\*\*.*?\*\*)/)) {
      if (segment.startsWith('**') && segment.endsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = segment.slice(2, -2);
        p.append(strong);
      } else if (segment) {
        p.append(document.createTextNode(segment));
      }
    }
    container.append(p);
  }
}

/** Format metres as a human-readable distance string */
function formatDistance(meters: number): string {
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

// ─── NM-4: Directions panel ───────────────────────────────────────────────────

/** Map OSRM instruction text to a simple direction icon */
function stepIcon(instruction: string): string {
  const lower = instruction.toLowerCase();
  if (lower.includes('turn left'))  return '↰';
  if (lower.includes('turn right')) return '↱';
  if (lower.includes('slight left') || lower.includes('bear left')) return '↖';
  if (lower.includes('slight right') || lower.includes('bear right')) return '↗';
  if (lower.includes('u-turn') || lower.includes('uturn')) return '↩';
  if (lower.includes('arrive') || lower.includes('destination')) return '🏁';
  if (lower.includes('depart') || lower.includes('start') || lower.includes('head')) return '▶';
  if (lower.includes('roundabout')) return '🔄';
  return '↑';  // straight / continue
}

/**
 * Build the navigation directions panel.
 * Collapsible toggle so it doesn't dominate the chat bubble.
 * Timeline layout with direction icons per step.
 */
function renderDirections(route: AssistRoute): HTMLElement {
  const panel = el('div', 'ss-directions');

  if (route.provider === 'fallback') {
    const note = el('div', 'ss-directions-fallback');
    note.textContent = 'Route shown for reference. Detailed turn-by-turn directions are unavailable.';
    panel.append(note);
    return panel;
  }

  const meaningfulSteps = route.steps.filter(
    (s): s is AssistRouteStep => s.distanceMeters > 0,
  );

  if (meaningfulSteps.length === 0) {
    const note = el('div', 'ss-directions-fallback');
    note.textContent = 'Destination is very close — see map for route.';
    panel.append(note);
    return panel;
  }

  // ── Collapsible toggle ────────────────────────────────────────────────────
  const toggle = el('button', 'ss-dir-toggle') as HTMLButtonElement;
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  const toggleLabel = el('span', 'ss-dir-toggle-label');
  const labelMain = el('span');
  labelMain.textContent = `Directions · ${meaningfulSteps.length} steps`;
  const labelHint = el('span', 'ss-dir-toggle-hint');
  labelHint.textContent = 'Tap to expand';
  toggleLabel.append(labelMain, labelHint);

  const toggleChevron = el('span', 'ss-dir-chevron');
  toggleChevron.setAttribute('aria-hidden', 'true');
  toggleChevron.textContent = '›';

  toggle.append(toggleLabel, toggleChevron);

  // ── Step list (hidden by default) ────────────────────────────────────────
  const list = el('ol', 'ss-steps');
  list.hidden = true;
  list.setAttribute('aria-label', 'Turn-by-turn directions');

  for (const [i, step] of meaningfulSteps.entries()) {
    const item = el('li', 'ss-step');
    if (i === meaningfulSteps.length - 1) item.classList.add('ss-step--last');

    const iconEl = el('span', 'ss-step-icon');
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = stepIcon(step.instruction);

    const bodyEl = el('div', 'ss-step-body');

    const instrEl = el('span', 'ss-step-instruction');
    instrEl.textContent = step.instruction;

    const distEl = el('span', 'ss-step-dist');
    distEl.textContent = formatDistance(step.distanceMeters);

    bodyEl.append(instrEl, distEl);
    item.append(iconEl, bodyEl);
    list.append(item);
  }

  // Toggle open/close
  toggle.addEventListener('click', () => {
    const open = list.hidden;
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggleChevron.classList.toggle('ss-dir-chevron--open', open);
    if (labelHint) {
      labelHint.textContent = open ? 'Tap to collapse' : 'Tap to expand';
    }
  });

  panel.append(toggle, list);
  return panel;
}
