// Vercel serverless function: Book Growth Tracker (built 19 August 2026,
// see ReaderBull_Growth_Tracker_Data_Model_Plan_2026-08-19.md for the full
// reasoning, and Section 6.2 of the 19 August Master Handover / rule 18 in
// ReaderBull_Project_Rules.md for the approved design this serves).
//
// Combines the add/remove-competitor CRUD actions and the weekly cron
// snapshot job into ONE file rather than two or three, a deliberate
// choice: this project hit Vercel Hobby's real serverless-function-count
// cap once already this week (see the ARC tier system's admin-arc-proofs
// -> admin-users merge, 19 August), and even though staging's api/ folder
// has headroom right now, keeping new Growth Tracker work to a single new
// route is the safer default rather than assuming that headroom stays
// true.
//
// Routes (all via this one file, action decides behaviour):
//   POST /api/growth-tracker?action=add             { bookId, input }              -> add a tracked competitor
//   POST /api/growth-tracker?action=remove           { trackedCompetitorId }        -> soft-remove one
//   POST /api/growth-tracker?action=auto-populate    { bookId, competitors, ownReviews, ownRank }   -> seed at least 2 real, reachable competitors on first audit
//   GET  /api/growth-tracker?action=snapshot                                        -> weekly cron job (CRON_SECRET only, see vercel.json)
//
// auto-populate (added 20 August 2026, per John: new/inexperienced authors
// won't know what "+ Add book" is for or why it matters, so the Growth
// Tracker should show real value immediately rather than starting empty).
// Called by dashboard.html/onboarding.html right after a normal audit
// returns its competitors array (api/enrich-audit.js's findCompetitors +
// attachCompetitorBsr), reusing that already-fetched, already-paid-for
// data, zero new SerpApi calls, same "no new vendor, no new cost"
// direction as the rest of this file. Deliberately a no-op the instant the
// book has ANY active tracked competitor already, whether from a previous
// auto-populate or the author's own manual "+ Add book", this must never
// overwrite an author's own choices, only fill a genuinely empty tracker.
//
// **Seeds at least 2 competitors, not just the plan's manual-tracking
// limit** (revised 20 August 2026, per John: showing a single competitor
// didn't make the case for the feature, an author needs a believable
// "here's a realistic next target, and here's one further out" pair to see
// the point). This deliberately can seed a Free account (manual limit 1)
// past its own advertised limit; that's intentional here, the manual
// "+ Add book" limit in handleAdd is untouched, an already-at-limit
// account just can't add a 3rd manually, same graceful "downgrade leaves
// an account over its limit" handling rule 18 already calls for.
//
// **Ordered for reachability, not just data completeness.** Candidates
// with a real bestsellerRank (attachCompetitorBsr's enrichment) sort
// first, since only those can carry a real, honest gap number. Among
// those, the ones closest to the author's own current category rank
// (ownRank, passed in by the caller, the same rank this exact audit just
// pulled, not a stale books-row value) sort first too, so the first
// competitor shown is a genuinely reachable next milestone, not the
// niche's single biggest outlier. dashboard.html's gtReachStrategyHtml
// renders the actual "how you get there" copy from these same real
// numbers, never invented.
//
// add/remove require the caller's own Supabase session (Bearer token,
// same pattern as api/import-book.js). snapshot is never called by an
// author, only by Vercel Cron, and checks CRON_SECRET instead, per
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
//
// Reuses api/enrich-audit.js's exact BSR-to-revenue estimator
// (parsePrice/estimateMonthlyRevenue) and api/import-book.js's exact
// ASIN/URL resolver (resolveAsin/extractAsin), per rule 18's "reuse that
// logic rather than writing a second BSR-to-revenue estimator." Neither
// file is duplicated here.

var enrichAudit = require('./enrich-audit');
var parsePrice = enrichAudit.parsePrice;
var estimateMonthlyRevenue = enrichAudit.estimateMonthlyRevenue;
var importBook = require('./import-book');
var resolveAsin = importBook.resolveAsin;

