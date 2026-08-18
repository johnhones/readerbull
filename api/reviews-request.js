// Vercel serverless function: request to review a book in the Reciprocal
// Reviews pool, and get matched immediately if it's allowed (Track A — see
// ReaderBull_Review_System_Scoping.md Section 8 for the anti-abuse rules
// this enforces).
//
// POST { bookId, asAmazonName }
// -> { assignment: {...} } or -> { error: "..." } with a 4xx status
//    explaining which rule blocked it.
//
// asAmazonName (17 August 2026, handover Section 4 items 6-7): Verified
// Purchase books need the reviewer's Amazon display name on file before
// they can claim one, captured here at claim time rather than later at
// mark-done — decided this is the right moment since it's naturally when
// a reader commits to reviewing this specific book. Stored once in the
// reviewer's own auth profile (user_metadata.amazon_reviewer_name); once
// it exists, later claims don't need to resend it. reviews-mark-done.js
// checks the submitted proof link against whatever's on file here.
//
// This is the one place all three MVP anti-abuse rules are enforced:
//   1. No two authors matched to review each other directly (one-directional
//      swap block).
//   2. A weekly cap per reviewer on new assignments (6/week, matching
//      BookVillage's reference point).
//   3. The target book must actually have an available slot (see the
//      arithmetic in api/reviews-browse.js's docblock — duplicated here
//      rather than shared, per this codebase's existing convention).

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';
var WEEKLY_CAP = 6;

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
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + authToken,
    'Content-Type': 'application/json'
  };

  var bookId = req.body && req.body.bookId;
  if (!bookId) {
    res.status(400).json({ error: 'Missing bookId.' });
    return;
  }

  // Look up the pool entry + owner.
  var poolResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=id,book_id,user_id,bonus_slots,active,offer_type&book_id=eq.' +
      encodeURIComponent(bookId),
    { headers: headers }
  );
  var poolRows = poolResp.ok ? await poolResp.json() : [];
  var pool = poolRows && poolRows[0];
  if (!pool || !pool.active) {
    res.status(404).json({ error: 'That book is not currently open for review requests.' });
    return;
  }
  if (pool.user_id === authUser.id) {
    res.status(400).json({ error: "You can't request to review your own book." });
    return;
  }

  // Verified Purchase needs the reviewer's Amazon name on file before they
  // can claim it — first time only, later claims reuse what's on file.
  if (pool.offer_type === 'verified_purchase') {
    var storedName = (authUser.user_metadata && authUser.user_metadata.amazon_reviewer_name) || '';
    if (!storedName) {
      var asAmazonName = (req.body && req.body.asAmazonName ? String(req.body.asAmazonName).trim() : '');
      if (!asAmazonName) {
        res.status(400).json({ error: 'This is a Verified Purchase book. Enter the name your Amazon reviews are posted under before claiming it.' });
        return;
      }
      await fetch(SUPABASE_URL + '/auth/v1/user', {
        method: 'PUT',
        headers: headers,
        body: JSON.stringify({ data: { amazon_reviewer_name: asAmazonName } })
      });
    }
  }

  // Rule 1: anti-swap. Block if the target owner already has an assignment
  // to review one of the requester's own books (would form a direct A<->B
  // swap either way round).
  var mirrorResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id&reviewer_id=eq.' +
      encodeURIComponent(pool.user_id) + '&owner_id=eq.' + encodeURIComponent(authUser.id),
    { headers: headers }
  );
  var mirrorRows = mirrorResp.ok ? await mirrorResp.json() : [];
  if (mirrorRows && mirrorRows.length) {
    res.status(400).json({
      error: "This would be a direct swap with another author, which isn't allowed. Try a different book."
    });
    return;
  }

  // Rule 2: weekly cap on new assignments for this reviewer.
  var since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  var weeklyResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id&reviewer_id=eq.' +
      encodeURIComponent(authUser.id) + '&assigned_at=gte.' + encodeURIComponent(since),
    { headers: headers }
  );
  var weeklyRows = weeklyResp.ok ? await weeklyResp.json() : [];
  if (weeklyRows && weeklyRows.length >= WEEKLY_CAP) {
    res.status(429).json({
      error: 'You\'ve reached the weekly limit of ' + WEEKLY_CAP + ' new review assignments. Check back in a few days.'
    });
    return;
  }

  // Rule 3: the target book must have an available slot.
  var usedResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id&book_id=eq.' + encodeURIComponent(bookId),
    { headers: headers }
  );
  var usedRows = usedResp.ok ? await usedResp.json() : [];
  var used = (usedRows || []).length;
  var completedResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id&reviewer_id=eq.' +
      encodeURIComponent(pool.user_id) + '&status=eq.completed',
    { headers: headers }
  );
  var completedRows = completedResp.ok ? await completedResp.json() : [];
  var availableSlots = (pool.bonus_slots || 0) + (completedRows || []).length - used;
  if (availableSlots <= 0) {
    res.status(400).json({ error: 'That book has no open review slots right now. Try another one.' });
    return;
  }

  // All clear — create the assignment. The unique(book_id, reviewer_id)
  // constraint backstops against double-requesting the same book.
  var createResp = await fetch(SUPABASE_URL + '/rest/v1/review_assignments', {
    method: 'POST',
    headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
    body: JSON.stringify({
      book_id: bookId,
      owner_id: pool.user_id,
      reviewer_id: authUser.id,
      status: 'assigned'
    })
  });
  if (!createResp.ok) {
    var errBody = await createResp.text();
    var isDupe = errBody.indexOf('duplicate') !== -1 || errBody.indexOf('unique') !== -1;
    res.status(isDupe ? 400 : 502).json({
      error: isDupe ? "You've already requested to review this book." : 'Could not create the assignment right now, please try again.'
    });
    return;
  }
  var created = await createResp.json();
  res.status(200).json({ assignment: created && created[0] });
};
