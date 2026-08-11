// Vercel serverless function: starts a Stripe Checkout session for an
// authenticated author upgrading to Plus or Pro (payment system build,
// 5 August 2026). Matches the tiers actually live on pricing.html:
// Plus (up to 3 books, $9/mo or $90/yr), Pro (4 to 10 books, $28/mo or
// $280/yr). Custom (11+ books) is contact-us only, no self-serve
// checkout, not handled here.
//
// No `stripe` npm package: this codebase has no package.json anywhere
// (import-book.js, enrich-audit.js etc. all call third-party APIs with
// plain fetch), so this file talks to the Stripe API directly over
// fetch too, for consistency and to avoid introducing a build step.
// Stripe's API takes form-encoded bodies, not JSON, hence the manual
// URLSearchParams construction below.
//
// Deliberately does NOT write anything to Supabase itself. The Stripe
// customer/subscription only get persisted to public.subscriptions once
// Stripe confirms payment via api/stripe-webhook.js's
// checkout.session.completed handler, that is the one source of truth
// for "is this author actually paying," never trust the client-side
// checkout call alone.
//
// POST { plan: "plus"|"pro", interval: "monthly"|"yearly", origin: "https://readerbull.com" }
// Header: Authorization: Bearer <supabase access token>
// -> { url: "https://checkout.stripe.com/..." }

// Live-mode Price IDs (created in Stripe 11 August 2026), confirmed
// against the live pricing page's own figures ($9/$90 Plus, $28/$280
// Pro). This is main/production, so these are real, chargeable prices,
// not test-mode ones, STRIPE_SECRET_KEY in Vercel's Production
// environment must be the matching live secret key or these Price IDs
// will not resolve. staging keeps the test-mode IDs, see the git log
// on this file for that version.
var PRICE_IDS = {
  plus: {
    monthly: 'price_1U3KycBqkDn8JXbQJvOCJhlP',
    yearly: 'price_1U3L37BqkDn8JXbQXN76YSHO'
  },
  pro: {
    monthly: 'price_1U3L5qBqkDn8JXbQq5nQJRnL',
    yearly: 'price_1U3L5qBqkDn8JXbQJxzavRS6'
  }
};

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';
var DEFAULT_ORIGIN = 'https://readerbull.com';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ error: 'Payments are not configured yet, STRIPE_SECRET_KEY is missing.' });
    return;
  }

  // Same Bearer-token session check as import-book.js/enrich-audit.js.
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
  var plan = String(input.plan || '').toLowerCase();
  var interval = String(input.interval || '').toLowerCase();
  var origin = (typeof input.origin === 'string' && /^https:\/\//.test(input.origin)) ? input.origin : DEFAULT_ORIGIN;

  var priceId = PRICE_IDS[plan] && PRICE_IDS[plan][interval];
  if (!priceId) {
    res.status(400).json({ error: 'Unknown plan or billing interval.' });
    return;
  }

  var params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', origin + '/dashboard.html?checkout=success');
  params.append('cancel_url', origin + '/pricing.html?checkout=cancelled');
  params.append('client_reference_id', authUser.id);
  params.append('metadata[supabase_user_id]', authUser.id);
  params.append('metadata[plan]', plan);
  params.append('metadata[interval]', interval);
  // Also stamped onto the subscription object itself (not just this
  // checkout session), because subscription.updated/deleted webhook
  // events only carry the subscription, never the original session.
  params.append('subscription_data[metadata][supabase_user_id]', authUser.id);
  if (authUser.email) params.append('customer_email', authUser.email);

  try {
    var stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    var session = await stripeResp.json();
    if (!stripeResp.ok) {
      res.status(502).json({ error: (session.error && session.error.message) || 'Stripe could not start checkout.' });
      return;
    }

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Stripe, please try again.' });
  }
};
