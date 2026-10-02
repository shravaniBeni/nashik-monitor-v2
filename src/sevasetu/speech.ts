/**
 * Browser speech module for SevaSetu / Nashik Monitor — NM-5
 *
 * Provides browser-side Speech Recognition (STT) and Speech Synthesis (TTS).
 * No external API keys, no credentials, no audio uploaded to any server.
 * All processing happens in the browser via Web Speech API.
 *
 * SECURITY: microphone audio never leaves the browser through this module.
 * The only network call is the existing POST /api/assist in client.ts, which
 * receives the recognised text string — not audio.
 *
 * Architecture:
 *   - SpeechRecognition: single-shot, fires a callback with the transcript
 *   - SpeechSynthesis:   speaks a text string; markdown stripped before speaking
 *
 * Both are gracefully unavailable — callers always receive typed results or
 * callbacks with clear error reasons rather than thrown exceptions.
 */

import type { SupportedLanguageCode } from './types';

// ─── SpeechRecognition browser compatibility ──────────────────────────────────
// SpeechRecognition and its event types are available in modern browsers but
// TypeScript's DOM lib doesn't always surface them as directly referenceable
// type names depending on the TS version and tsconfig. We work entirely through
// the window record and use unknown/any for the recognition instance and events,
// which is safe because we validate capability via isSpeechRecognitionSupported()
// before any call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionInstance = any;

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionInstance) | null {
  const w = window as unknown as Record<string, unknown>;
  const ctor = w['SpeechRecognition'] ?? w['webkitSpeechRecognition'];
  return typeof ctor === 'function'
    ? (ctor as new () => SpeechRecognitionInstance)
    : null;
}

// ─── Speech Recognition ───────────────────────────────────────────────────────

export type SttErrorReason =
  | 'unsupported'   // browser has no SpeechRecognition at all
  | 'not-allowed'   // microphone permission denied
  | 'no-speech'     // microphone opened but no speech detected
  | 'network'       // browser STT requires network and it failed
  | 'aborted'       // caller called stop/abort before a result arrived
  | 'unknown';      // any other error code

export interface SttCallbacks {
  /** Called when recognition starts and the microphone is open */
  onStart?: () => void;
  /**
   * Called continuously while the user speaks.
   * `transcript` is the best current guess — may change until `onResult`.
   */
  onInterim?: (transcript: string) => void;
  /**
   * Called once with the final recognised transcript, fired before `onEnd`.
   */
  onResult: (transcript: string) => void;
  /** Called when recognition ends without a usable transcript. */
  onError: (reason: SttErrorReason, detail?: string) => void;
  /** Called when the recognition session is fully finished (success or failure). */
  onEnd?: () => void;
}

/** Handle returned by startSpeechRecognition — use to stop/cancel. */
export interface SttHandle {
  /** Stop recognition and wait for any final result. */
  stop: () => void;
  /** Abort immediately — onResult will not fire. */
  abort: () => void;
}

/**
 * Returns true if the browser supports SpeechRecognition.
 * Use this to decide whether to show the mic button.
 */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * Start a single-shot speech recognition session.
 *
 * Language: use the user's selected language, fall back to 'hi-IN' for 'auto'
 * (most common volunteer language; browser STT needs a concrete BCP-47 tag).
 *
 * Returns an SttHandle for stop/abort, or null if unsupported.
 */
