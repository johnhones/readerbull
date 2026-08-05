// Vercel serverless function: builds the "deep" audit content for the
// native dashboard, real competitor data plus a narrative write-up, so the
// automated Market Analysis / Marketing Strategy / Quick Wins panels can
// match the depth of the legacy hand-built dashboards. Also runs the R27
// "organic page rank" lookup for the Listing sub-score (scoring.js), so
// the score can be computed with real page-rank data rather than
// dropping that sub-factor.
//
// Runs once, at onboarding submit time, BEFORE computeDiscoverabilityScore
// (see onboarding.html), because Price vs Niche and the Listing page-rank
// sub-factor both need this endpoint's output as scoring inputs. The
// result is stored on the books row (competitors_json,
// audit_narrative_json), not recomputed on every dashboard view. Three
// paid calls per audit: two SerpApi Amazon calls (competitor discovery,
// page-rank check against the primary keyword only) and one Anthropic
// Messages call (narrative). Because this now runs before scoring, the
// narrative is generated without a final discoverabilityScore in its
// input, the prompt is written to handle missing fields honestly. If any
// step fails, this returns whatever it could get rather than erroring the
// whole submit, dashboard.html and scoring.js fall back gracefully when a
// field is missing.
//
// Also runs Amazon keyword research (DataForSEO Amazon Related Keywords),
// classified into a broad "Amazon Keywords" list (Use/Skip) and a curated
// "Readerbull Recommended" subset (Priority/Best Fit), matching the
// two-table pattern confirmed across the legacy hand-built dashboards
// (Jordan Truehart, Rebecca Wells, and both example dashboards). Result is
// cached inside audit_narrative_json.keywordResearch, no new DB column
// needed. The dashboard's Keywords tab lets the author add/remove
// keywords from either table, which recomputes the score client-side
// using this cached data, no repeat DataForSEO call per click.
//
// Standing rule (ReaderBull_Project_Rules.md, rule 12): keyword research
// must never come back empty. findKeywordResearch tries category, then the
// author's own keyword, then the book title against DataForSEO; if all of
// those dead-end (or there was nothing to try), it asks Claude to guess two
// natural shopper-style search phrases and retries with those before giving
// up. This adds at most one extra cheap Anthropic call, only on the rare
// book where every mechanical seed fails.
//
// POST { title, category, keywords, asin, price, rating, reviewCount,
//        bestsellerRank, storeWideRank, boughtTogether }
// -> { competitors: [...], pageRank: {...}, keywordResearch: {...}, narrative: {...} }
//
// storeWideRank (4 August 2026): Amazon's broadest/store-wide best-seller
// rank (ranks[0] from SerpApi, see the comment on it in import-book.js),
// distinct from bestsellerRank (the lowest-numbered, most category-specific
// rank, used for the "category fit" scoring sub-factor). storeWideRank
// feeds estimateNicheStats' revenue estimate below, using bestsellerRank
// for that produced a wildly wrong figure previously, see the comment on
// estimateNicheStats.
//
// Competitor accuracy fix (29 July 2026): findCompetitors now prefers
// boughtTogether (Amazon's own "frequently bought together" data for this
// exact ASIN, passed through from api/import-book.js where it was pulled
// for free on the same call already made at import time) over a fresh
// SerpApi category search. This fixes a confirmed live bug where a broad
// or formal Amazon category (e.g. a cannabis cookbook categorised under
// general cooking) returned generic, off-topic competitors. When
// boughtTogether is empty (not every listing has it), falls back to the
// same seed-fallback pattern already proven for findKeywordResearch:
// category leaf, then the author's own primary keyword, then the book
// title, then an AI-guessed shopper phrase as a last resort.
//
// Duplicate auth-check fix (3 August 2026): this handler's session
// verification block (Bearer token check, Supabase /auth/v1/user call)
// was accidentally pasted in twice in a row, the same bug already fixed
// in api/import-book.js. Harmless but wasteful, every audit was making an
// extra, unneeded network call to Supabase to check the same token twice.
// Reduced to a single check, same logic and error messages, no other
// behaviour changed.
//
// Rate limiting (3 August 2026): on top of the session check above, this
// now also caps each signed-in author at MAX_PER_HOUR calls, backed by
// the api_call_log table, see api/_auth.js. This endpoint in particular
// had no rate protection before: its fallback chains (findCompetitors,
// findKeywordResearch) mean a garbage or empty request walks every
// fallback before giving up, so one hit could trigger far more paid
// SerpApi/DataForSEO/Anthropic calls than a real, valid audit does.

var rateLimit = require('./_auth');
var MAX_PER_HOUR = 15;

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
  var authCheck = await fetch((process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co') + '/auth/v1/user', {
    headers: { apikey: 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm', Authorization: 'Bearer ' + authToken }
  });
  if (!authCheck.ok) {
    res.status(401).json({ error: 'Your session has expired, please sign in again.' });
    return;
  }
  var authUser = await authCheck.json();

  var withinLimit = await rateLimit.checkRateLimit({ userId: authUser.id, token: authToken }, 'enrich-audit', MAX_PER_HOUR);
  if (!withinLimit) {
    res.status(429).json({ error: 'Too many audit requests, please wait a bit and try again.' });
    return;
  }

  var input = req.body || {};
  var result = { competitors: [], pageRank: null, keywordResearch: null, narrative: null };

  var competitors = await findCompetitors(input);

  // Competitor bestseller rank (3 August 2026): bounded to the top 2
  // competitors only, one extra paid SerpApi call each, same
  // cost-bounded philosophy already used for findPageRank below ("one
  // extra call per book, not per item"). Powers the Overview "Best
  // Seller Rank: yours vs niche average vs top competitor" comparison.
  // Best-effort: a competitor without a resolvable BSR just doesn't
  // contribute to the average rather than blocking the rest of the audit.
  await attachCompetitorBsr(competitors);
  result.competitors = competitors;

  result.pageRank = await findPageRank(input);

  result.keywordResearch = await findKeywordResearch(input);

  var nicheStats = estimateNicheStats(input, competitors);
  var assessmentTags = buildAssessmentTags(input, result.pageRank);
  var revenueInsight = buildRevenueInsight(input, nicheStats);

  var narrative = await generateNarrative(input, competitors, result.pageRank, nicheStats);
  // nicheStats and assessmentTags are pure calculations with no LLM
  // involvement, always attach them even when the Anthropic call itself
  // fails or is unavailable (missing key, rate limited, bad JSON), so a
  // narrative-generation hiccup doesn't also take down the Book Summary
  // stat cards and Best Seller Rank comparison on the Overview tab,
  // which have nothing to do with the LLM succeeding. dashboard.html's
  // nicheAssessmentHtml already renders each piece independently and
  // skips whatever's missing, so a narrative-less result with real
  // nicheStats still shows something useful.
  result.narrative = narrative || {};
  result.narrative.nicheStats = nicheStats;
  result.narrative.assessmentTags = assessmentTags;
  result.narrative.revenueInsight = revenueInsight;

  // Always 200: this is a best-effort enrichment step, a partial or empty
  // result still lets the submit flow continue and store what it got.
  res.status(200).json(result);
};

