// Shared helper for api/import-book.js and api/enrich-audit.js.
//
// Why this exists (3 August 2026 security pass): both endpoints used to
// have zero protection, the only check was that the request was a POST.
// No session check, no origin check, no rate limit. Anyone who found the
// URL (visible in onboarding.html's own client-side JS) could call either
// endpoint directly, no account needed, and each call runs real, billed
// SerpApi/DataForSEO/Anthropic requests. enrich-audit.js specifically is
// worse than "one call per hit": its fallback chains (built so a real
// author never sees an empty keyword table, see
// ReaderBull_Project_Rules.md rule 12) mean a garbage or empty request
// walks every fallback before giving up, so a single POST of `{}` can
// trigger somewhere around 8-10 separate paid calls.
//
// This file closes both gaps with infrastructure that already exists,
// no new vendor, no new secret:
//
// 1. requireAuthedUser: verifies the caller's Supabase session token by
//    asking Supabase itself (GET /auth/v1/user), rather than us handling
//    JWT verification. Requires a real, logged-in author, which by itself
//    removes the "no account needed" abuse path, since getting a session
//    means completing signup and clicking a real magic-link email.
//
// 2. checkRateLimit: a per-user, per-endpoint hourly cap, backed by a new
//    api_call_log table (see the SQL migration handed to John separately,
//    this file assumes that table already exists). Uses the caller's own
//    forwarded token for every Supabase call, so Postgres RLS naturally
//    scopes every read/write to auth.uid() = user_id, no service-role key
//    needed here, unlike api/export-backup.js.
//
// Deliberately fails open on the rate-limit *check* itself (a Supabase
// hiccup should not block a real author), but fails closed on auth (no
// token, or an invalid/expired one, always returns null and the caller
// rejects with 401). The auth requirement is the main defence, the rate
// limit is a backstop against a compromised or careless real account.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
// Same publishable (anon) key already shipped to the browser in
// supabase-client.js, safe to use here too, it identifies the project,
// it does not grant any access by itself.
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

// Verifies the Authorization: Bearer <token> header against Supabase.
// Returns { userId, token } on success, or null if the header is
// missing, malformed, or the token doesn't resolve to a real user.
async function requireAuthedUser(req) {
  var authHeader = (req.headers && req.headers.authorization) || '';
  var token = authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7).trim() : null;
  if (!token) return null;

  try {
    var resp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token
      }
    });
    if (!resp.ok) return null;

    var data = await resp.json();
    if (!data || !data.id) return null;

    return { userId: data.id, token: token };
  } catch (err) {
    return null;
  }
}

// Returns true if `auth.userId` is still under `maxPerHour` calls to
// `endpoint` in the last hour, and logs this call if so. Returns false
// (caller should respond 429) once the cap is hit.
async function checkRateLimit(auth, endpoint, maxPerHour) {
  var since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + auth.token,
    'Content-Type': 'application/json'
  };

  try {
    var countUrl = SUPABASE_URL + '/rest/v1/api_call_log?select=id' +
      '&user_id=eq.' + encodeURIComponent(auth.userId) +
      '&endpoint=eq.' + encodeURIComponent(endpoint) +
      '&created_at=gte.' + encodeURIComponent(since);
    var countResp = await fetch(countUrl, { headers: headers });
    if (countResp.ok) {
      var rows = await countResp.json();
      if (Array.isArray(rows) && rows.length >= maxPerHour) {
        return false;
      }
    }
    // If the count check itself fails (network hiccup, table not there
    // yet), fall through and allow the request, see "fails open" note
    // above, the auth requirement is already the main defence.
  } catch (err) {
    // same fail-open reasoning
  }

  try {
    await fetch(SUPABASE_URL + '/rest/v1/api_call_log', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ user_id: auth.userId, endpoint: endpoint })
    });
  } catch (err) {
    // a failed log write should never block the real request
  }

  return true;
}

module.exports = {
  requireAuthedUser: requireAuthedUser,
  checkRateLimit: checkRateLimit
};
