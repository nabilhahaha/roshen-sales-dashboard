// Internationalisation — English (default) · العربية (RTL) · Українська.
//
// One mechanism, zero per-page rewrites: every UI string keeps its ENGLISH
// source (the translation KEY) and the translation files (ar.js / uk.js) map
// source → translation. Two delivery paths:
//   · t(str)         — for code that builds strings for exports/print/docs
//   · DOM translator — walks the live DOM (text nodes + placeholder/title/
//     aria-label attributes), remembers each node's English source, and
//     re-renders it in the active language; a MutationObserver keeps every
//     later render translated. Switching back to English restores sources.
// Numbers, document numbers, SKU codes and dates are untouched (per spec:
// numbers remain English in Arabic). Arabic also flips the layout to RTL by
// setting dir on <html> — the flex/grid layout mirrors automatically.
import { AR, AR_PATTERNS } from './ar.js';
import { UK, UK_PATTERNS } from './uk.js';
import { getSettings, setSetting } from '../services/settings/settings.service.js';

// Template helper for the dictionary files: '«#»' in the source marks a
// number (kept western in every language); '«1»','«2»'… in the output puts
// the captured numbers back. Returns the {re, out} pairs t() consumes.
export function mkPatterns(map) {
  return Object.entries(map).map(([src, tgt]) => {
    let re;
    try {
      re = new RegExp('^' + src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/«#»/g, '(\\d[\\d,.:/%\\-]*)') + '$');
    } catch (e) { re = /$^/; }
    return { re, out: (m) => tgt.replace(/«(\d)»/g, (_, k) => m[+k] ?? '') };
  });
}

export const LOCALES = {
  en: { name: 'English', dir: 'ltr' },
  ar: { name: 'العربية', dir: 'rtl' },
  uk: { name: 'Українська', dir: 'ltr' },
};
const DICTS = { ar: AR, uk: UK };
const PATTERNS = { ar: AR_PATTERNS, uk: UK_PATTERNS };

let locale = 'en';
const missing = new Set(); // surfaced by the coverage tooling
export const missingTranslations = () => [...missing];

export const getLocale = () => locale;

// translate one string (exports, print documents, dynamically built labels)
export function t(src) {
  const s = String(src == null ? '' : src);
  if (locale === 'en' || !s.trim()) return s;
  const d = DICTS[locale] || {};
  const hit = d[s] || d[s.trim()];
  if (hit) return s.replace(s.trim(), hit);
  for (const p of PATTERNS[locale] || []) {
    const m = p.re.exec(s.trim());
    if (m) return s.replace(s.trim(), p.out(m));
  }
  // ignore pure numbers / codes / dates / emoji-only strings
  if (/[A-Za-z]{2,}/.test(s) && !/^[A-Z0-9/_.-]+$/.test(s.trim())) missing.add(s.trim());
  return s;
}

// ---- live-DOM translation -----------------------------------------------------
const ATTRS = ['placeholder', 'title', 'aria-label', 'data-th'];
const SKIP = /^(script|style|svg)$/i;

function translateNode(n) {
  if (n.nodeType === Node.TEXT_NODE) {
    const src = n.__i18nSrc != null ? n.__i18nSrc : n.nodeValue;
    if (!src || !src.trim()) return;
    if (n.__i18nSrc == null) n.__i18nSrc = src;
    const out = locale === 'en' ? src : t(src);
    if (n.nodeValue !== out) n.nodeValue = out;
    return;
  }
  if (n.nodeType !== Node.ELEMENT_NODE || SKIP.test(n.tagName)) return;
  ATTRS.forEach((a) => {
    if (!n.hasAttribute || !n.hasAttribute(a)) return;
    const key = '__i18n_' + a;
    const src = n[key] != null ? n[key] : n.getAttribute(a);
    if (!src || !src.trim()) return;
    if (n[key] == null) n[key] = src;
    const out = locale === 'en' ? src : t(src);
    if (n.getAttribute(a) !== out) n.setAttribute(a, out);
  });
  for (const ch of n.childNodes) translateNode(ch);
}

export function translateTree(root) { if (root) translateNode(root); }

let observer = null;
export function startI18n() {
  const s = getSettings();
  locale = LOCALES[s.language] ? s.language : 'en';
  applyDir();
  const app = document.getElementById('app') || document.body;
  translateTree(app);
  if (observer) observer.disconnect();
  observer = new MutationObserver((muts) => {
    if (locale === 'en') return;
    for (const m of muts) {
      if (m.type === 'characterData') { m.target.__i18nSrc = null; translateNode(m.target); }
      m.addedNodes && m.addedNodes.forEach((n) => translateNode(n));
    }
  });
  observer.observe(app, { childList: true, subtree: true, characterData: true });
}

function applyDir() {
  const el = document.documentElement;
  el.lang = locale;
  el.dir = LOCALES[locale].dir;
}

export function setLocale(next) {
  if (!LOCALES[next]) return locale;
  locale = next;
  setSetting('language', next);
  applyDir();
  translateTree(document.getElementById('app') || document.body);
  document.dispatchEvent(new CustomEvent('sc-locale', { detail: { locale } }));
  return locale;
}