// ---------- Organic page rank (SerpApi Amazon Search, primary keyword only) ----------
// Checks whether this book's ASIN shows up in SerpApi's amazon search
// engine results for the author's own primary backend keyword (the first
// entry in the comma-separated keywords field). One extra paid SerpApi
// call per book, not per keyword, "build it now" was chosen for this
// rebuild with that one-call-per-book scope specifically to keep the
// recurring cost bounded, see ReaderBull_Scoring_Rebuild_Handover.md.
async function findPageRank(input) {
  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;

  var keywords = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean);
  var primaryKeyword = keywords[0];
  var asin = (input.asin || '').toUpperCase();
  if (!primaryKeyword || !asin) return { keyword: primaryKeyword || null, position: null, checked: false };

  var url = 'https://serpapi.com/search.json?engine=amazon&k=' +
    encodeURIComponent(primaryKeyword) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);

  try {
    var response = await fetch(url);
    var data = await response.json();
    if (!response.ok) return { keyword: primaryKeyword, position: null, checked: true };

    var results = Array.isArray(data.organic_results) ? data.organic_results : [];
    var match = null;
    for (var i = 0; i < results.length; i++) {
      if (results[i].asin && results[i].asin.toUpperCase() === asin) { match = results[i]; break; }
    }

    return {
      keyword: primaryKeyword,
      position: match ? (match.position || (results.indexOf(match) + 1)) : null,
      resultsChecked: results.length,
      checked: true
    };
  } catch (err) {
    return { keyword: primaryKeyword, position: null, checked: false };
  }
}

// ---------- Competitor discovery ----------
// Preferred source: Amazon's own "bought together" data for this exact
// ASIN (see boughtTogether comment near the top of this file), zero extra
// paid calls since it was already pulled at import time. Only when that's
// empty do we fall back to a fresh SerpApi Amazon Search call, using the
// same category/keyword/title/AI-seed fallback chain as
// findKeywordResearch below, since the root cause (a formal or overly
// broad category label) is identical for both.
async function findCompetitors(input) {
  var ownAsin = (input.asin || '').toUpperCase();

  var boughtTogether = Array.isArray(input.boughtTogether) ? input.boughtTogether : [];
  var fromBoughtTogether = boughtTogether
    .filter(function (r) { return r && r.asin && r.title && r.asin.toUpperCase() !== ownAsin; })
    .slice(0, 5)
    .map(function (r, i) {
      return {
        title: r.title,
        asin: r.asin,
        rating: r.rating || null,
        reviews: r.reviews || null,
        price: r.price || null,
        sponsored: false,
        position: i + 1
      };
    });
  if (fromBoughtTogether.length) return fromBoughtTogether;

  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  var categorySeed = String(input.category || '').trim();
  if (categorySeed.indexOf('>') !== -1) {
    var segments = categorySeed.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    categorySeed = segments[segments.length - 1] || categorySeed;
  }
  var primaryKeywordSeed = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean)[0] || '';
  var titleSeed = String(input.title || '').trim();

  var mechanicalCandidates = [categorySeed, primaryKeywordSeed, titleSeed]
    .filter(Boolean)
    .filter(function (s, i, arr) { return arr.indexOf(s) === i; });

  var found = await trySerpApiCompetitorCandidates(mechanicalCandidates, apiKey, ownAsin);

  if (!found.length) {
    var aiSeeds = await generateSearchSeeds(input);
    if (aiSeeds.length) found = await trySerpApiCompetitorCandidates(aiSeeds, apiKey, ownAsin);
  }

  return found;
}

// Tries each candidate search term against SerpApi's Amazon Search engine
// in order, stops at the first one that returns at least one real
// (non-own-ASIN, titled) result. Mirrors tryDataForSeoCandidates below.
async function trySerpApiCompetitorCandidates(candidates, apiKey, ownAsin) {
  for (var c = 0; c < candidates.length; c++) {
    var query = candidates[c];
    if (!query) continue;

    var url = 'https://serpapi.com/search.json?engine=amazon&k=' +
      encodeURIComponent(query) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);

    try {
      var response = await fetch(url);
      var data = await response.json();
      if (!response.ok) continue;

      var results = Array.isArray(data.organic_results) ? data.organic_results : [];
      var mapped = results
        .filter(function (r) { return r.asin && r.asin.toUpperCase() !== ownAsin && r.title; })
        .slice(0, 5)
        .map(function (r) {
          return {
            title: r.title,
            asin: r.asin,
            rating: r.rating || null,
            reviews: r.reviews || null,
            price: r.price || null,
            sponsored: !!r.sponsored,
            position: r.position || null
          };
        });

      if (mapped.length) return mapped;
    } catch (err) {
      continue;
    }
  }
  return [];
}

