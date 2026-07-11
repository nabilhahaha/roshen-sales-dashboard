// Settings — General preferences: Language, Theme, Date Format, Number
// Format, Time Zone, Currency. One store (settings.service); the format
// helpers and the i18n layer read it live, so changes apply immediately.
import { mount } from '../../utils/dom.js';
import { esc } from '../../utils/format.js';
import { toast } from '../../components/notifications/toast.js';
import { getSettings, setSetting, DATE_FORMATS, NUMBER_FORMATS, CURRENCIES, TIME_ZONES } from '../../services/settings/settings.service.js';
import { setTheme } from '../../utils/theme.js';
import { LOCALES, setLocale, t } from '../../i18n/i18n.js';

export function render(root) {
  const s = getSettings();
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label || v)}</option>`;
  mount(root, `
    <div class="sc-card-h"><h3>⚙️ ${t('Settings')}</h3></div>
    <div class="sc-card">
      <div class="sc-card-h"><h3>${t('General')}</h3></div>
      <div class="set-grid">
        <div class="sc-field"><label>🌐 ${t('Language')}</label>
          <select class="sc-select" data-set="language">${Object.entries(LOCALES).map(([k, v]) => opt(k, s.language, v.name)).join('')}</select></div>
        <div class="sc-field"><label>${t('Theme')}</label>
          <select class="sc-select" data-set="theme">${opt('light', s.theme, '☀ ' + t('Light'))}${opt('dark', s.theme, '🌙 ' + t('Dark'))}</select></div>
        <div class="sc-field"><label>${t('Date Format')}</label>
          <select class="sc-select" data-set="dateFormat">${DATE_FORMATS.map((f) => opt(f, s.dateFormat)).join('')}</select></div>
        <div class="sc-field"><label>${t('Number Format')}</label>
          <select class="sc-select" data-set="numberFormat">${NUMBER_FORMATS.map((f) => opt(f, s.numberFormat)).join('')}</select></div>
        <div class="sc-field"><label>${t('Time Zone')}</label>
          <select class="sc-select" data-set="timeZone">${TIME_ZONES.map((z) => opt(z, s.timeZone, z === 'local' ? t('Device time zone') : z)).join('')}</select></div>
        <div class="sc-field"><label>${t('Currency')}</label>
          <select class="sc-select" data-set="currency">${CURRENCIES.map((cu) => opt(cu, s.currency)).join('')}</select></div>
      </div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:12px 0 0">${t('Preferences are saved on this device and apply immediately.')}</p>
    </div>`);

  root.querySelectorAll('[data-set]').forEach((sel) => sel.addEventListener('change', () => {
    const k = sel.dataset.set, v = sel.value;
    setSetting(k, v);
    if (k === 'theme') setTheme(v);
    if (k === 'language') setLocale(v);
    toast(t('Setting saved'), 'ok');
    render(root); // re-render so the page itself reflects the new language/format
  }));
}