export function startSpeechRecognition(
  lang: SupportedLanguageCode | 'auto',
  callbacks: SttCallbacks,
): SttHandle | null {
  const SR = getSpeechRecognitionCtor();
  if (!SR) {
    callbacks.onError('unsupported');
    callbacks.onEnd?.();
    return null;
  }

  // Determine the BCP-47 tag to pass to the browser STT engine.
  //
  // When the user has selected an explicit language, use it directly.
  //
  // When 'auto' is selected we must still give the browser a concrete tag
  // (SpeechRecognition has no true multi-language auto-detect mode). We use
  // navigator.language — the browser's own UI language — rather than
  // hardcoding 'hi-IN'. This way an English-UI user speaking English gets
  // an English transcript, and a Hindi-UI user speaking Hindi gets Devanagari.
  // Forcing 'hi-IN' on an English speaker caused English speech to be
  // transcribed phonetically into Devanagari (e.g. "Can you tell me" →
  // "कैन यू टेल मी"), which then triggered Hindi intent detection and a
  // Hindi response. See NM-6.1 follow-up diagnosis.
  //
  // Fallback chain:
  //   user-selected lang → navigator.language → 'hi-IN'
  // 'hi-IN' final fallback is kept because Nashik Kumbh Mela volunteers are
  // predominantly Hindi speakers; it only fires on very old browsers where
  // navigator.language is absent.
  const bcp47: string =
    lang !== 'auto'
      ? lang
      : (navigator.language || 'hi-IN');

  const rec: SpeechRecognitionInstance = new SR();
  rec.lang = bcp47;
  rec.continuous = false;    // single utterance
  rec.interimResults = true; // stream partial results to onInterim
  rec.maxAlternatives = 1;

  let finalTranscript = '';

  rec.onstart = () => {
    callbacks.onStart?.();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rec.onresult = (event: any) => {
    let finalAcc = '';
    let interimAcc = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < (event.results as any).length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = (event.results as any)[i];
      if (!item) continue;
      const transcript: string = item[0]?.transcript ?? '';
      if (item.isFinal as boolean) {
        finalAcc += transcript + ' ';
      } else {
        interimAcc += transcript;
      }
    }
    const current = (finalAcc + interimAcc).trim();
    if (current) {
      finalTranscript = current;
      callbacks.onInterim?.(current);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rec.onerror = (event: any) => {
    const code = String(event.error ?? 'unknown');
    let reason: SttErrorReason;
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed':
        reason = 'not-allowed'; break;
      case 'no-speech':
        reason = 'no-speech'; break;
      case 'network':
        reason = 'network'; break;
      case 'aborted':
        reason = 'aborted'; break;
      default:
        reason = 'unknown';
    }
    callbacks.onError(reason, code);
  };

  rec.onend = () => {
    const spoken = finalTranscript.trim();
    // Only fire onResult when there is actually something to send.
    // An empty transcript means the user said nothing or aborted — the
    // widget's onError(aborted) / onError(no-speech) already handled that.
    if (spoken) {
      callbacks.onResult(spoken);
    }
    callbacks.onEnd?.();
  };

  try {
    rec.start();
  } catch (err) {
    callbacks.onError('unknown', String(err));
    callbacks.onEnd?.();
    return null;
  }

  return {
    stop:  () => { rec.stop(); },
    abort: () => { rec.abort(); },
  };
}

// ─── Speech Synthesis (TTS) ───────────────────────────────────────────────────

/** True if the browser supports SpeechSynthesis. */
export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

let _speaking = false;

/** Currently speaking — used by the widget to show/hide speaking state. */
export function isTtsSpeaking(): boolean {
  return _speaking;
}

/** Stop any in-progress speech immediately. */
export function stopTts(): void {
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
  _speaking = false;
}

/**
 * Speak `text` using browser SpeechSynthesis. No external API key needed.
 *
 * Language voice selection: tries to find an installed voice whose lang tag
 * starts with the same two-letter prefix (e.g. 'hi' for 'hi-IN'). Falls back
 * to the browser default if no matching voice is installed — speech continues,
 * just in a different accent. Same strategy as the original demo's
 * languageService.ts textToSpeech().
 *
 * Text cleaning: strips markdown syntax (**bold**, #heading, `code`, etc.)
 * before speaking so the TTS engine reads clean text rather than announcing
 * punctuation characters.
 *
 * @param text   The text to speak (may contain markdown).
 * @param lang   BCP-47 language code or 'auto'. 'auto' → 'hi-IN' default.
 * @param onEnd  Called when speech finishes or is stopped.
 */
export function speakText(
  text: string,
  lang: SupportedLanguageCode | 'auto',
  onEnd?: () => void,
): void {
  if (!isSpeechSynthesisSupported()) {
    onEnd?.();
    return;
  }

  stopTts();
  _speaking = true;

  const finish = (): void => {
    _speaking = false;
    onEnd?.();
  };

  const bcp47: string = lang === 'auto' ? 'hi-IN' : lang;

  // Strip markdown: **bold**, *italic*, _italic_, #heading, `code`, [link](url)
  const clean = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#`[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) { finish(); return; }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = bcp47;
  utterance.rate = 0.95;

  // Try to find an installed voice matching the language prefix.
  // getVoices() may return [] on first call (async load in some browsers);
  // in that case the browser uses its default voice — acceptable fallback.
  const prefix = bcp47.split('-')[0] ?? '';
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith(prefix));
  if (voice) utterance.voice = voice;

  utterance.onend   = finish;
  utterance.onerror = finish;

  window.speechSynthesis.speak(utterance);
}
