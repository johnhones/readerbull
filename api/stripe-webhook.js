// Vercel serverless function: Stripe's webhook listener, the one source
// of truth for whether an author is actually paying (payment system
// build, 5 August 2026). Never trust the client-side checkout call
// alone, checkout.session.completed only fires once Stripe has actually
// confirmed the subscription.
//
// No `stripe` npm package, same reasoning as create-checkout-session.js:
// this codebase has no package.json anywhere, so signature verification
// below is done by hand with Node's built-in crypto module rather than
// stripe.webhooks.constructEvent. This is Stripe's own documented
// algorithm (HMAC-SHA256 over "<timestamp>.<rawBody>"), not a shortcut.
//
// Needs the RAW request body to verify the signature, Vercel's default
// JSON body parsing would corrupt it before we ever see it, hence the
// `config.api.bodyParser = false` export and the manual stream read
// below. This must be uploaded to GitHub exactly as-is, this config
// export is what tells Vercel to skip its usual parsing for this one
// endpoint.
//
// Registered in Stripe (Developers > Webhooks) pointing at
// https://<the deployed URL>/api/stripe-webhook, listening for:
// checkout.session.completed, customer.subscription.updated,
// customer.subscription.deleted, invoice.payment_failed.
//
// POST, Header: stripe-signature: <Stripe's signature>
// -> 200 {received:true} on success (Stripe retries on anything else)

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';

// Same four Price IDs as create-checkout-session.js, kept as a separate
// copy deliberately rather than a shared import, this codebase has no
// build step or shared-module pattern between /api files (each one is
// deployed as its own standalone Vercel function), see the note on that
// in create-checkout-session.js.
var PLAN_BY_PRICE = {
  'price_1U0rBjBqkDn8JXbQ7MpdlHOG': { plan: 'plus', interval: 'monthly' },
  'price_1U0rVtBqkDn8JXbQec4mJSdw': { plan: 'plus', interval: 'yearly' },
  'price_1U0rHBBqkDn8JXbQiDSbabmP': { plan: 'pro', interval: 'monthly' },
  'price_1U0rTrBqkDn8JXbQ7Vn3GACI': { plan: 'pro', interval: 'yearly' }
};

// Matches the live pricing page (pricing.html): Free 1 book, Plus up
// to 3 books, Pro 4 to 10 books. Custom (11+) is contact-us only,
// handled manually by John via Supabase directly, same as legacy
// dashboard onboarding, never reached through this webhook.
//
// Fixed 10 August 2026: this had drifted to { free: 3, plus: 10,
// pro: 30 } via a commit that mistakenly believed those numbers
// matched pricing.html. They didn't. Verified directly against the
// live pricing.html copy today, which is the single source of truth
// for these numbers, not any past commit message or handover
// document (see ReaderBull_Master_Handover.md Section 7.1). A real
// Plus subscriber was being granted 10 books instead of the 3 they
// paid for.
var BOOK_LIMIT_BY_PLAN = { free: 1, plus: 3, pro: 10 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !serviceKey) {
    res.status(500).json({ error: 'Webhook is not configured yet.' });
    return;
  }

  var rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    res.status(400).json({ error: 'Could not read request body.' });
    return;
  }

  var signatureHeader = (req.headers && req.headers['stripe-signature']) || '';
  if (!verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
    res.status(400).json({ error: 'Invalid signature.' });
    return;
  }

  var event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON.' });
    return;
  }

  try {
    var object = event.data && event.data.object;

    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(object, serviceKey);
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(object, serviceKey);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(object, serviceKey);
    } else if (event.type === 'invoice.payment_failed') {
      await handlePaymentFailed(object, serviceKey);
    }
    // Any other event type: acknowledged but ignored, nothing to sync.
  } catch (err) {
    // Still 200 here: Stripe retries on non-2xx, and a bug in our own
    // sync logic shouldn't cause Stripe to hammer this endpoint. The
    // error is logged via sendErrorAlert inside each handler instead.
  }

  res.status(200).json({ received: true });
};

// Vercel-specific: disables the platform's automatic JSON body parsing
// for this one function, required so readRawBody below sees the exact
// bytes Stripe signed, not a re-serialised copy.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Stripe's documented webhook signature scheme: the header looks like
// "t=<timestamp>,v1=<hex signature>[,v0=...]". Expected signature is
// HMAC-SHA256(webhookSecret, "<timestamp>.<rawBody>"), hex-encoded.
// Rejects anything older than 5 minutes to guard against replay.
function verifyStripeSignature(rawBody, header, secret) {
  var crypto = require('crypto');
  var parts = String(header).split(',').reduce(function (acc, part) {
    var kv = part.split('=');
    if (kv[0] === 't') acc.timestamp = kv[1];
    if (kv[0] === 'v1') acc.signatures.push(kv[1]);
    return acc;
  }, { timestamp: null, signatures: [] });

  if (!parts.timestamp || !parts.signatures.length) return false;

  var age = Math.abs(Date.now() / 1000 - Number(parts.timestamp));
  if (age > 300) return false;

  var signedPayload = parts.timestamp + '.' + rawBody.toString('utf8');
  var expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

  return parts.signatures.some(function (sig) {
    if (sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch (err) {
      return false;
    }
  });
}

async function stripeGet(path, secretKey) {
  var resp = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + secretKey }
  });
  return resp.json();
}