// ---------- Competitor bestseller rank (bounded extra calls) ----------
// SerpApi's competitor discovery (boughtTogether and the Amazon Search
// fallback) confirmed live (3 August 2026) to carry rating/reviews/price
// but never a bestseller rank field, on either path. The only way to get
// a competitor's real BSR is a per-ASIN product lookup, the same call
// import-book.js already makes for the author's own book. Capped at the
// first 2 competitors specifically to keep this bounded (mirrors the
// "one extra call per book" reasoning already used for findPageRank
// below), rather than one extra paid call per competitor.
async function attachCompetitorBsr(competitors) {
  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey || !Array.isArray(competitors) || !competitors.length) return;

  var targets = competitors.filter(function (c) { return c && c.asin; }).slice(0, 2);

  for (var i = 0; i < targets.length; i++) {
    var c = targets[i];
    try {
      var url = 'https://serpapi.com/search.json?engine=amazon_product&asin=' +
        encodeURIComponent(c.asin) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);
      var response = await fetch(url);
      var data = await response.json();
      if (!response.ok) continue;

      var ranks = (data.product_details && data.product_details.best_sellers_rank) || [];
      var bestRank = null;
      ranks.forEach(function (r) {
        if (typeof r.extracted_rank === 'number' && (!bestRank || r.extracted_rank < bestRank)) {
          bestRank = r.extracted_rank;
        }
      });
      if (bestRank) c.bestsellerRank = bestRank;

      // Store-wide rank (4 August 2026), same fix as import-book.js: the
      // first entry in best_sellers_rank is Amazon's broadest, store-wide
      // rank, not the lowest-numbered one. Needed for revenue estimation,
      // see estimateNicheStats below and the removal note there.
      if (ranks[0] && typeof ranks[0].extracted_rank === 'number') {
        c.storeWideRank = ranks[0].extracted_rank;
      }
    } catch (err) {
      // best-effort, this competitor just won't have a BSR
      continue;
    }
  }
}

// ---------- Best Seller Rank comparison (no extra calls, pure calculation) ----------
// Fixed 4 August 2026, caught via a live test on a real book before this
// ever reached an author: this file's bestsellerRank field is the
// LOWEST-numbered entry across every category a listing appears in (see
// the bestRank comment in import-book.js), i.e. a category-specific rank
// like "#25 in Child Psychology Reference", not Amazon's overall
// store-wide sales rank ("#45,231 in Books"). An earlier version of this
// function ran that category rank through a public BSR-to-sales-volume
// curve (the kind self-pub tools use for the OVERALL store rank) and
// produced a wildly inflated "~$173,502/mo" niche revenue estimate,
// because a small category-specific rank number looks like a huge
// overall seller when read on the wrong scale. This comparison block
// (yours vs niche average vs top competitor) only ever compares
// category-best rank positions directly, never converts rank into a
// sales or revenue number, that part of the earlier fix stands.
//
// Revenue estimate re-added 4 August 2026, using storeWideRank instead
// (ranks[0], Amazon's broadest/store-wide entry, see the comment on
// storeWideRank in import-book.js and attachCompetitorBsr above), not
// bestsellerRank. Deliberately labelled as an estimate everywhere it's
// shown (dashboard.html), same convention as the Sales/mo milestone bar.
function estimateNicheStats(input, competitors) {
  var ownBsr = (typeof input.bestsellerRank === 'number') ? input.bestsellerRank : null;

  var competitorBsrs = [];
  (competitors || []).forEach(function (c) {
    if (typeof c.bestsellerRank === 'number') competitorBsrs.push(c.bestsellerRank);
  });

  var nicheAverageBsr = competitorBsrs.length
    ? Math.round(competitorBsrs.reduce(function (a, b) { return a + b; }, 0) / competitorBsrs.length)
    : null;
  var topCompetitorBsr = competitorBsrs.length ? Math.min.apply(null, competitorBsrs) : null;

  // Revenue estimate: only ever built from storeWideRank + a real price,
  // one data point per book (own book plus each competitor that has
  // both). Books missing either value simply don't contribute, rather
  // than being estimated with a guessed price or rank.
  var revenueContributions = [];

  var ownPrice = parsePrice(input.price);
  var ownStoreWideRank = (typeof input.storeWideRank === 'number') ? input.storeWideRank : null;
  var ownMonthlyRevenue = estimateMonthlyRevenue(ownStoreWideRank, ownPrice);
  if (ownMonthlyRevenue != null) revenueContributions.push(ownMonthlyRevenue);

  (competitors || []).forEach(function (c) {
    var cPrice = parsePrice(c.price);
    var cRank = (typeof c.storeWideRank === 'number') ? c.storeWideRank : null;
    var cRevenue = estimateMonthlyRevenue(cRank, cPrice);
    if (cRevenue != null) revenueContributions.push(cRevenue);
  });

  var estimatedNicheRevenue = revenueContributions.length
    ? Math.round(revenueContributions.reduce(function (a, b) { return a + b; }, 0))
    : null;

  // "Revenue Reality" block (added 4 August 2026, ReaderBull_Next_Chat
  // this matches the legacy hand-built dashboards' "No Ads. No Revenue."
  // callout, generalised into a real, deterministic rule set instead of
  // per-author hand-written copy. Deliberately pure calculation, no LLM,
  // same reasoning as the rest of this function: every number here must
  // trace back to a real price + storeWideRank, nothing invented.
  //
  // "Paid" competitors = comparable listings with both a real price above
  // $0 and a computable revenue estimate (storeWideRank + price). Their
  // individual (not summed) revenue estimates form the min-max range shown
  // ("paid books in this niche earn $X to $Y a month"). Free listings
  // (price parses to exactly 0, i.e. free ebooks) are counted separately
  // and never enter the range, since a $0 list price always estimates to
  // $0 revenue regardless of rank and would just drag the low end down
  // artificially.
  var paidCompetitorRevenues = [];
  var freeCompetitorCount = 0;
  var benchmarkCompetitor = null; // highest-earning paid competitor: the "close this gap" target
  (competitors || []).forEach(function (c) {
    var cPrice = parsePrice(c.price);
    if (cPrice === 0) { c.estimatedRevenue = 0; freeCompetitorCount++; return; }
    var cRank = (typeof c.storeWideRank === 'number') ? c.storeWideRank : null;
    var cRevenue = estimateMonthlyRevenue(cRank, cPrice);
    if (cRevenue == null) return;
    // Persisted directly on the competitor object (5 August 2026), not just
    // folded into the aggregate range/benchmark below, so the Market
    // Analysis "Niche Data" table (dashboard.html) can show a real Rev/Mo
    // figure per competitor row, matching MASTER-TEMPLATE.html's reference
    // layout, rather than leaving that column blank. Same estimate, same
    // storeWideRank-plus-price basis, no new calculation, just no longer
    // thrown away after contributing to the range/benchmark.
    c.estimatedRevenue = Math.round(cRevenue);
    paidCompetitorRevenues.push(cRevenue);
    if (!benchmarkCompetitor || cRevenue > benchmarkCompetitor.estimatedRevenue) {
      benchmarkCompetitor = {
        title: c.title || null,
        reviews: (typeof c.reviews === 'number') ? c.reviews : null,
        estimatedRevenue: Math.round(cRevenue)
      };
    }
  });

  var revenueRange = paidCompetitorRevenues.length
    ? { min: Math.round(Math.min.apply(null, paidCompetitorRevenues)), max: Math.round(Math.max.apply(null, paidCompetitorRevenues)) }
    : null;

  // Target: the best-performing paid comparable's own estimate, falling
  // back to the top of the range if no single benchmark title resolved.
  // Never a bigger number than the highest real data point we have.
  var targetRevenue = benchmarkCompetitor ? benchmarkCompetitor.estimatedRevenue : (revenueRange ? revenueRange.max : null);

  return {
    bestSellerRank: { yours: ownBsr, nicheAverage: nicheAverageBsr, topCompetitor: topCompetitorBsr },
    sampleSize: competitorBsrs.length + (ownBsr ? 1 : 0),
    // "Books Selling Well In This Niche": every comparable listing found
    // for this book, own book not included in the count. Simple count,
    // no revenue threshold applied, matches what the competitor table
    // itself already shows the author.
    competitorCount: (competitors || []).length,
    estimatedNicheRevenue: estimatedNicheRevenue,
    revenueSampleSize: revenueContributions.length,
    // Revenue Reality block fields:
    yourEstimatedRevenue: (ownMonthlyRevenue != null) ? Math.round(ownMonthlyRevenue) : null,
    paidCompetitorCount: paidCompetitorRevenues.length,
    freeCompetitorCount: freeCompetitorCount,
    revenueRange: revenueRange,
    benchmarkCompetitor: benchmarkCompetitor,
    targetRevenue: targetRevenue,
    // Persisted here (4 August 2026) purely so dashboard.html's
    // saveKeywordChange re-score path (keyword add/remove on the Keywords
    // tab, see that function) has access to the correct store-wide rank
    // for the Sales/mo estimate too, not just the initial onboarding
    // score. onboarding.html has b.storeWideRank in memory at submit
    // time, but nothing else persists it as its own column, this JSONB
    // field is the one place it survives a page reload.
    yourStoreWideRank: ownStoreWideRank
  };
}

