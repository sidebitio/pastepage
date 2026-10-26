// Small shared helpers for the feed and the composer: display-name limit, byte sizes, highlight.js language
// names, language detection that stays fast on large notes, which text a paste sends, and how a text is shown.
import { currentLocale } from './i18n.js';

/**
 * The text to send. A text box turns Windows (CRLF) and old Mac (CR) line endings into LF, so for a paste the
 * clipboard's own text is kept: it is sent byte for byte as long as the box still holds exactly that paste, with
 * only its line endings changed. Anything else (typed, edited, or pasted into text already there) is sent as the
 * box holds it.
 * @param {{raw: string|null, valueAfterPaste: string|null, current: string}} parts raw: the clipboard text of the
 *   last paste; valueAfterPaste: the box's value right after that paste; current: the box's value now
 * @returns {string}
 */
export function chooseOutgoing({ raw, valueAfterPaste, current }) {
  if (typeof raw !== 'string' || raw === '' || current !== valueAfterPaste) return current;
  return valueAfterPaste === raw.replace(/\r\n?/g, '\n') ? raw : current;
}

/**
 * The text as it is shown: Windows (CRLF) and old Mac (CR) line endings become LF, so every one of them shows as a
 * line break (a lone CR would not). For display, highlighting and counting only; Copy and sending use the text itself.
 * @param {string} text the note text, exactly as sent
 * @returns {string}
 */
export const displayText = (text) => text.replace(/\r\n?/g, '\n');

/** Display names are cut to this many characters: a participant can put any name in their payload. */
export const NAME_MAX = 40;
/** Auto-detection looks at this many characters at the start of a note; the rest is highlighted with the language found. */
export const DETECT_SAMPLE = 10000;
/** A detected language needs at least this relevance score to count. */
export const DETECT_MIN_RELEVANCE = 3;

/**
 * Format a byte count as B, KB or MB, with the number in the current locale's style.
 * @param {number} n bytes
 * @param {(key: string, vars?: object) => string} t translate function
 * @returns {string} e.g. "1.5 KB"
 */
export function fmtBytes(n, t) {
  const num = (x, digits) => new Intl.NumberFormat(currentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x);
  if (n < 1024) return t('size.b', { n: num(n, 0) });
  if (n < 1048576) return t('size.kb', { n: num(n / 1024, n < 10240 ? 1 : 0) });
  return t('size.mb', { n: num(n / 1048576, 1) });
}

/**
 * The display name highlight.js has for a language id.
 * @param {string} lang highlight.js language id or alias
 * @param {object} [hljs] highlight.js instance; defaults to the page's global
 * @returns {string|null} e.g. "SQL", or null if highlight.js is missing or doesn't know the language
 */
export function langName(lang, hljs = globalThis.hljs) {
  const name = typeof lang === 'string' ? hljs?.getLanguage(lang)?.name : undefined;
  return typeof name === 'string' && name ? name : null;
}

/**
 * Detect the language of a note and highlight it. Detection runs on the first DETECT_SAMPLE characters
 * only (highlightAuto tries every language and is slow on large text); a long note is then highlighted
 * once, in full, with the language that was found.
 * @param {object} hljs highlight.js instance
 * @param {string} text the note text
 * @returns {{language: string, value: string}|null} highlighted HTML, or null when no language fits
 */
export function detectHighlight(hljs, text) {
  const sample = text.length > DETECT_SAMPLE ? text.slice(0, DETECT_SAMPLE) : text;
  const r = hljs.highlightAuto(sample);
  if (!r.language || r.relevance < DETECT_MIN_RELEVANCE || !langName(r.language, hljs)) return null;
  if (sample === text) return { language: r.language, value: r.value };
  return { language: r.language, value: hljs.highlight(text, { language: r.language, ignoreIllegals: true }).value };
}

/**
 * Cut a display name to NAME_MAX characters (whole code points, so emoji stay intact).
 * @param {string} name
 * @returns {string}
 */
export function capName(name) {
  const s = String(name ?? '');
  if (s.length <= NAME_MAX) return s;
  return Array.from(s.slice(0, NAME_MAX * 2)).slice(0, NAME_MAX).join('');
}

/**
 * Create an element with a class name and optional text (set as text, never as HTML).
 * @param {string} tag element name, e.g. 'div'
 * @param {string} [className] class attribute; none when empty or omitted
 * @param {string} [text] text content
 * @returns {HTMLElement}
 */
export function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Create a <button type="button"> with a class name, text and click handler.
 * @param {string} className class attribute, '' for none
 * @param {string} text button label
 * @param {(e: MouseEvent) => void} onClick click handler
 * @returns {HTMLButtonElement}
 */
export function button(className, text, onClick) {
  const b = make('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * How far to scroll the window so an element stays at the same place on screen after the page changed height.
 * @param {number} before the element's top (getBoundingClientRect) before the change
 * @param {number} after its top after the change
 * @returns {number} the amount to pass to window.scrollBy(0, ...)
 */
export const scrollDelta = (before, after) => after - before;

/**
 * Whether a note is folded behind "Show all": only a note with more lines than the limit.
 * @param {number} lines the note's line count
 * @param {number} limit the number of lines a folded note shows
 * @returns {boolean}
 */
export const isFoldable = (lines, limit) => lines > limit;