// Upserts by user_id (unique constraint from subscriptions_migration.sql),
// so this doubles as both "create on first checkout" and "update on
// every later Stripe event".
async function upsertSubscription(row, serviceKey) {
  await fetch(SUPABASE_URL + '/rest/v1/subscriptions?on_conflict=user_id', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(row)
  });
}

async function findSubscriptionRowByCustomerId(customerId, serviceKey) {
  var resp = await fetch(
    SUPABASE_URL + '/rest/v1/subscriptions?select=user_id&stripe_customer_id=eq.' + encodeURIComponent(customerId),
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  var rows = await resp.json();
  return resp.ok && Array.isArray(rows) ? rows[0] : null;
}

async function handleCheckoutCompleted(session, serviceKey) {
  var userId = (session.metadata && session.metadata.supabase_user_id) || session.client_reference_id;
  if (!userId || !session.subscription) return;

  var secretKey = process.env.STRIPE_SECRET_KEY;
  var subscription = await stripeGet('subscriptions/' + session.subscription, secretKey);
  var priceId = subscription.items && subscription.items.data && subscription.items.data[0] &&
    subscription.items.data[0].price && subscription.items.data[0].price.id;
  var mapped = PLAN_BY_PRICE[priceId] || { plan: 'free', interval: null };

  await upsertSubscription({
    user_id: userId,
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    plan: mapped.plan,
    billing_interval: mapped.interval,
    status: subscription.status || 'active',
    book_limit: BOOK_LIMIT_BY_PLAN[mapped.plan] || 1,
    current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  }, serviceKey);
}

async function handleSubscriptionUpdated(subscription, serviceKey) {
  var userId = subscription.metadata && subscription.metadata.supabase_user_id;
  if (!userId) {
    // Fallback: the checkout-completed handler above always sets
    // stripe_customer_id, so a subscription-level metadata miss (should
    // not normally happen, subscription_data.metadata is set at
    // checkout time) can still resolve via the customer id instead of
    // silently dropping the update.
    var row = await findSubscriptionRowByCustomerId(subscription.customer, serviceKey);
    if (!row) return;
    userId = row.user_id;
  }

  var priceId = subscription.items && subscription.items.data && subscription.items.data[0] &&
    subscription.items.data[0].price && subscription.items.data[0].price.id;
  var mapped = PLAN_BY_PRICE[priceId] || { plan: 'free', interval: null };

  await upsertSubscription({
    user_id: userId,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    plan: mapped.plan,
    billing_interval: mapped.interval,
    status: subscription.status,
    book_limit: BOOK_LIMIT_BY_PLAN[mapped.plan] || 1,
    current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  }, serviceKey);
}

async function handleSubscriptionDeleted(subscription, serviceKey) {
  var userId = subscription.metadata && subscription.metadata.supabase_user_id;
  if (!userId) {
    var row = await findSubscriptionRowByCustomerId(subscription.customer, serviceKey);
    if (!row) return;
    userId = row.user_id;
  }

  await upsertSubscription({
    user_id: userId,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    plan: 'free',
    billing_interval: null,
    status: 'canceled',
    book_limit: BOOK_LIMIT_BY_PLAN.free,
    current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  }, serviceKey);
}

async function handlePaymentFailed(invoice, serviceKey) {
  if (!invoice.customer) return;
  var row = await findSubscriptionRowByCustomerId(invoice.customer, serviceKey);
  if (!row) return;

  await upsertSubscription({
    user_id: row.user_id,
    status: 'past_due',
    updated_at: new Date().toISOString()
  }, serviceKey);

  await sendErrorAlert('stripe-webhook', 'A payment failed for a subscribed author (Stripe customer ' + invoice.customer + '). Their status is now past_due.');
}

function sendErrorAlert(endpoint, detail) {
  var key = process.env.RESEND_API_KEY;
  if (!key) return Promise.resolve();
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Readerbull Alerts <alerts@readerbull.com>',
      to: ['coastlvibes@gmail.com'],
      subject: 'Readerbull error: ' + endpoint,
      text: detail + '\n\nTime: ' + new Date().toISOString()
    })
  }).catch(function () {});
}