// Parses a display price string ("$14.99", "£9.99", "14.99") into a plain
// number, or null if nothing usable is there. Never guesses a price.
function parsePrice(raw) {
  if (typeof raw === 'number') return raw;
  if (!raw) return null;
  var match = String(raw).replace(/,/g, '').match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// Rough public approximation of Amazon's store-wide BSR-to-daily-sales
// curve, the kind of log-scale interpolation self-pub sales-estimator
// tools use (not an exact or proprietary Amazon figure, deliberately
// conservative). Anchor points are commonly-cited rough benchmarks (rank
// 1 selling in the thousands/day, rank ~100,000 selling roughly one a
// day, dropping off sharply after that). Interpolates log-log between
// them, only ever called with storeWideRank, never the category-specific
// bestsellerRank (see the comment above), that mismatch is what produced
// the wrong $173,502/mo figure previously.
var BSR_CURVE = [
  { rank: 1, dailySales: 3000 },
  { rank: 100, dailySales: 200 },
  { rank: 1000, dailySales: 50 },
  { rank: 10000, dailySales: 5 },
  { rank: 100000, dailySales: 1 },
  { rank: 1000000, dailySales: 0.1 },
  { rank: 5000000, dailySales: 0.01 }
];

function estimateMonthlySalesFromRank(rank) {
  if (typeof rank !== 'number' || rank <= 0) return null;
  if (rank <= BSR_CURVE[0].rank) return BSR_CURVE[0].dailySales * 30;
  var last = BSR_CURVE[BSR_CURVE.length - 1];
  if (rank >= last.rank) return last.dailySales * 30;

  for (var i = 0; i < BSR_CURVE.length - 1; i++) {
    var a = BSR_CURVE[i], b = BSR_CURVE[i + 1];
    if (rank >= a.rank && rank <= b.rank) {
      var logRankA = Math.log(a.rank), logRankB = Math.log(b.rank), logRank = Math.log(rank);
      var t = (logRank - logRankA) / (logRankB - logRankA);
      var logSales = Math.log(a.dailySales) + t * (Math.log(b.dailySales) - Math.log(a.dailySales));
      return Math.exp(logSales) * 30;
    }
  }
  return null;
}

function estimateMonthlyRevenue(rank, price) {
  var monthlySales = estimateMonthlySalesFromRank(rank);
  if (monthlySales == null || price == null) return null;
  return monthlySales * price;
}

// ---------- Professional Assessment tag pills (deterministic, not LLM) ----------
// Built directly from data already in the payload, never from the
// narrative model, so every tag traces back to a real number rather than
// something Claude inferred. "Enhanced Content" rather than "A+ Content"
// deliberately: SerpApi has no explicit A+ flag, the true signal is
// whether Amazon's enhanced product_description block came back
// non-empty (see the hasEnhancedContent comment in import-book.js),
// which is a reasonable proxy but not a confirmed fact.
function buildAssessmentTags(input, pageRank) {
  var tags = [];

  if (pageRank && pageRank.checked && typeof pageRank.position === 'number') {
    var page = Math.max(1, Math.ceil(pageRank.position / 16));
    tags.push('Page ' + page + ' Organic');
  }

  if (typeof input.rating === 'number') tags.push(input.rating.toFixed(1) + ' Star Rating');

  if (input.hasEnhancedContent) tags.push('Enhanced Content Live');

  if (typeof input.categoryCount === 'number' && input.categoryCount > 0) {
    tags.push(input.categoryCount + (input.categoryCount === 1 ? ' Category' : ' Categories'));
  }

  if (Array.isArray(input.formats) && input.formats.length) {
    var nonKindle = input.formats.filter(function (f) { return !/kindle/i.test(f); });
    if (nonKindle.length) tags.push(nonKindle.join(' & ') + ' Available');
  }

  if (typeof input.reviewCount === 'number') {
    tags.push(input.reviewCount + (input.reviewCount === 1 ? ' Written Review' : ' Written Reviews'));
  }

  tags.push(input.amazonAdsActive ? 'Ads Active' : 'No Ads Running');

  return tags;
}

// ---------- Revenue Reality callout (deterministic, not LLM) ----------
// Matches the legacy hand-built dashboards' full-width "No Ads. No
// Revenue. The Data Is Clear." callout (ReaderBull_Next_Chat_Handover_Prompt.md,
// confirmed 4 August 2026: the one MVP panel still missing from this
// rebuild). Kept deterministic like buildAssessmentTags above rather than
// LLM-written: every figure here is a real estimate from nicheStats
// (revenueRange, yourEstimatedRevenue, benchmarkCompetitor, targetRevenue),
// so a template avoids any risk of the model inventing or rounding a
// dollar figure that doesn't trace back to real data. Returns null when
// there isn't enough nicheStats data to say anything honest, same
// graceful-fallback convention as the rest of this file.
function buildRevenueInsight(input, nicheStats) {
  if (!nicheStats) return null;
  var range = nicheStats.revenueRange;
  var yours = nicheStats.yourEstimatedRevenue;
  var target = nicheStats.targetRevenue;
  if (range == null && yours == null && target == null) return null;

  var fmt = function (n) {
    if (typeof n !== 'number') return null;
    return '$' + Math.round(n).toLocaleString();
  };

  var headline = input.amazonAdsActive
    ? 'Ads Are Live. Here’s What The Data Shows.'
    : 'No Ads. No Revenue. The Data Is Clear.';

  var sentences = [];
  if (range) {
    sentences.push(
      'Readerbull niche research shows ' + nicheStats.paidCompetitorCount +
      ' comparable paid ' + (nicheStats.paidCompetitorCount === 1 ? 'listing earns' : 'listings earn') +
      ' ' + fmt(range.min) + ' to ' + fmt(range.max) + ' per month each, estimated from rank and price.'
    );
  }
  if (nicheStats.freeCompetitorCount) {
    sentences.push('Free listings in the same niche earn close to $0.');
  }
  if (yours != null) {
    sentences.push(
      'Your book currently earns an estimated ' + fmt(yours) + '/month' +
      (input.amazonAdsActive ? ' with ads running.' : ' with no ads running.')
    );
  }
  if (target != null && (yours == null || target > yours)) {
    var benchmark = nicheStats.benchmarkCompetitor;
    sentences.push(
      'The path to ' + fmt(target) + '+/month means closing the gap to' +
      (benchmark && benchmark.title ? (' "' + benchmark.title + '"') : ' the top comparable title') +
      (benchmark && typeof benchmark.reviews === 'number' ? (', currently at ' + benchmark.reviews + ' reviews.') : '.')
    );
  }
  if (!sentences.length) return null;

  return {
    headline: headline,
    body: sentences.join(' '),
    currentPill: (yours != null) ? ('Currently: ' + fmt(yours) + '/mo') : null,
    targetPill: (target != null)
      ? ('Target: ' + fmt(target) + '/mo' +
          (nicheStats.benchmarkCompetitor && typeof nicheStats.benchmarkCompetitor.reviews === 'number'
            ? (', ' + nicheStats.benchmarkCompetitor.reviews + '-review benchmark')
            : ''))
      : null
  };
}

// ---------- Keyword research (DataForSEO Amazon Related Keywords + Anthropic classification) ----------
// Two paid calls: one DataForSEO request for related keywords with
// volume, one Anthropic call to classify them the way the legacy
// dashboards were hand-built (Use/Skip on the full list, a curated
// Priority/Best Fit subset), since DataForSEO returns raw related terms
// with no relevance judgment of its own (it doesn't know this is a
// non-fiction reincarnation book vs a manga, for example).
async function findKeywordResearch(input) {
  var login = process.env.DATAFORSEO_LOGIN;
  var password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return { __debug: { reason: 'missing dataforseo creds', hasLogin: !!login, hasPassword: !!password, loginLen: (login||'').length, passwordLen: (password||'').length } };

  var auth = Buffer.from(login + ':' + password).toString('base64');

  // Build a short list of mechanical candidate seed terms to try, in order.
  // Amazon's real category names (pulled by import-book.js) are often formal
  // browse node labels like "Personal Transformation Self-Help" rather than
  // something a reader would actually type into search, and DataForSEO's
  // related-keywords endpoint returns zero results for a lot of those
  // (confirmed live 29 July 2026: "Personal Transformation Self-Help"
  // returned 0 items, "self help" returned 30). So try the category leaf
  // first, then the author's own primary backend keyword if they gave one,
  // then the book title as a last mechanical option.
  var categorySeed = String(input.category || '').trim();
  if (categorySeed.indexOf('>') !== -1) {
    var segments = categorySeed.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    categorySeed = segments[segments.length - 1] || categorySeed;
  }
  var primaryKeywordSeed = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean)[0] || '';
  var titleSeed = String(input.title || '').trim();

  var mechanicalCandidates = [categorySeed, primaryKeywordSeed, titleSeed]
    .filter(Boolean)
    .filter(function (s, i, arr) { return arr.indexOf(s) === i; }); // dedupe, keep order

  // TEMP DIAGNOSTIC (5 Aug 2026, remove with the debugLog plumbing above
  // once root-caused): collects what DataForSEO actually said for each
  // candidate seed tried, surfaced on the result so it's visible in the
  // API response without needing server log access.
  var debugLog = [];
  var found = await tryDataForSeoCandidates(mechanicalCandidates, auth, debugLog);

  // Standing rule (ReaderBull_Project_Rules.md, rule 12): keyword research
  // must never come back empty to the author. If every mechanical seed
  // (category, author keyword, title) failed to return anything, or there
  // was no author keyword to try at all, ask Claude to guess a couple of
  // short, natural phrases a reader would actually type into Amazon search
  // for a book like this, then retry with those. One extra cheap AI call
  // (well under a cent), it only fires on the book where every mechanical
  // seed dead-ends, confirmed live 29 July 2026 this happens for real
  // (a book categorised "Medical Child Psychology" with no author keyword).
  var aiSeeds = [];
  if (!found.items.length) {
    aiSeeds = await generateSearchSeeds(input);
    if (aiSeeds.length) {
      found = await tryDataForSeoCandidates(aiSeeds, auth, debugLog);
    }
  }

  if (!found.items.length) {
    // TEMP DIAGNOSTIC (5 Aug 2026): surface why on the null path too.
    return { __debug: { mechanicalCandidates: mechanicalCandidates, aiSeeds: aiSeeds, calls: debugLog } };
  }

  var classified = await classifyKeywords(input, found.seed, found.items);
  if (classified) {
    classified.totalFound = found.totalFound;
    classified.seedKeyword = found.seed;
    classified.__debug = { mechanicalCandidates: mechanicalCandidates, aiSeeds: aiSeeds, calls: debugLog };
    return classified;
  }

  // Classification failed (e.g. no Anthropic key), fall back to the raw
  // list with no Use/Skip judgment rather than losing the DataForSEO data
  // entirely, dashboard.html treats missing status as "Use".
  return {
    seedKeyword: found.seed,
    totalFound: found.totalFound,
    amazonKeywords: found.items.slice(0, 30).map(function (it) { return { keyword: it.keyword, volume: it.volume, status: 'Use' }; }),
    recommendedKeywords: [],
    __debug: { mechanicalCandidates: mechanicalCandidates, aiSeeds: aiSeeds, calls: debugLog }
  };
}

