// Push notifications — ARCHITECTURE ONLY (per spec: prepare, do not activate).
//
// The service worker (sw.js) already carries the 'push' and
// 'notificationclick' handlers. Activating push later takes three steps,
// none of which require touching the rest of the app:
//   1. generate a VAPID key pair server-side and put the PUBLIC key below,
//   2. call enablePushNotifications() from a settings screen,
//   3. store the returned subscription (POST to a backend / Supabase table)
//      and send Web-Push messages to it from the server.
// Nothing in the app calls these functions yet.
export const VAPID_PUBLIC_KEY = ''; // set when the server side exists

const b64ToU8 = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
};

export async function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Ask permission and create the browser-side subscription. Returns the
// PushSubscription (send it to the server) or null when unavailable/denied.
export async function enablePushNotifications() {
  if (!(await pushSupported()) || !VAPID_PUBLIC_KEY) return null;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY),
  });
}

export async function currentPushSubscription() {
  if (!(await pushSupported())) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
