// Vercel serverless function: opens Stripe's hosted Billing Portal for an
// already-paying author, so they can update their card, switch between
// Plus/Pro, change monthly/yearly, or cancel, all inside Stripe's own UI.
// No custom billing management screen to build or maintain (payment
// system build, 5 August 2026).
//
// Reads stripe_customer_id with the service_role key rather than trusting
// anything the client sends, same reasoning as export-backup.js: this is
// the one place besides the webhook that's allowed to read across RLS,
// and only ever to fetch the caller's own id (looked up by their own
// verified user_id, never taken from the request body).
//
// POST {} (no body needed) or { origin: "https://readerbull.com" }
// Header: Authorization: Bearer <supabase access token>
// -> { url: "https://billing.stripe.com/..." }

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';
var DEFAULT_ORIGIN = 'https://readerbull.com';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var secretKey = process.env.STRIPE_SECRET_KEY;
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey || !serviceKey) {
    res.status(500).json({ error: 'Payments are not configured yet.' });
    return;
  }

  var authToken = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!authToken) {
    res.status(401).json({ error: 'Please sign in again, your session could not be found.' });
    return;
  }
  var authCheck = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + authToken }
  });
  if (!authCheck.ok) {
    res.status(401).json({ error: 'Your session has expired, please sign in again.' });
    return;
  }
  var authUser = await authCheck.json();

  var input = req.body || {};
  var origin = (typeof input.origin === 'string' && /^https:\/\//.test(input.origin)) ? input.origin : DEFAULT_ORIGIN;

  var subResp = await fetch(
    SUPABASE_URL + '/rest/v1/subscriptions?select=stripe_customer_id&user_id=eq.' + encodeURIComponent(authUser.id),
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  var subRows = await subResp.json();
  var customerId = subResp.ok && Array.isArray(subRows) && subRows[0] && subRows[0].stripe_customer_id;

  if (!customerId) {
    res.status(400).json({ error: "You don't have a billing account yet, subscribe to a plan first." });
    return;
  }

  var params = new URLSearchParams();
  params.append('customer', customerId);
  params.append('return_url', origin + '/dashboard.html');

  try {
    var stripeResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    var portalSession = await stripeResp.json();
    if (!stripeResp.ok) {
      res.status(502).json({ error: (portalSession.error && portalSession.error.message) || 'Stripe could not open the billing portal.' });
      return;
    }

    res.status(200).json({ url: portalSession.url });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Stripe, please try again.' });
  }
};