var SUPABASE_URL = process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co';
// Same publishable (anon) key already shipped to the browser in
// supabase-client.js and already reused server-side in api/_auth.js,
// safe here too, it identifies the project, it does not grant access by
// itself.
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

// Tracking limit by plan (19 August 2026). Free 1 and Plus 2 are the
// exact numbers agreed in rule 18. Pro's exact number was left open there
// ("more, in line with the existing 4-to-10-book Pro portfolio range"),
// not pinned to a specific digit. Defaulted here to 4, the low end of
// that stated range, flagged to John as an assumption rather than
// silently guessed, this is the one constant to change if he wants a
// different number, nothing else in this file depends on the exact
// value.
var COMPETITOR_LIMIT_BY_PLAN = { free: 1, plus: 2, pro: 4 };

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  try {
    if (action === 'snapshot') {
      return await handleSnapshotJob(req, res);
    }
    if (action === 'add' && req.method === 'POST') {
      return await handleAdd(req, res);
    }
    if (action === 'remove' && req.method === 'POST') {
      return await handleRemove(req, res);
    }
    if (action === 'auto-populate' && req.method === 'POST') {
      return await handleAutoPopulate(req, res);
    }
    res.status(400).json({ error: 'Unknown action, or wrong HTTP method for that action.' });
  } catch (err) {
    await sendErrorAlert('growth-tracker', 'Unexpected error (action=' + action + '): ' + (err && err.message ? err.message : String(err)));
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
};

// ---------- Auth (same pattern as api/import-book.js) ----------
async function authenticate(req) {
  var authToken = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!authToken) return null;
  var authCheck = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + authToken }
  });
  if (!authCheck.ok) return null;
  var authUser = await authCheck.json();
  return { userId: authUser.id };
}