// Tries each candidate seed against DataForSEO in order, stops at the first
// one that returns at least one keyword. Shared by the mechanical-candidate
// pass and the AI-guessed-candidate pass in findKeywordResearch above.
async function tryDataForSeoCandidates(candidates, auth, debugLog) {
  var items = [];
  var totalFound = 0;
  var seed = null;

  for (var c = 0; c < candidates.length; c++) {
    seed = candidates[c];
    try {
      var response = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/amazon/related_keywords/live', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/json'
        },
        // Cost control (tightened 29 July 2026): a 7-keyword KDP author
        // never needs 60 candidates, 30 is plenty of choice while keeping
        // the Anthropic classification step (which reads every keyword)
        // smaller and faster. DataForSEO itself barely notices the
        // difference, it is roughly a flat $0.01 per request plus $0.0001
        // per item, so 30 vs 60 items is a difference of about half a cent
        // per audit either way.
        body: JSON.stringify([{
          keyword: seed.toLowerCase(),
          language_name: 'English',
          location_code: 2840,
          depth: 2,
          limit: 30,
          include_seed_keyword: true
        }])
      });
      var data = await response.json();
      // TEMP DIAGNOSTIC (5 Aug 2026, remove once keyword research gap is
      // root-caused): DataForSEO returns HTTP 200 even on task-level
      // errors (bad auth, low balance, invalid params), the real error
      // lives in data.status_code / tasks[0].status_message, which this
      // endpoint has never surfaced anywhere, so failures here have been
      // silent. Capturing it in the API response temporarily.
      var task = data.tasks && data.tasks[0];
      if (debugLog) {
        debugLog.push({
          seed: seed,
          httpOk: response.ok,
          httpStatus: response.status,
          topStatusCode: data.status_code,
          topStatusMessage: data.status_message,
          taskStatusCode: task && task.status_code,
          taskStatusMessage: task && task.status_message
        });
      }
      if (!response.ok) continue;

      var result = task && task.result && task.result[0];
      if (!result) continue;

      totalFound = result.total_count || (result.items ? result.items.length : 0);
      items = (result.items || []).map(function (it) {
        var kd = it.keyword_data || {};
        var info = kd.keyword_info || {};
        return { keyword: kd.keyword || null, volume: (typeof info.search_volume === 'number') ? info.search_volume : null };
      }).filter(function (it) { return it.keyword; });

      if (items.length) break; // this seed worked, stop trying further candidates
    } catch (err) {
      if (debugLog) debugLog.push({ seed: seed, error: String(err && err.message || err) });
      // try the next candidate seed
      continue;
    }
  }

  return { items: items, totalFound: totalFound, seed: seed };
}

