// Vercel serverless function: ARC Readers / Reciprocal Reviews (Get Reviews
// tab). Consolidated into ONE file (21 August 2026, during the main/staging
// merge) from five separate files — reviews-browse.js, reviews-mark-done.js,
// reviews-my-status.js, reviews-pool-optin.js, reviews-request.js — purely
// to stay under Vercel Hobby's 12-serverless-function cap once Growth
// Tracker (staging) and this ARC Readers system (main) landed in the same
// api/ folder for the first time. Nothing about the logic below changed
// from the original files, only: the routing wrapper, and the two
// duplicate SUPABASE_URL/SUPABASE_ANON_KEY constants each original file
// declared separately are now declared once. Same "add new behaviour as
// ?action= routes inside an existing file" pattern api/growth-tracker.js
// already established.
//
// Routes (all via this one file, action decides behaviour):
//   GET  /api/reviews?action=browse                                  -> list books available to review (was reviews-browse.js)
//   GET  /api/reviews?action=my-status                                -> this author's pool/assignment status (was reviews-my-status.js)
//   POST /api/reviews?action=pool-optin   { bookId, active, ... }     -> opt a book into/out of the pool (was reviews-pool-optin.js)
//   POST /api/reviews?action=request      { bookId, asAmazonName }    -> request/claim a book to review (was reviews-request.js)
//   POST /api/reviews?action=mark-done    { assignmentId, proofUrl }  -> mark an assignment completed (was reviews-mark-done.js)
//
// See ReaderBull_Review_System_Scoping.md and the
// ReaderBull_ARC_Readers_Rebuild_Engineering_Spec_2026-08-14_v3.md for the
// design each handler below implements; each function's own header comment
// (carried over unchanged) has the specifics.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  if (action === 'browse' && req.method === 'GET') return handleBrowse(req, res);
  if (action === 'my-status' && req.method === 'GET') return handleMyStatus(req, res);
  if (action === 'pool-optin' && req.method === 'POST') return handlePoolOptin(req, res);
  if (action === 'request' && req.method === 'POST') return handleRequest(req, res);
  if (action === 'mark-done' && req.method === 'POST') return handleMarkDone(req, res);

  res.status(400).json({ error: 'Unknown action, or wrong HTTP method for that action.' });
};

// ========== browse (was reviews-browse.js) ==========
// List books currently available to review in the Reciprocal Reviews pool
// (Track A — see ReaderBull_Review_System_Scoping.md).
//
// -> { books: [ { poolEntryId, bookId, title, coverImageUrl, category,
//                  cleanContentOnly, availableSlots } ] }
//
// "availableSlots" for a book = bonus_slots (one-time starter credit) +
// completed reviews the book's OWNER has given to other authors - how many
// assignments already exist against this book. That's the whole reciprocal
// mechanic: no ledger, just arithmetic over existing rows each time this is
// called. Books already assigned to the caller, or owned by the caller, are
// excluded. Anti-swap and the weekly cap are enforced at request time
// (handleRequest below), not here — this is read-only.
async function handleBrowse(req, res) {
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
}

// ========== my-status (was reviews-my-status.js) ==========
// Everything the ARC Readers dashboard needs to render for the signed-in
// author — their own books' pool status and slot counts, what they've been
// assigned to review, and how many of their own books are currently being
// reviewed by someone else.
//
// -> {
//   myBooks: [ { bookId, title, manuscriptUploaded, inPool, availableSlots, poolCreatedAt } ],
//   toReview: [ { assignmentId, bookId, title, coverImageUrl, status, assignedAt, completedAt } ],
//   beingReviewed: [ { bookId, title, activeCount, completedCount } ],
//   beingReviewedEvents: [ { bookId, title, status, assignedAt, completedAt } ]
// }
//
// Reviewer/owner identity is deliberately not surfaced to the other party
// anywhere in this response — see the anonymity note in
// ReaderBull_Review_System_Scoping.md Section 8/9. beingReviewedEvents
// carries status/timestamps only, same as the existing beingReviewed
// counts, never who.
async function handleMyStatus(req, res) {
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
}

// ========== pool-optin (was reviews-pool-optin.js) ==========
// Opt a book into (or out of) the Reciprocal Reviews pool (Track A of Get
// Reviews — see ReaderBull_Review_System_Scoping.md).
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
var VALID_OFFER_TYPES = ['manuscript', 'kindle_unlimited', 'verified_purchase'];
var MAX_PRICE_CENTS = 299;

async function handlePoolOptin(req, res) {
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
}

// ========== request (was reviews-request.js) ==========
// Request to review a book in the Reciprocal Reviews pool, and get matched
// immediately if it's allowed (Track A — see
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
// it exists, later claims don't need to resend it. handleMarkDone checks
// the submitted proof link against whatever's on file here.
//
// This is the one place all three MVP anti-abuse rules are enforced:
//   1. No two authors matched to review each other directly (one-directional
//      swap block).
//   2. A weekly cap per reviewer on new assignments (6/week, matching
//      BookVillage's reference point).
//   3. The target book must actually have an available slot (see the
//      arithmetic in handleBrowse's docblock above — duplicated here
//      rather than shared, per this codebase's existing convention).
var WEEKLY_CAP = 6;

async function handleRequest(req, res) {
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
}

