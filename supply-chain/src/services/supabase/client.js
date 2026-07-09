// Supabase client — the ONLY thing the Supply Chain app shares with the Sales
// Dashboard is this database. The client is created once and reused.
//
// The publishable (anon) key is public by design; access is governed by RLS.

export const SUPABASE_CONFIG = {
  url: 'https://wrkugzssuoxneftzappa.supabase.co',
  anonKey: 'sb_publishable_00A8lWi4_A3HC5tjlRJw0w_rRlLzlrA',
};

let _client = null;

export function getClient() {
  if (_client) return _client;
  const lib = window.supabase; // supabase-js UMD, loaded in index.html
  if (!lib || !lib.createClient) throw new Error('Supabase library is not loaded');
  _client = lib.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: { persistSession: false },
  });
  return _client;
}

// PostgREST embeds a UNIQUE-FK relation as a single object (or null); normalise.
export const one = (x) => (Array.isArray(x) ? x[0] || null : x || null);