// Last-resort seed guesser (ReaderBull_Project_Rules.md, rule 12). Asks
// Claude to think like a shopper, not a librarian: short, natural search
// phrases rather than the formal Amazon category label or the literal book
// title, both of which have been confirmed live to return zero DataForSEO
// results for some real books.
async function generateSearchSeeds(input) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  var systemPrompt =
    'You help find real Amazon search phrases for a self-published book, for a keyword data ' +
    'tool that only returns results for short, broad, high-traffic search terms, not specific ' +
    'or sentence-like phrases. Given the book\'s title, category and description, suggest 3 ' +
    'short search terms, ordered from broadest to narrowest: 1 to 2 words, then 2 words, then ' +
    'up to 3 words. Every term must read exactly like something typed into a search bar, not a ' +
    'description of the book. Good examples: "screen time", "self help", "habit tracker", ' +
    '"meal prep", "anxiety relief". Bad examples, too long or too sentence-like: "kids screen ' +
    'time dangers", "smartphone effects on children", "how to build better habits". Do not ' +
    'repeat the book title, and do not repeat the formal Amazon category label verbatim if it ' +
    'reads like a stiff catalogue term. Each of the 3 terms should cover a different angle on ' +
    'the book\'s topic, but all three must stay short and broad, favour a common everyday word ' +
    'over a precise one every time there is a choice. ' +
    'Respond with ONLY compact JSON on one line, no markdown fences, no commentary, no ' +
    'indentation, matching exactly this shape: {"seeds": ["term one", "term two", "term three"]}.';

  var payload = {
    title: input.title || null,
    category: input.category || null,
    description: (input.description || '').slice(0, 500) || null
  };

  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the book:\n\n' + JSON.stringify(payload, null, 2) }
        ]
      })
    });

    var data = await response.json();
    if (!response.ok) return [];

    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    var parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return [];
    }

    if (!parsed || !Array.isArray(parsed.seeds)) return [];
    return parsed.seeds.map(function (s) { return String(s || '').trim(); }).filter(Boolean).slice(0, 3);
  } catch (err) {
    return [];
  }
}