// Authoritative plan lookup, service_role key, never trusts a
// client-supplied plan. Same fail-safe-to-free convention as
// dashboard.html's own userPlan computation (Section 3.3 of the
// handover): a missing row, inactive status, or a Supabase hiccup all
// resolve to 'free' rather than accidentally unlocking a higher limit.
async function getPlan(userId, serviceKey) {
  var resp = await fetch(
    SUPABASE_URL + '/rest/v1/subscriptions?select=plan,status&user_id=eq.' + encodeURIComponent(userId),
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  if (!resp.ok) return 'free';
  var rows = await resp.json();
  var row = Array.isArray(rows) ? rows[0] : null;
  if (row && row.status === 'active' && row.plan && COMPETITOR_LIMIT_BY_PLAN.hasOwnProperty(row.plan)) {
    return row.plan;
  }
  return 'free';
}

// ---------- action=add ----------
async function handleAdd(req, res) {
  var auth = await authenticate(req);
  if (!auth) { res.status(401).json({ error: 'Please sign in again, your session could not be found.' }); return; }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ error: 'Growth Tracker is not configured yet, SUPABASE_SERVICE_ROLE_KEY is missing.' }); return; }

  var bookId = req.body && req.body.bookId;
  var input = String((req.body && req.body.input) || '').trim();
  if (!bookId || !input) { res.status(400).json({ error: 'Missing book or the book you want to track.' }); return; }

  // Confirm the caller actually owns this book, service_role so this
  // can't be spoofed by a book_id belonging to someone else's account.
  var bookResp = await fetch(
    SUPABASE_URL + '/rest/v1/books?select=id,user_id&id=eq.' + encodeURIComponent(bookId) + '&user_id=eq.' + encodeURIComponent(auth.userId),
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  var bookRows = bookResp.ok ? await bookResp.json() : [];
  if (!Array.isArray(bookRows) || !bookRows.length) { res.status(404).json({ error: 'Book not found.' }); return; }

  var plan = await getPlan(auth.userId, serviceKey);
  var limit = COMPETITOR_LIMIT_BY_PLAN[plan] || COMPETITOR_LIMIT_BY_PLAN.free;

  var countResp = await fetch(
    SUPABASE_URL + '/rest/v1/tracked_competitors?select=id&book_id=eq.' + encodeURIComponent(bookId) + '&removed_at=is.null',
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, Prefer: 'count=exact' } }
  );
  var currentRows = countResp.ok ? await countResp.json() : [];
  var currentCount = Array.isArray(currentRows) ? currentRows.length : 0;

  if (currentCount >= limit) {
    res.status(403).json({
      error: 'limit_reached',
      plan: plan,
      limit: limit,
      message: plan === 'free'
        ? "You've reached the Free limit to track books."
        : "You've reached the " + (plan.charAt(0).toUpperCase() + plan.slice(1)) + " limit to track books."
    });
    return;
  }

  var resolved = await resolveCompetitor(input);
  if (!resolved) {
    res.status(400).json({ error: 'Could not find that book on Amazon. Paste a listing link, ASIN, or try a more specific title.' });
    return;
  }

  // Same book already tracked (active) on this book_id, don't add a
  // second row, the DB's own partial unique index would reject this too,
  // but check here first so the error message is friendly rather than a
  // raw constraint-violation response.
  if (resolved.asin) {
    var dupeResp = await fetch(
      SUPABASE_URL + '/rest/v1/tracked_competitors?select=id&book_id=eq.' + encodeURIComponent(bookId) +
        '&asin=eq.' + encodeURIComponent(resolved.asin) + '&removed_at=is.null',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    var dupeRows = dupeResp.ok ? await dupeResp.json() : [];
    if (Array.isArray(dupeRows) && dupeRows.length) {
      res.status(409).json({ error: 'That book is already on this tracker.' });
      return;
    }
  }

  var inserted = await insertOneTrackedCompetitor(bookId, auth.userId, resolved, serviceKey);
  if (!inserted) {
    res.status(500).json({ error: 'Could not save that competitor, please try again.' });
    return;
  }

  res.status(200).json({ trackedCompetitor: inserted });
}

// Shared by handleAdd (one author-chosen competitor) and
// handleAutoPopulate (up to the plan limit, seeded from an audit's
// already-fetched competitor data). `resolved` must carry at minimum
// title + asin; reviewCount/bestsellerRank/estimatedRevenue are optional
// and, if present, feed the same-week initial snapshot so the bar panels
// and trend chart have a real data point immediately rather than an empty
// chart until next Monday's cron. Returns the inserted tracked_competitors
// row, or null on failure (caller decides how to report that).
async function insertOneTrackedCompetitor(bookId, userId, resolved, serviceKey) {
  var insertResp = await fetch(SUPABASE_URL + '/rest/v1/tracked_competitors', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      book_id: bookId,
      user_id: userId,
      title: resolved.title,
      amazon_url: resolved.amazonUrl || null,
      asin: resolved.asin || null
    })
  });

  if (!insertResp.ok) {
    var insertErrText = await insertResp.text();
    await sendErrorAlert('growth-tracker (insert)', 'Insert into tracked_competitors failed: ' + insertErrText);
    return null;
  }

  var inserted = (await insertResp.json())[0];

  // Best-effort initial snapshot, never blocks the insert itself if it fails.
  try {
    await upsertSnapshot({
      bookId: bookId,
      userId: userId,
      snapshotType: 'competitor',
      trackedCompetitorId: inserted.id,
      subjectKey: inserted.id,
      reviews: resolved.reviewCount,
      categoryRank: resolved.bestsellerRank,
      estimatedRevenue: resolved.estimatedRevenue,
      serviceKey: serviceKey
    });
  } catch (err) {
    // best-effort, see comment above
  }

  return inserted;
}

