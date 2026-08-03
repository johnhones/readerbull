// Shared helper for api/import-book.js and api/enrich-audit.js.
//
// Both files already verify the caller's Supabase session inline (Bearer
// token, GET /auth/v1/user) before doing any paid work, that check has
// been in place since 30 July / 1 August 2026. This file only adds a
// backstop on top of it: a per-user, per-endpoint hourly cap, so a
// compromised or careless real account still can't run unbounded
// SerpApi/DataForSEO/Anthropic spend. Backed by the api_call_log table
// (see api_call_log_migration.sql in the project root).
//
// Uses the caller's own forwarded token for every Supabase call, so
// Postgres RLS naturally scopes every read/write to auth.uid() = user_id,
// no service-role key needed here, unlike api/export-backup.js.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
// Same publishable (anon) key already shipped to the browser in
// supabase-client.js, safe to use here too, it identifies the project,
// it does not grant any access by itself.
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

// Returns true if `auth.userId` is still under `maxPerHour` calls to
// `endpoint` in the last hour, and logs this call if so. Returns false
// (caller should respond 429) once the cap is hit. Fails open on the
// check itself (a Supabase hiccup should not block a real author), the
// existing session check is the main defence, this is a backstop.
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
  } catch (err) {
    // fail open, see note above
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
  checkRateLimit: checkRateLimit
};