async function classifyKeywords(input, seed, items) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  var systemPrompt =
    'You are doing Amazon KDP keyword research triage for Readerbull, a platform that helps ' +
    'self-published authors sell more books. You are given a list of Amazon-related search ' +
    'keywords with monthly search volume for one specific book, plus that book\'s own details. ' +
    'Flag any keyword that is clearly off-market for THIS book as "Skip" (for example: fiction, ' +
    'manga, kids\', or free-ebook variants when the book itself is a paid non-fiction adult title, ' +
    'or vice versa if the book is fiction), everything else buyer-intent relevant is "Use". ' +
    'Never invent keywords or volumes beyond what is given. Do not skip more than necessary, only ' +
    'skip keywords a knowledgeable KDP consultant would actually rule out. ' +
    'From the "Use" keywords, pick up to 8 for a "Recommended" list, the strongest few as ' +
    '"Priority" and the rest as "Best Fit", the ones most worth putting in the author\'s 7 KDP ' +
    'backend keyword fields. ' +
    'Respond with ONLY a JSON object, no markdown fences, no commentary, matching exactly this shape: ' +
    '{"amazonKeywords": [{"keyword": "...", "volume": <number or null>, "status": "Use"|"Skip"}], ' +
    '"recommendedKeywords": [{"keyword": "...", "volume": <number or null>, "status": "Priority"|"Best Fit"}]}. ' +
    'Include every keyword given to you exactly once in amazonKeywords, preserve the volume value given. ' +
    'Output MINIFIED JSON on a single line, no indentation, no line breaks, no extra spaces, this keeps ' +
    'the response short enough to never get cut off.';

  var payload = {
    book: {
      title: input.title || null,
      category: input.category || null,
      seedKeyword: seed,
      description: (input.description || '').slice(0, 500) || null
    },
    keywords: items
  };

  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // 2000 with a minified-JSON instruction (see systemPrompt above):
        // the earlier 1200 cap was getting hit mid-response because the
        // model was pretty-printing the JSON with indentation, which
        // burns 2-3x the tokens of compact JSON, confirmed live on 29
        // July 2026 (stop_reason "max_tokens", parse error on truncated
        // output). Telling it to minify fixes the root cause; this higher
        // cap is just a safety margin so a slightly verbose response
        // still completes instead of silently losing the Recommended list.
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the keyword research data:\n\n' + JSON.stringify(payload, null, 2) }
        ]
      })
    });

    var data = await response.json();
    if (!response.ok) return null;

    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    var parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return null;
    }

    if (!parsed || !Array.isArray(parsed.amazonKeywords)) return null;
    parsed.recommendedKeywords = Array.isArray(parsed.recommendedKeywords) ? parsed.recommendedKeywords.slice(0, 8) : [];
    return parsed;
  } catch (err) {
    return null;
  }
}

