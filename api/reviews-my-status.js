// Vercel serverless function: everything the ARC Readers dashboard needs to
// render for the signed-in author — their own books' pool status and slot
// counts, what they've been assigned to review, and how many of their own
// books are currently being reviewed by someone else.
//
// GET -> {
//   myBooks: [ { bookId, title, manuscriptUploaded, inPool, availableSlots, poolCreatedAt } ],
//   toReview: [ { assignmentId, bookId, title, coverImageUrl, status, assignedAt, completedAt } ],
//   beingReviewed: [ { bookId, title, activeCount, completedCount } ],
//   beingReviewedEvents: [ { bookId, title, status, assignedAt, completedAt } ]
// }
//
// poolCreatedAt / assignedAt / completedAt / beingReviewedEvents added for
// the ARC Readers dashboard rebuild's Recent Activity feed (15 August
// 2026, ReaderBull_ARC_Readers_Rebuild_Engineering_Spec_2026-08-14_v3.md
// Section 2.1) — purely additive, existing fields unchanged.
//
// Reviewer/owner identity is deliberately not surfaced to the other party
// anywhere in this response — see the anonymity note in
// ReaderBull_Review_System_Scoping.md Section 8/9. beingReviewedEvents
// carries status/timestamps only, same as the existing beingReviewed
// counts, never who.

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

  // How many reviews has this author completed for others — feeds the
  // slot arithmetic for every one of their own books below.
  var completedResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id&reviewer_id=eq.' +
      encodeURIComponent(authUser.id) + '&status=eq.completed',
    { headers: headers }
  );
  var completedRows = completedResp.ok ? await completedResp.json() : [];
  var completedCount = (completedRows || []).length;

  // This author's own books, plus whatever pool entry exists for each.
  // amazon_link added 18 August 2026 so the "Add a book" picker knows
  // whether Kindle Unlimited / Verified Purchase are even valid choices
  // for a given book (those need an existing Amazon listing).
  var booksResp = await fetch(
    SUPABASE_URL + '/rest/v1/books?select=id,book_title,manuscript_url,amazon_link&user_id=eq.' + encodeURIComponent(authUser.id),
    { headers: headers }
  );
  var books = booksResp.ok ? await booksResp.json() : [];

  var poolResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=id,book_id,active,bonus_slots,created_at&user_id=eq.' + encodeURIComponent(authUser.id),
    { headers: headers }
  );
  var poolRows = poolResp.ok ? await poolResp.json() : [];
  var poolByBook = {};
  (poolRows || []).forEach(function (p) { poolByBook[p.book_id] = p; });

  var myBooks = [];
  for (var i = 0; i < (books || []).length; i++) {
    var b = books[i];
    var pool = poolByBook[b.id];
    var availableSlots = null;
    if (pool && pool.active) {
      var usedResp = await fetch(
        SUPABASE_URL + '/rest/v1/review_assignments?select=id&book_id=eq.' + encodeURIComponent(b.id),
        { headers: headers }
      );
      var usedRows = usedResp.ok ? await usedResp.json() : [];
      availableSlots = (pool.bonus_slots || 0) + completedCount - (usedRows || []).length;
    }
    myBooks.push({
      bookId: b.id,
      title: b.book_title || 'Untitled book',
      manuscriptUploaded: !!b.manuscript_url,
      hasAmazonListing: !!b.amazon_link,
      inPool: !!(pool && pool.active),
      availableSlots: availableSlots,
      poolCreatedAt: pool ? pool.created_at : null
    });
  }

  // Books this author has been assigned to review.
  var toReviewResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id,book_id,owner_id,status,assigned_at,completed_at,review_proof_url,proof_status,books(book_title,cover_image_url)&reviewer_id=eq.' +
      encodeURIComponent(authUser.id) + '&order=assigned_at.desc',
    { headers: headers }
  );
  var toReviewRows = toReviewResp.ok ? await toReviewResp.json() : [];

  // offerType per assignment — needed so the dashboard knows whether to ask
  // for proof-of-purchase before letting "mark as done" go through (that's
  // Verified Purchase only, see the 17 August 2026 handover Section 4 item
  // 7). review_pool_entries is keyed by book_id, same as the assignment.
  var offerTypeByBook = {};
  var toReviewBookIds = (toReviewRows || []).map(function (r) { return r.book_id; }).filter(Boolean);
  if (toReviewBookIds.length) {
    var tierResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_pool_entries?select=book_id,offer_type,price_cents&book_id=in.(' + toReviewBookIds.join(',') + ')',
      { headers: headers }
    );
    var tierRows = tierResp.ok ? await tierResp.json() : [];
    (tierRows || []).forEach(function (t) { offerTypeByBook[t.book_id] = t; });
  }

  var toReview = (toReviewRows || []).map(function (r) {
    var bk = r.books || {};
    var tier = offerTypeByBook[r.book_id] || {};
    return {
      assignmentId: r.id,
      bookId: r.book_id,
      ownerId: r.owner_id,
      manuscriptPath: r.owner_id + '/' + r.book_id + '.pdf',
      title: bk.book_title || 'Untitled book',
      coverImageUrl: bk.cover_image_url || null,
      status: r.status,
      assignedAt: r.assigned_at,
      completedAt: r.completed_at,
      offerType: tier.offer_type || 'manuscript',
      priceCents: (typeof tier.price_cents === 'number') ? tier.price_cents : null,
      reviewProofUrl: r.review_proof_url || null,
      proofStatus: r.proof_status || null
    };
  });

  // How many people are currently reviewing (or have completed reviewing)
  // each of this author's own books — counts only, no reviewer identity.
  // beingReviewedEvents carries the same no-identity guarantee, just at
  // per-assignment granularity (status + timestamps) so the dashboard's
  // Recent Activity feed can show "a reviewer was assigned" events.
  var beingReviewed = [];
  var beingReviewedEvents = [];
  for (var j = 0; j < myBooks.length; j++) {
    var bookId = myBooks[j].bookId;
    var assignResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?select=status,assigned_at,completed_at&book_id=eq.' + encodeURIComponent(bookId),
      { headers: headers }
    );
    var assignRows = assignResp.ok ? await assignResp.json() : [];
    if (assignRows && assignRows.length) {
      var activeCount = assignRows.filter(function (r) { return r.status === 'assigned'; }).length;
      var doneCount = assignRows.filter(function (r) { return r.status === 'completed'; }).length;
      beingReviewed.push({ bookId: bookId, title: myBooks[j].title, activeCount: activeCount, completedCount: doneCount });
      assignRows.forEach(function (row) {
        beingReviewedEvents.push({
          bookId: bookId,
          title: myBooks[j].title,
          status: row.status,
          assignedAt: row.assigned_at,
          completedAt: row.completed_at
        });
      });
    }
  }

  // Self-reported Amazon reviewer display name, stored in the user's own
  // auth metadata (no schema migration needed for this bit — see the 17
  // August 2026 handover Section 4 item 6 for why: it's a reusable,
  // honesty-based value the reader sets once and every Verified Purchase
  // proof submission is checked against, same "no Amazon API access to
  // verify" limitation the rest of this system already documents).
  var amazonReviewerName = (authUser.user_metadata && authUser.user_metadata.amazon_reviewer_name) || null;

  res.status(200).json({
    myBooks: myBooks,
    toReview: toReview,
    beingReviewed: beingReviewed,
    beingReviewedEvents: beingReviewedEvents,
    amazonReviewerName: amazonReviewerName
  });
};
