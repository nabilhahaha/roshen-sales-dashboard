// Roles & permissions — the ONE place the app asks "who is this and what may
// they do". The application currently runs without authentication
// ("Development · NO AUTH"), so the operator identity and role come from
// local settings; when a real auth provider lands, only THIS module changes —
// every permission gate in services and UI already calls through here.
//
// Roles: viewer (preview/download only) · admin (upload, operate) ·
//        super_admin (approve/apply amendments, full access)
const KEY_ROLE = 'sc-role';
const KEY_USER = 'sc-user';

export const ROLES = ['viewer', 'admin', 'super_admin'];

export function currentRole() {
  try {
    const r = localStorage.getItem(KEY_ROLE);
    if (ROLES.includes(r)) return r;
  } catch (e) { /* private mode */ }
  return 'super_admin'; // development default until auth exists
}
export function setRole(role) {
  if (!ROLES.includes(role)) throw new Error('Unknown role: ' + role);
  try { localStorage.setItem(KEY_ROLE, role); } catch (e) { /* noop */ }
}
export function currentActor() {
  try { return localStorage.getItem(KEY_USER) || 'Development'; } catch (e) { return 'Development'; }
}
export function setActor(name) {
  try { localStorage.setItem(KEY_USER, String(name || 'Development')); } catch (e) { /* noop */ }
}

export const canUpload = () => currentRole() !== 'viewer';
export const canApproveAmendments = () => currentRole() === 'super_admin';