// ========== mark-done (was reviews-mark-done.js) ==========
// Reviewer marks a Reciprocal Reviews assignment as completed, after
// leaving their honest review (with the required ARC disclosure line) on
// Amazon.
//
// POST { assignmentId }
// -> { assignment: {...} } or -> { error: "..." }
//
// This is the honesty-based "mark as done" described in
// ReaderBull_Review_System_Scoping.md Section 8 — ReaderBull has no Amazon
// API access to verify the review was actually posted at indie scale, same
// as Bookblaze and BookVillage. Completing this is what credits the
// reviewer's own book(s) with an available slot (see the arithmetic in
// handleBrowse's docblock above).
//
// Verified Purchase proof-of-purchase (17 August 2026, handover Section 4
// items 6-7, refined 18 August 2026 — decided: proof required for
// Verified Purchase only, not Manuscript/Kindle Unlimited; mechanism is a
// link to the posted review. The reviewer's Amazon display name is
// captured earlier, at claim time (handleRequest above), not here, so
// this endpoint just needs the link.
//
// This does NOT gate the reviewer's own slot credit on anything getting
// checked — status flips to "completed" and the slot opens up the moment
// the link is submitted, same as every other tier (direct user
// instruction, 18 August 2026: "the books open slot should always be
// open"). proof_status is a parallel, non-blocking review trail for
// whoever checks these by hand later: 'pending_review' when first
// submitted, then 'approved' or 'flagged' via api/admin-users.js's proof
// queue. A flagged submission can be fixed and resubmitted — POST again
// with a new proofUrl on an already-completed assignment updates the link
// and resets proof_status to 'pending_review', it does not re-run the
// wait-day gate or touch status/completed_at again.

// Fixed safety turnaround: reviews can't be marked done until this many
// days after the assignment was made. Posting a wave of reviews the same
// day they're claimed is exactly the pattern Amazon's abuse detection
// watches for — this protects reviewer accounts, matching the mechanic
// BookVillage documents publicly (their window is day 5 through day 7).
// Added 17 August 2026 per direct user instruction; applies to every
// assignment regardless of how the book was offered.
var MIN_WAIT_DAYS = 5;

async function handleMarkDone(req, res) {
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

  var assignmentId = req.body && req.body.assignmentId;
  if (!assignmentId) {
    res.status(400).json({ error: 'Missing assignmentId.' });
    return;
  }

  var existingResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id,book_id,reviewer_id,status,assigned_at&id=eq.' + encodeURIComponent(assignmentId),
    { headers: headers }
  );
  var existingRows = existingResp.ok ? await existingResp.json() : [];
  var existing = existingRows && existingRows[0];
  if (!existing || existing.reviewer_id !== authUser.id) {
    res.status(404).json({ error: 'Assignment not found.' });
    return;
  }

  var proofUrl = (req.body && req.body.proofUrl ? String(req.body.proofUrl).trim() : '');

  if (existing.status === 'completed') {
    // Already done. A resubmission (fixing a flagged proof link) is the
    // only thing this can still do — no proofUrl means "just tell me the
    // current state", same as before.
    if (!proofUrl) {
      res.status(200).json({ assignment: existing });
      return;
    }
    if (!/^https:\/\/(www\.)?amazon\.[a-z.]+\//i.test(proofUrl)) {
      res.status(400).json({ error: 'That doesn\'t look like an Amazon link. Paste the link to your posted review.' });
      return;
    }
    var resubmitResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?id=eq.' + encodeURIComponent(assignmentId),
      {
        method: 'PATCH',
        headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
        body: JSON.stringify({ review_proof_url: proofUrl, proof_status: 'pending_review' })
      }
    );
    if (!resubmitResp.ok) {
      res.status(502).json({ error: 'Could not save your updated link right now, please try again.' });
      return;
    }
    var resubmitted = await resubmitResp.json();
    res.status(200).json({ assignment: resubmitted && resubmitted[0] });
    return;
  }

  var eligibleAt = new Date(existing.assigned_at).getTime() + MIN_WAIT_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() < eligibleAt) {
    var daysLeft = Math.max(1, Math.ceil((eligibleAt - Date.now()) / (24 * 60 * 60 * 1000)));
    res.status(400).json({
      error: 'Reviews can be marked done starting ' + MIN_WAIT_DAYS + ' days after you claim a book, ' +
        'this protects your Amazon reviewer account from posting too many reviews too quickly. ' +
        'Check back in about ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
    });
    return;
  }

  // Verified Purchase requires proof-of-purchase; Manuscript / Kindle
  // Unlimited do not (Section 4 item 7 decision).
  var updateBody = { status: 'completed', completed_at: new Date().toISOString() };
  var tierResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=offer_type&book_id=eq.' + encodeURIComponent(existing.book_id),
    { headers: headers }
  );
  var tierRows = tierResp.ok ? await tierResp.json() : [];
  var offerType = (tierRows && tierRows[0] && tierRows[0].offer_type) || 'manuscript';

  if (offerType === 'verified_purchase') {
    if (!proofUrl || !/^https:\/\/(www\.)?amazon\.[a-z.]+\//i.test(proofUrl)) {
      res.status(400).json({ error: 'This is a Verified Purchase review. Paste the link to your posted Amazon review before marking it done.' });
      return;
    }
    // The Amazon name itself was already captured at claim time
    // (handleRequest above) — this is just a safety net for any
    // assignment claimed before that existed.
    var storedName = (authUser.user_metadata && authUser.user_metadata.amazon_reviewer_name) || '';
    if (!storedName) {
      res.status(400).json({ error: 'We don\'t have your Amazon reviewer name on file yet. Please contact support to add it before marking this done.' });
      return;
    }
    updateBody.review_proof_url = proofUrl;
    updateBody.proof_status = 'pending_review';
  }

  var updateResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?id=eq.' + encodeURIComponent(assignmentId),
    {
      method: 'PATCH',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
      body: JSON.stringify(updateBody)
    }
  );
  if (!updateResp.ok) {
    res.status(502).json({ error: 'Could not mark this as done right now, please try again.' });
    return;
  }
  var updated = await updateResp.json();
  res.status(200).json({ assignment: updated && updated[0] });
}