// ---------- Narrative generation (Anthropic Messages API) ----------
async function generateNarrative(input, competitors, pageRank, nicheStats) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { await sendErrorAlert('enrich-audit', 'ANTHROPIC_API_KEY is missing, narrative generation cannot run.'); return null; }

  var breakdown = input.breakdown || {};
  var payload = {
    book: {
      title: input.title || null,
      category: input.category || null,
      // Added 3 August 2026: previously pulled into the payload for
      // keyword classification only (classifyKeywords below), never
      // reached this prompt, so a pasted description had no effect on
      // Market Analysis, Marketing Strategy or Quick Wins. Truncated to
      // 500 chars, same limit already used elsewhere in this file.
      description: (input.description || '').slice(0, 500) || null,
      price: input.price || null,
      rating: input.rating || null,
      reviewCount: input.reviewCount || null,
      bestsellerRank: input.bestsellerRank || null,
      keywords: input.keywords || null,
      discoverabilityScore: input.score || null,
      // Added 29 July 2026 (content-quality rewrite, see
      // ReaderBull_Next_Chat_Handover_Prompt.md item 8) so the prompt can
      // gate the paid-ads and portfolio-expansion recommendations below on
      // real data rather than guessing.
      amazonAdsActive: !!input.amazonAdsActive,
      authorBookCount: (typeof input.authorBookCount === 'number') ? input.authorBookCount : null,
      // Added 3 August 2026 for the Overview "Professional Assessment"
      // block: organic search position (from findPageRank above),
      // format availability and the enhanced-content proxy (both from
      // import-book.js), and the deterministic niche revenue estimate
      // (estimateNicheStats above, never computed by the model itself).
      organicSearchPosition: (pageRank && pageRank.checked) ? (pageRank.position || null) : null,
      formats: Array.isArray(input.formats) ? input.formats : null,
      hasEnhancedContent: !!input.hasEnhancedContent
    },
    scoreBreakdown: breakdown,
    competitors: competitors,
    nicheStats: nicheStats || null
  };

  // Content-quality rewrite, 29 July 2026 (ReaderBull_Next_Chat_Handover_Prompt.md
  // item 8, all points below confirmed directly with John): removes the
  // off-platform review-trust angle (Amazon is a closed marketplace, authors
  // can't reference their own reviews off it), demotes "price justifies
  // value" out of the top 3, adds a review-count-gated (15+) paid-ads
  // recommendation with concrete guidance rather than "you should run ads",
  // adds a single-book portfolio-expansion idea, softens the backend-keyword
  // assumption to "if you haven't already", and points the reviews
  // recommendation at Readerbull's own Build Your ARC tool (free to start,
  // reciprocal) instead of emailing readers or naming an external ARC site.
  var systemPrompt =
    'You write the Market Analysis, Marketing Strategy and Quick Wins content for Readerbull, ' +
    'a platform that helps self-published authors sell more books. You are writing for one specific ' +
    'author about their one specific book, using only the structured data given to you below. ' +
    'Never invent competitor names, numbers, ranks, prices or reviews beyond what is in the data. ' +
    'If book.description is given, use it to understand the book\'s actual subject, angle and ' +
    'audience so marketAnalysis and strategySteps are grounded in what the book really is, not ' +
    'generic filler, but never quote it at length or treat it as marketing copy to reproduce. ' +
    'If a field is missing, write around it honestly rather than guessing. Use British spelling ' +
    '(optimise, personalise, recognise). Never use the em dash character. Keep the tone direct, ' +
    'encouraging and specific, not generic SaaS filler. ' +
    'Data-gating principle: only make a recommendation whose credibility depends on a specific data ' +
    'threshold if the book\'s own data actually supports it. Never suggest leveraging review volume, ' +
    'reviews as a trust signal, or building authority with hesitant buyers off Amazon\'s own platform, ' +
    'Amazon is a closed marketplace and authors cannot meaningfully reference their own reviews ' +
    'anywhere else. Apply this same gating logic to any other recommendation whose credibility ' +
    'depends on the book already having a certain amount of data behind it. ' +
    'Paid Amazon Ads: if book.amazonAdsActive is false, always include a paid-ads recommendation ' +
    'somewhere in strategySteps. It only qualifies for a guaranteed top-3 quickWins placement once ' +
    'book.reviewCount is 15 or more, below that threshold other quick wins (such as building reviews ' +
    'first) may rank above it. When you recommend ads, give concrete, actionable guidance rather than ' +
    'just "you should run ads": suggest a modest starting daily budget range, a target ACoS ' +
    '(advertising cost of sale) ceiling to judge profitability, targeting the book\'s own keywords plus ' +
    '(only if competitor data is given) Sponsored Display against those specific competitor ASINs, and ' +
    'a short review-and-adjust timeframe (for example 14 days) before scaling spend. ' +
    'Price vs value: "price justifies value" is a valid angle but must never be one of the top 3 most ' +
    'prominent points across marketAnalysis, strategySteps or quickWins combined, rank it further down ' +
    'if you use it at all. ' +
    'Reviews: if book.reviewCount is below 15, recommend the author launch or grow their Build Your ARC ' +
    'campaign (Readerbull\'s own built-in tool, found under Tools in the sidebar) to reach opted-in ' +
    'readers for honest reviews, it is free to start and reciprocal: the more an author reads and ' +
    'reviews other authors\' books through it, the more they get back for their own book. Never suggest ' +
    'emailing or messaging existing readers/reviewers directly to ask for reviews, and never name any ' +
    'external ARC or review-swap service. ' +
    'Backend keywords: never assume the author has already filled in their 7 KDP backend keyword ' +
    'fields. Phrase any related advice as "if you haven\'t already" rather than assuming they\'re ' +
    'already populated, since we don\'t actually know their KDP backend state. ' +
    'Portfolio angle: if book.authorBookCount is exactly 1, consider including a quickWin or strategy ' +
    'step suggesting the author think about a second, related title, since a second book compounds ' +
    'discoverability (cross-sell, a new keyword footprint, a new category placement). Do not suggest ' +
    'this if authorBookCount is missing, null, or greater than 1. ' +
    'Professional Assessment: write a short, direct verdict (2 short paragraphs) for the Overview tab, in ' +
    'the voice of an experienced KDP consultant giving a straight read of where this book stands right now. ' +
    'Ground it in nicheStats.bestSellerRank (how this book\'s best category placement compares to the niche ' +
    'average and top competitor, always described as a rank comparison, never converted into a sales or ' +
    'revenue figure, nicheStats has no revenue numbers) and book.organicSearchPosition, book.formats, ' +
    'book.hasEnhancedContent, book.amazonAdsActive when given. If nicheStats or its numbers are null, write ' +
    'around the gap honestly instead of guessing a figure. Name the single biggest lever available (usually ' +
    'reviews, ads, or both) and roughly what closes the gap, without inventing a specific target number ' +
    'or dollar figure unless one is present in the data given. ' +
    'Content type (added 4 August 2026, for the Overview "Book Summary" panel): classify this book\'s ' +
    'subject matter as exactly one of "Evergreen", "Trending", or "Seasonal", based on book.title, ' +
    'book.category and book.description. Evergreen means the topic stays relevant indefinitely (most ' +
    'non-fiction how-to, self-help, health, personal-development, and most fiction genres). Trending ' +
    'means the topic is tied to a current cultural moment likely to fade (a specific viral trend, a ' +
    'recent news event). Seasonal means demand for the topic spikes at a specific time of year (holiday ' +
    'guides, tax-season, back-to-school, diet-after-New-Year). Default to "Evergreen" unless the subject ' +
    'clearly fits one of the other two, most self-published non-fiction and fiction is evergreen. ' +
    'Respond with ONLY a JSON object, no markdown fences, no commentary, matching exactly this shape: ' +
    '{"bookInsight": "one bolded-worthy sentence summarising the single biggest takeaway", ' +
    '"marketAnalysis": "2-3 short paragraphs on where this book stands versus the competitors given", ' +
    '"strategySteps": [{"title": "short step title", "body": "1-2 sentences, specific to this book\'s data"}], ' +
    '"quickWins": [{"title": "short action title", "body": "1-2 sentences on why this is the next best move"}], ' +
    '"professionalAssessment": "2 short paragraphs, as described above", ' +
    '"contentType": "Evergreen"|"Trending"|"Seasonal"}. ' +
    'Provide 3-5 strategySteps ordered by likely impact, and 3 quickWins ordered by ease and impact.';

  try {
    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // Raised from 1200 to 1600 on 3 August 2026: the new
        // professionalAssessment field adds roughly two more paragraphs
        // of output on top of the existing four fields, same
        // max-tokens-cutoff risk already solved for classifyKeywords
        // above applies here too.
        max_tokens: 1600,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the structured audit data:\n\n' + JSON.stringify(payload, null, 2) }
        ]
      })
    });

    var data = await response.json();
    if (!response.ok) { await sendErrorAlert('enrich-audit', 'Anthropic narrative call returned an error status.'); return null; }

    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    var parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;
    return stripEmDashes(parsed);
  } catch (err) {
    await sendErrorAlert('enrich-audit', 'Narrative generation threw an unexpected error: ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

// Defensive backstop for the "never use the em dash character" instruction
// above (added 4 August 2026, per John: "make sure there are no em dashes
// anywhere on the site"). The system prompt already tells the model not to
// use em dashes, but a prompt instruction is not a guarantee, models slip.
// Recursively walks every string in the parsed narrative (bookInsight,
// marketAnalysis, strategySteps/quickWins titles+bodies,
// professionalAssessment, etc.) and replaces any em dash with a plain
// " - ", so a stray one from the model can never reach the page. Runs
// once here on the narrative object only, nicheStats/assessmentTags are
// pure calculations with no free text and never need this.
function stripEmDashes(value) {
  if (typeof value === 'string') return value.split('—').join(' - ');
  if (Array.isArray(value)) return value.map(stripEmDashes);
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (k) { out[k] = stripEmDashes(value[k]); });
    return out;
  }
  return value;
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
