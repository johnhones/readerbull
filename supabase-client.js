/*
 * Readerbull Supabase client
 * -----------------------------------------------------------------------
 * Publishable (anon) key only, safe for the browser. Magic link is the
 * default, frictionless sign-in for everyone. Authors can optionally set a
 * password from their dashboard (Settings > Set a password) for a faster
 * return login, especially useful on mobile where email can be slow to
 * arrive, see login.html for the password sign-in form.
 * Requires the Supabase UMD script to be loaded on the page before this
 * file, see the <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js">
 * tag in each page's <head>.
 */
var readerbull = (function () {
  var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  /** Redirect to the homepage if there's no logged-in user. Returns the user or null. */
  async function requireUser(redirectTo) {
    var { data } = await client.auth.getUser();
    if (!data || !data.user) {
      window.location.href = redirectTo || 'index.html';
      return null;
    }
    return data.user;
  }

  async function signOut() {
    await client.auth.signOut();
    window.location.href = 'index.html';
  }

  return {
    client: client,
    requireUser: requireUser,
    signOut: signOut
  };
})();
