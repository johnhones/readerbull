// Vercel serverless function: list books currently available to review in
// the Reciprocal Reviews pool (Track A — see ReaderBull_Review_System_Scoping.md).
//
// GET -> { books: [ { poolEntryId, bookId, title, coverImageUrl, category,
//                      cleanContentOnly, availableSlots } ] }
//
// "availableSlots" for a book = bonus_slots (one-time starter credit) +
// completed reviews the book's OWNER has given to other authors - how many
// assignments already exist against this book. That's the whole reciprocal
// mechanic: no ledger, just arithmetic over existing rows each time this is
// called. Books already assigned to the caller, or owned by the caller, are
// excluded. Anti-swap and the weekly cap are enforced at request time
// (api/reviews-request.js), not here — this endpoint is read-only.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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

  var headers = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + authToken };

  // Active pool entries with the book's basic fields embedded (the "Anyone
  // can read books actively in the review pool" policy from the migration
  // makes the embed work even for books the caller doesn't own).
  var poolResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=id,book_id,user_id,bonus_slots,clean_content_only,offer_type,price_cents,' +
      'books(book_title,cover_image_url,amazon_category,score)&active=eq.true',
    { headers: headers }
  );
  if (!poolResp.ok) {
    res.status(502).json({ error: 'Could not load the review pool right now, please try again.' });
    return;
  }
  var poolEntries = await poolResp.json();
  poolEntries = (poolEntries || []).filter(function (e) { return e.user_id !== authUser.id; });

  // Which of these has the caller already been assigned to review, so we
  // don't show them a "request" option for a book they're already on.
  var alreadyAssignedIds = {};
  if (poolEntries.length) {
    var bookIds = poolEntries.map(function (e) { return e.book_id; }).join(',');
    var assignedResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?select=book_id&reviewer_id=eq.' +
        encodeURIComponent(authUser.id) + '&book_id=in.(' + bookIds + ')',
      { headers: headers }
    );
    if (assignedResp.ok) {
      var assignedRows = await assignedResp.json();
      (assignedRows || []).forEach(function (r) { alreadyAssignedIds[r.book_id] = true; });
    }
  }

  // Available slots per book, computed per the docblock above. One query
  // per pool owner's completed-review count and per book's existing
  // assignment count — fine at MVP scale, revisit if the pool grows large.
  var ownerCompletedCache = {};
  async function ownerCompletedCount(ownerId) {
    if (ownerCompletedCache[ownerId] !== undefined) return ownerCompletedCache[ownerId];
    var resp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?select=id&reviewer_id=eq.' +
        encodeURIComponent(ownerId) + '&status=eq.completed',
      { headers: headers }
    );
    var rows = resp.ok ? await resp.json() : [];
    ownerCompletedCache[ownerId] = (rows || []).length;
    return ownerCompletedCache[ownerId];
  }

  var results = [];
  for (var i = 0; i < poolEntries.length; i++) {
    var entry = poolEntries[i];
    if (alreadyAssignedIds[entry.book_id]) continue;

    var usedResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?select=id&book_id=eq.' + encodeURIComponent(entry.book_id),
      { headers: headers }
    );
    var usedRows = usedResp.ok ? await usedResp.json() : [];
    var used = (usedRows || []).length;
    var completed = await ownerCompletedCount(entry.user_id);
    var availableSlots = (entry.bonus_slots || 0) + completed - used;

    var b = entry.books || {};
    results.push({
      poolEntryId: entry.id,
      bookId: entry.book_id,
      title: b.book_title || 'Untitled book',
      coverImageUrl: b.cover_image_url || null,
      category: b.amazon_category || null,
      cleanContentOnly: !!entry.clean_content_only,
      availableSlots: availableSlots,
      discoverabilityScore: (typeof b.score === 'number') ? b.score : null,
      // offerType/priceCents added 17 August 2026 for the tier system —
      // defaults to 'manuscript'/null for any pre-migration row (the
      // column's own DB default), so older entries render correctly too.
      offerType: entry.offer_type || 'manuscript',
      priceCents: (typeof entry.price_cents === 'number') ? entry.price_cents : null
    });
  }

  // "Smart Match" v1 (17 August 2026, direct user instruction): surface
  // books that most need review momentum first, using the Discoverability
  // Score already computed for every imported book. Lower score = needs
  // more help = shown first. Books with no score yet (never audited) sort
  // last, since we have no evidence they need priority. This is a book-need
  // ranking only — it is NOT personalized to the reviewer's own genre
  // interests, because ReaderBull doesn't have a reviewer-preferences field
  // to do that with yet; that'd be a natural follow-up, not built here.
  results.sort(function (a, b) {
    var sa = a.discoverabilityScore === null ? Infinity : a.discoverabilityScore;
    var sb = b.discoverabilityScore === null ? Infinity : b.discoverabilityScore;
    return sa - sb;
  });

  res.status(200).json({ books: results });
};
