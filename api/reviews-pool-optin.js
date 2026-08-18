// Vercel serverless function: opt a book into (or out of) the Reciprocal
// Reviews pool (Track A of Get Reviews — see ReaderBull_Review_System_Scoping.md).
//
// POST { bookId, active, cleanContentOnly, offerType, priceCents }
// -> { entry: {...} } or -> { error: "..." } with a 4xx/5xx status.
//
// offerType/priceCents added 17 August 2026 for the tier system (ARC
// Readers Library Handover, Section 4 items 2-3). Requires the schema
// migration in that handover's Section 3 to be live (offer_type,
// price_cents columns + check constraints on review_pool_entries) — this
// endpoint enforces the same constraints server-side regardless of what
// the client sends, never trusting the client's price alone.
//
// Manuscript tier (default) still requires a manuscript_url — a book can
// only be opted in as Manuscript once it has one (RLS enforces this on
// insert too, but this checks first so the error message is readable
// instead of a raw Postgres/RLS denial). Kindle Unlimited and Verified
// Purchase tiers are for already-published books instead: those require
// an existing Amazon listing (books.amazon_link) rather than a manuscript,
// since the reviewer gets the book from Amazon/KU, not a PDF.
//
// Re-opting-in an already-existing entry updates active/cleanContentOnly
// (and offerType/priceCents only if explicitly sent) rather than erroring,
// so the dashboard toggle can call this endpoint either way without
// needing to know if a row already exists, and the plain "Activate"
// button (which never sends a tier) doesn't accidentally reset one.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

var VALID_OFFER_TYPES = ['manuscript', 'kindle_unlimited', 'verified_purchase'];
var MAX_PRICE_CENTS = 299;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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

  var bookId = req.body && req.body.bookId;
  var active = !!(req.body && req.body.active);
  var cleanContentOnly = !!(req.body && req.body.cleanContentOnly);
  var offerTypeProvided = !!(req.body && req.body.offerType);
  var offerType = offerTypeProvided ? String(req.body.offerType) : 'manuscript';
  if (!bookId) {
    res.status(400).json({ error: 'Missing bookId.' });
    return;
  }
  if (offerTypeProvided && VALID_OFFER_TYPES.indexOf(offerType) === -1) {
    res.status(400).json({ error: 'Unknown tier.' });
    return;
  }

  // Price validation — never trust the client number alone, this mirrors
  // the DB check constraint exactly so a bad client can't slip past it.
  var priceCents = null;
  if (offerType === 'verified_purchase') {
    priceCents = (req.body && req.body.priceCents != null) ? parseInt(req.body.priceCents, 10) : NaN;
    if (!priceCents || priceCents <= 0 || priceCents > MAX_PRICE_CENTS) {
      res.status(400).json({ error: 'Verified Purchase price must be between $0.01 and $' + (MAX_PRICE_CENTS / 100).toFixed(2) + '.' });
      return;
    }
  } else if (req.body && req.body.priceCents != null) {
    res.status(400).json({ error: 'Price only applies to the Verified Purchase tier.' });
    return;
  }

  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + authToken,
    'Content-Type': 'application/json'
  };

  // Confirm this book belongs to the caller before touching
  // review_pool_entries at all, and check the right prerequisite for the
  // chosen tier: a manuscript for Manuscript tier, or an existing Amazon
  // listing for Kindle Unlimited / Verified Purchase (those are already-
  // published books — the reviewer gets them from Amazon/KU, not a PDF).
  var bookResp = await fetch(
    SUPABASE_URL + '/rest/v1/books?select=id,user_id,manuscript_url,amazon_link,book_title&id=eq.' + encodeURIComponent(bookId),
    { headers: headers }
  );
  if (!bookResp.ok) {
    res.status(502).json({ error: 'Could not look up that book right now, please try again.' });
    return;
  }
  var books = await bookResp.json();
  var book = books && books[0];
  if (!book || book.user_id !== authUser.id) {
    res.status(404).json({ error: 'Book not found.' });
    return;
  }
  if (active && offerType === 'manuscript' && !book.manuscript_url) {
    res.status(400).json({
      error: 'Upload a manuscript PDF for "' + (book.book_title || 'this book') +
        '" first (from your dashboard) before adding it to Reciprocal Reviews.'
    });
    return;
  }
  if (active && offerType !== 'manuscript' && !book.amazon_link) {
    res.status(400).json({
      error: '"' + (book.book_title || 'This book') +
        '" needs a live Amazon listing before it can be offered as ' +
        (offerType === 'kindle_unlimited' ? 'Kindle Unlimited' : 'Verified Purchase') + '.'
    });
    return;
  }

  // Does a pool entry already exist for this book?
  var existingResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=id&book_id=eq.' + encodeURIComponent(bookId),
    { headers: headers }
  );
  var existing = existingResp.ok ? await existingResp.json() : [];

  var entry, saveResp;
  if (existing && existing[0]) {
    var patchBody = { active: active, clean_content_only: cleanContentOnly };
    // Only touch the tier on an existing row if the caller explicitly sent
    // one — the plain "Activate" button (reactivating a paused entry) never
    // does, and shouldn't silently reset an already-chosen tier to default.
    if (offerTypeProvided) {
      patchBody.offer_type = offerType;
      patchBody.price_cents = priceCents;
    }
    saveResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_pool_entries?id=eq.' + encodeURIComponent(existing[0].id),
      {
        method: 'PATCH',
        headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
        body: JSON.stringify(patchBody)
      }
    );
  } else {
    saveResp = await fetch(SUPABASE_URL + '/rest/v1/review_pool_entries', {
      method: 'POST',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        book_id: bookId,
        user_id: authUser.id,
        active: active,
        clean_content_only: cleanContentOnly,
        offer_type: offerType,
        price_cents: priceCents
      })
    });
  }

  if (!saveResp.ok) {
    var errBody = await saveResp.text();
    res.status(502).json({ error: 'Could not save your pool settings right now, please try again.', detail: errBody });
    return;
  }
  var saved = await saveResp.json();
  entry = saved && saved[0];

  res.status(200).json({ entry: entry });
};
