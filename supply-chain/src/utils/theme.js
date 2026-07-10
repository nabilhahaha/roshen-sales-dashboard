// Theme system — Dark (default) / Light. Themes are pure CSS design tokens
// (:root and :root[data-theme="light"] in app.css); switching only flips the
// data-theme attribute on <html>, so every component that reads var(--…)
// re-themes instantly with no reload. The choice persists in localStorage and
// is restored before first paint by an inline script in index.html.
const KEY = 'rr-theme';

export function getTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(KEY, t); } catch (e) { /* private mode */ }
  return t;
}

export function toggleTheme() {
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
