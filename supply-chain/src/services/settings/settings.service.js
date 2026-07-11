// User settings — ONE store for the personal preferences every module reads:
// language, theme, date format, number format, time zone, currency.
// Persisted locally per device (the app runs without auth); the format
// helpers in utils/format.js consult these on every call, so changing a
// setting re-formats the whole app instantly on the next render.
const KEY = 'sc-settings';

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'];
export const NUMBER_FORMATS = ['1,234.56', '1.234,56'];
export const CURRENCIES = ['SAR', 'USD', 'EUR', 'UAH'];
export const TIME_ZONES = ['local', 'Asia/Riyadh', 'Europe/Kyiv', 'UTC'];

const DEFAULTS = {
  language: 'en',
  theme: 'light',
  dateFormat: 'YYYY-MM-DD',
  numberFormat: '1,234.56',
  timeZone: 'local',
  currency: 'SAR',
};

let cache = null;
export function getSettings() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}')) }; }
  catch (e) { cache = { ...DEFAULTS }; }
  return cache;
}
export function setSetting(key, value) {
  const s = { ...getSettings(), [key]: value };
  cache = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  return s;
}
export const getSetting = (key) => getSettings()[key];
