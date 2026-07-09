// Formatting + small pure helpers shared across the Supply Chain app.

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (v) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const qty = (v) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const num = (v) =>
  v == null || isNaN(v) ? '0' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const approxEq = (a, b, eps = 0.01) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;