// ---------- action=auto-populate ----------
async function handleAutoPopulate(req, res) {
  var auth = await authenticate(req);
  if (!auth) { res.status(401).json({ error: 'Please sign in again, your session could not be found.' }); return; }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Best-effort feature: never surface a hard error back into the audit
  // flow that called this, a missing key just means no auto-populate.
  if (!serviceKey) { res.status(200).json({ ok: true, added: 0, skipped: 'not_configured' }); return; }

  var bookId = req.body && req.body.bookId;
  var candidates = Array.isArray(req.body && req.body.competitors) ? req.body.competitors : [];
  // The category rank THIS audit just pulled for the author's own book,
  // passed by the caller rather than re-read from the books row, which at
  // this exact point in the audit flow (see dashboard.html/onboarding.html)
  // may still hold the pre-refresh value, or not exist yet at all for a
  // book being onboarded for the first time. Only used to order candidates
  // by reachability below, dashboard.html's own gtReachStrategyHtml reads
  // the author's live numbers straight from Supabase for display, this
  // endpoint doesn't need to return anything back for that.
  var ownRank = (typeof (req.body && req.body.ownRank) === 'number') ? req.body.ownRank : null;
  if (!bookId || !candidates.length) { res.status(200).json({ ok: true, added: 0 }); return; }

  var bookResp = await fetch(
    SUPABASE_URL + '/rest/v1/books?select=id,user_id&id=eq.' + encodeURIComponent(bookId) + '&user_id=eq.' + encodeURIComponent(auth.userId),
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  var bookRows = bookResp.ok ? await bookResp.json() : [];
  if (!Array.isArray(bookRows) || !bookRows.length) { res.status(200).json({ ok: true, added: 0 }); return; }

  // Never overwrite an author's own choices: only seed when this book
  // genuinely has zero active tracked competitors yet, whether that's
  // because it's brand new or because a previous auto-populate already ran.
  var countResp = await fetch(
    SUPABASE_URL + '/rest/v1/tracked_competitors?select=id&book_id=eq.' + encodeURIComponent(bookId) + '&removed_at=is.null',
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  var currentRows = countResp.ok ? await countResp.json() : [];
  if (Array.isArray(currentRows) && currentRows.length) { res.status(200).json({ ok: true, added: 0, skipped: 'already_tracked' }); return; }

  var plan = await getPlan(auth.userId, serviceKey);
  var limit = COMPETITOR_LIMIT_BY_PLAN[plan] || COMPETITOR_LIMIT_BY_PLAN.free;

  // Real competitors only, per rule 3/12's "never invent data": must carry
  // a real title AND a real ASIN, exactly what findCompetitors already
  // verified during this same audit. Competitors attachCompetitorBsr
  // enriched with a real bestsellerRank (its top-2-per-audit cap) sort
  // first, since only those can carry a real, honest gap number. Among
  // those, closest-to-own-rank sorts first (see the comment above this
  // function), a believable, reachable first target rather than whichever
  // happened to come back first from findCompetitors.
  var real = candidates.filter(function (c) { return c && c.asin && c.title; });
  real.sort(function (a, b) {
    var aHas = (typeof a.bestsellerRank === 'number') ? 0 : 1;
    var bHas = (typeof b.bestsellerRank === 'number') ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    if (ownRank != null && typeof a.bestsellerRank === 'number' && typeof b.bestsellerRank === 'number') {
      // A "realistic reach" target has to actually be ahead of the author
      // (a lower/better category rank) to make sense as something to
      // reach for, so genuinely-ahead candidates sort before ones that
      // aren't, closest-gap-first within each group.
      var aAhead = (a.bestsellerRank < ownRank) ? 0 : 1;
      var bAhead = (b.bestsellerRank < ownRank) ? 0 : 1;
      if (aAhead !== bAhead) return aAhead - bAhead;
      return Math.abs(ownRank - a.bestsellerRank) - Math.abs(ownRank - b.bestsellerRank);
    }
    return 0;
  });
  // At least 2 where real data allows it, even past the plan's own manual
  // "+ Add book" limit, see the comment above this function for why.
  var seedCount = Math.max(2, limit);
  var chosen = real.slice(0, seedCount);

  var addedCount = 0;
  for (var i = 0; i < chosen.length; i++) {
    var c = chosen[i];
    var price = parsePrice(c.price);
    var estimatedRevenue = (typeof c.storeWideRank === 'number') ? estimateMonthlyRevenue(c.storeWideRank, price) : null;
    var resolved = {
      title: c.title,
      asin: c.asin,
      // findCompetitors never gives a listing URL, only an ASIN, this is
      // Amazon's own canonical /dp/ URL format for that real ASIN, not an
      // invented link.
      amazonUrl: 'https://www.amazon.com/dp/' + c.asin,
      reviewCount: (typeof c.reviews === 'number') ? c.reviews : null,
      bestsellerRank: (typeof c.bestsellerRank === 'number') ? c.bestsellerRank : null,
      estimatedRevenue: (estimatedRevenue != null) ? Math.round(estimatedRevenue) : null
    };
    var inserted = await insertOneTrackedCompetitor(bookId, auth.userId, resolved, serviceKey);
    if (inserted) addedCount++;
  }

  res.status(200).json({ ok: true, added: addedCount });
}

// ---------- action=remove ----------
async function handleRemove(req, res) {
  var auth = await authenticate(req);
  if (!auth) { res.status(401).json({ error: 'Please sign in again, your session could not be found.' }); return; }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { res.status(500).json({ error: 'Growth Tracker is not configured yet, SUPABASE_SERVICE_ROLE_KEY is missing.' }); return; }

  var trackedCompetitorId = req.body && req.body.trackedCompetitorId;
  if (!trackedCompetitorId) { res.status(400).json({ error: 'Missing trackedCompetitorId.' }); return; }

  // Ownership check + soft delete in one PATCH, scoped by user_id so an
  // author can never remove someone else's row by guessing an id.
  var patchResp = await fetch(
    SUPABASE_URL + '/rest/v1/tracked_competitors?id=eq.' + encodeURIComponent(trackedCompetitorId) + '&user_id=eq.' + encodeURIComponent(auth.userId),
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify({ removed_at: new Date().toISOString() })
    }
  );

  if (!patchResp.ok) {
    res.status(500).json({ error: 'Could not remove that competitor, please try again.' });
    return;
  }
  var patched = await patchResp.json();
  if (!Array.isArray(patched) || !patched.length) {
    res.status(404).json({ error: 'Tracked competitor not found.' });
    return;
  }

  res.status(200).json({ ok: true });
}

// ---------- action=snapshot (Vercel Cron only) ----------
async function handleSnapshotJob(req, res) {
  var cronSecret = process.env.CRON_SECRET;
  var authHeader = (req.headers && req.headers.authorization) || '';
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var serpApiKey = process.env.SERPAPI_KEY;
  if (!serviceKey || !serpApiKey) {
    await sendErrorAlert('growth-tracker (snapshot)', 'Missing SUPABASE_SERVICE_ROLE_KEY or SERPAPI_KEY, snapshot job cannot run.');
    res.status(500).json({ error: 'Snapshot job is not configured yet.' });
    return;
  }

  var weekStart = mostRecentMondayIso(new Date());
  var results = { weekStart: weekStart, ownSnapshots: 0, competitorSnapshots: 0, competitorFailures: 0 };

  // ---- Every active tracked competitor: fresh weekly refresh ----
  var trackedResp = await fetch(
    SUPABASE_URL + '/rest/v1/tracked_competitors?select=id,book_id,user_id,asin,title&removed_at=is.null',
    { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
  );
  var tracked = trackedResp.ok ? await trackedResp.json() : [];
  if (!Array.isArray(tracked)) tracked = [];

  var bookIdsWithTracking = {};

  for (var i = 0; i < tracked.length; i++) {
    var tc = tracked[i];
    bookIdsWithTracking[tc.book_id] = true;
    if (!tc.asin) continue;
    try {
      var product = await fetchAmazonProduct(tc.asin, serpApiKey);
      if (!product) { results.competitorFailures++; continue; }
      await upsertSnapshot({
        bookId: tc.book_id,
        userId: tc.user_id,
        snapshotType: 'competitor',
        trackedCompetitorId: tc.id,
        subjectKey: tc.id,
        reviews: product.reviewCount,
        categoryRank: product.bestsellerRank,
        estimatedRevenue: product.estimatedRevenue,
        weekStart: weekStart,
        serviceKey: serviceKey
      });
      results.competitorSnapshots++;
    } catch (err) {
      results.competitorFailures++;
      // best-effort per competitor, one failure should never stop the
      // rest of the job, same "graceful, no invented data" convention
      // used everywhere else in this codebase
      continue;
    }
  }

  // ---- The author's own book, for every book that has at least one
  // active tracked competitor. No extra external call: reads the values
  // already computed and stored on the books row by the last audit
  // (api/enrich-audit.js's estimateNicheStats), per the plan doc's
  // resolved "does the weekly job also snapshot your own book" question.
  var bookIds = Object.keys(bookIdsWithTracking);
  for (var j = 0; j < bookIds.length; j++) {
    var bId = bookIds[j];
    try {
      var ownResp = await fetch(
        SUPABASE_URL + '/rest/v1/books?select=id,user_id,live_review_count,audit_narrative_json&id=eq.' + encodeURIComponent(bId),
        { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
      );
      var ownRows = ownResp.ok ? await ownResp.json() : [];
      var ownBook = Array.isArray(ownRows) ? ownRows[0] : null;
      if (!ownBook) continue;

      var nicheStats = (ownBook.audit_narrative_json && ownBook.audit_narrative_json.nicheStats) || {};
      var ownRank = (nicheStats.bestSellerRank && typeof nicheStats.bestSellerRank.yours === 'number') ? nicheStats.bestSellerRank.yours : null;
      var ownRevenue = (typeof nicheStats.yourEstimatedRevenue === 'number') ? nicheStats.yourEstimatedRevenue : null;

      await upsertSnapshot({
        bookId: bId,
        userId: ownBook.user_id,
        snapshotType: 'own',
        trackedCompetitorId: null,
        subjectKey: 'own:' + bId,
        reviews: (typeof ownBook.live_review_count === 'number') ? ownBook.live_review_count : null,
        categoryRank: ownRank,
        estimatedRevenue: ownRevenue,
        weekStart: weekStart,
        serviceKey: serviceKey
      });
      results.ownSnapshots++;
    } catch (err) {
      continue;
    }
  }

  res.status(200).json(results);
}

// ---------- Shared helpers ----------

// Monday of the current ISO week, UTC, as 'YYYY-MM-DD'. Truncated so
// every snapshot taken during the same cron run (and any Hobby-plan
// timing slop, see the migration file's comment) lands on the same
// week_start.
function mostRecentMondayIso(now) {
  var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  var day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  var diffToMonday = (day === 0) ? 6 : (day - 1);
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

async function upsertSnapshot(args) {
  var weekStart = args.weekStart || mostRecentMondayIso(new Date());
  var resp = await fetch(SUPABASE_URL + '/rest/v1/growth_tracker_snapshots?on_conflict=subject_key,week_start', {
    method: 'POST',
    headers: {
      apikey: args.serviceKey,
      Authorization: 'Bearer ' + args.serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      book_id: args.bookId,
      user_id: args.userId,
      snapshot_type: args.snapshotType,
      tracked_competitor_id: args.trackedCompetitorId,
      subject_key: args.subjectKey,
      week_start: weekStart,
      reviews: (typeof args.reviews === 'number') ? args.reviews : null,
      category_rank: (typeof args.categoryRank === 'number') ? args.categoryRank : null,
      estimated_revenue: (typeof args.estimatedRevenue === 'number') ? Math.round(args.estimatedRevenue) : null
    })
  });
  if (!resp.ok) {
    var text = await resp.text();
    throw new Error('Snapshot upsert failed: ' + text);
  }
}

// Resolves free-text "+ Add book" input (an Amazon link/ASIN, or a plain
// title search) into real product data. Reuses api/import-book.js's own
// ASIN/URL resolver, and the exact same amazon_product SerpApi lookup
// that file already makes for the author's own book, per rule 18's "no
// new vendor, no new cost, reuse what already exists" direction. Title
// search (no ASIN/URL detected) takes the first real result from
// SerpApi's Amazon Search engine, same engine and mapping
// api/enrich-audit.js's trySerpApiCompetitorCandidates already uses for
// auto-detected competitors, this is the same source, just author-chosen
// instead of automatic.
async function resolveCompetitor(input) {
  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;

  var asin = await resolveAsin(input);

  if (!asin) {
    var searchUrl = 'https://serpapi.com/search.json?engine=amazon&k=' +
      encodeURIComponent(input) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);
    try {
      var searchResp = await fetch(searchUrl);
      var searchData = await searchResp.json();
      var results = (searchResp.ok && Array.isArray(searchData.organic_results)) ? searchData.organic_results : [];
      var firstReal = results.filter(function (r) { return r && r.asin && r.title; })[0];
      if (!firstReal) return null;
      asin = firstReal.asin;
    } catch (err) {
      return null;
    }
  }

  var product = await fetchAmazonProduct(asin, apiKey);
  if (!product || !product.title) return null;
  return product;
}

// Same amazon_product SerpApi call and field extraction as
// api/import-book.js and api/enrich-audit.js's attachCompetitorBsr,
// bestsellerRank (category-specific, "your book sits at 195 in its
// category") and storeWideRank (Amazon's broadest "#N in Books" entry,
// ranks[0], the one estimateMonthlyRevenue actually uses) are
// deliberately kept as two separate fields here, never conflated, same
// distinction those two files already document at length.
async function fetchAmazonProduct(asin, apiKey) {
  var url = 'https://serpapi.com/search.json?engine=amazon_product&asin=' +
    encodeURIComponent(asin) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);
  var response = await fetch(url);
  var data = await response.json();
  if (!response.ok || (data.search_metadata && data.search_metadata.status === 'Error')) return null;

  var product = data.product_results || {};
  var ranks = (data.product_details && data.product_details.best_sellers_rank) || [];

  var bestRank = null;
  ranks.forEach(function (r) {
    if (typeof r.extracted_rank === 'number' && (!bestRank || r.extracted_rank < bestRank)) bestRank = r.extracted_rank;
  });
  var storeWideRank = (ranks[0] && typeof ranks[0].extracted_rank === 'number') ? ranks[0].extracted_rank : null;
  var price = parsePrice(product.price);
  var estimatedRevenue = estimateMonthlyRevenue(storeWideRank, price);

  return {
    asin: asin,
    title: product.title || null,
    amazonUrl: (data.search_metadata && data.search_metadata.amazon_product_url) || null,
    reviewCount: (typeof product.reviews === 'number') ? product.reviews : null,
    rating: (typeof product.rating === 'number') ? product.rating : null,
    bestsellerRank: bestRank,
    storeWideRank: storeWideRank,
    price: price,
    estimatedRevenue: (estimatedRevenue != null) ? Math.round(estimatedRevenue) : null
  };
}

function sendErrorAlert(endpoint, detail) {
  var key = process.env.RESEND_API_KEY;
  if (!key) return Promise.resolve();
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Readerbull Alerts <alerts@readerbull.com>',
      to: ['coastlvibes@gmail.com'],
      subject: 'Readerbull error: ' + endpoint,
      text: detail + '\n\nTime: ' + new Date().toISOString()
    })
  }).catch(function () {});
}
