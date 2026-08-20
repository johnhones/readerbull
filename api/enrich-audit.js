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
// must never come back empty. findKeywordResearch tries the best available
// seed against DataForSEO exactly once (cost-capped, see the comment on
// findKeywordResearch below); if that single paid call comes back empty,
// it asks Claude to suggest search-style keywords with no live search
// volume, so the author is never shown a truly empty result, without ever
// paying for a second DataForSEO lookup.
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
//
// Cost cap (5 August 2026, per John: worst case must never exceed a few
// cents): findKeywordResearch previously retried up to 3 mechanical seeds
// then up to 3 AI-guessed seeds against DataForSEO, up to 6 paid calls on
// a bad book. Now capped at exactly one paid DataForSEO call per audit,
// backed by a shared cross-author cache (keyword_research_cache table) so
// repeat seeds across different authors' books cost nothing at all. If
// that single call comes back empty, falls back to free AI-suggested
// keywords (Claude-generated, no live search volume) rather than a second
// paid lookup, see findKeywordResearch and tryDataForSeoSingleCall below.

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
        position: i + 1,
        // Passed straight through from import-book.js's boughtTogether
        // mapping (r.image there), which already applied the same
        // thumbnails[0]/thumbnail fallback used for the author's own
        // cover, so Growth Tracker's competitor pills (20 August 2026)
        // can show real cover art with zero new SerpApi calls.
        image: r.image || null
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
// (non-own-ASIN, titled) result. Mirrors the single-call DataForSEO helper
// used by findKeywordResearch.
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
            position: r.position || null,
            // Same thumbnails[0]/thumbnail fallback as import-book.js's
            // coverImage extraction, SerpApi's Amazon Search engine
            // (engine=amazon) returns the same thumbnail shape as
            // amazon_product does, confirmed against a live response.
            image: (r.thumbnails && r.thumbnails[0]) || r.thumbnail || null
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
    if (cPrice === 0) { freeCompetitorCount++; return; }
    var cRank = (typeof c.storeWideRank === 'number') ? c.storeWideRank : null;
    var cRevenue = estimateMonthlyRevenue(cRank, cPrice);
    if (cRevenue == null) return;
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
// Cost-capped (5 August 2026, per John: worst case must never exceed a
// couple of cents, zero exceptions). Picks the single best available seed
// term (author's own primary keyword first, since that's the most
// deliberate signal, falling back to category then title), checks a
// shared cross-author cache first (keyword_research_cache table, so a
// popular seed only ever costs DataForSEO money once across every author
// using Readerbull), and if it's a genuine cache miss makes exactly ONE
// paid DataForSEO call, never a chain of retries. If that single call
// comes back empty, falls back to free Claude-suggested search terms
// (generateSearchSeeds, already existed for the old retry chain) with no
// live search volume attached, rather than paying for a second DataForSEO
// lookup. This satisfies ReaderBull_Project_Rules.md rule 12 (keyword
// research must never come back completely empty) without the old
// worst-case cost of up to 6 paid calls per audit.
//
// Book portfolio opportunity (8 August 2026): classifyKeywords below also
// flags up to 2 keywords from this same DataForSEO pull that read as a
// genuinely different book topic, not just a variant of this book. Zero
// new paid calls, rides on the existing classification call. Surfaced in
// dashboard.html as a small "Book Portfolio Opportunity" card on the
// Keywords tab, only when non-empty. New/refreshed audits only, per John,
// the ~15 existing legacy audits were deliberately not backfilled.
var KEYWORD_CACHE_SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';

function normalizeSeed(seed) {
  return String(seed || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Looks up a previously-fetched DataForSEO result for this normalized
// seed. TTL is 30 days for a real (non-empty) result, 7 days for a
// confirmed-empty one (so a temporarily-thin term gets retried sooner
// than a well-established one). Service-role key only, this table has no
// public policies. Best-effort: any lookup failure is treated as a cache
// miss rather than blocking the audit.
async function lookupKeywordCache(seed) {
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  var normalized = normalizeSeed(seed);
  if (!normalized) return null;

  try {
    var response = await fetch(
      KEYWORD_CACHE_SUPABASE_URL + '/rest/v1/keyword_research_cache?select=*&normalized_seed=eq.' + encodeURIComponent(normalized),
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    if (!response.ok) return null;
    var rows = await response.json();
    var row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    var ttlMs = row.is_empty ? (7 * 24 * 60 * 60 * 1000) : (30 * 24 * 60 * 60 * 1000);
    var ageMs = Date.now() - new Date(row.fetched_at).getTime();
    if (ageMs > ttlMs) return null; // stale, treat as a miss, pay for a fresh lookup

    return { items: row.items || [], totalFound: row.total_found || 0, seed: row.seed_keyword };
  } catch (err) {
    return null;
  }
}

// Upserts a fresh DataForSEO result into the shared cache, keyed by the
// normalized seed. Best-effort: a write failure never blocks the audit,
// it just means the next author with the same seed pays for a fresh call
// too, no different from the cache not existing at all.
async function writeKeywordCache(seed, found) {
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return;
  var normalized = normalizeSeed(seed);
  if (!normalized) return;

  try {
    await fetch(KEYWORD_CACHE_SUPABASE_URL + '/rest/v1/keyword_research_cache?on_conflict=normalized_seed', {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        normalized_seed: normalized,
        seed_keyword: seed,
        items: found.items || [],
        total_found: found.totalFound || 0,
        is_empty: !(found.items && found.items.length),
        fetched_at: new Date().toISOString()
      })
    });
  } catch (err) {
    // best-effort, a cache write failure just means no caching this time
  }
}

async function findKeywordResearch(input) {
  var login = process.env.DATAFORSEO_LOGIN;
  var password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;

  var auth = Buffer.from(login + ':' + password).toString('base64');

  // Single best seed, not a candidate list: the author's own primary
  // backend keyword is the most deliberate signal when they gave one,
  // falling back to the category leaf (stripped to its last segment,
  // Amazon's formal browse-node labels are often stiff catalogue terms
  // rather than something a shopper would type), then the book title as
  // a last mechanical option.
  var categorySeed = String(input.category || '').trim();
  if (categorySeed.indexOf('>') !== -1) {
    var segments = categorySeed.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    categorySeed = segments[segments.length - 1] || categorySeed;
  }
  var primaryKeywordSeed = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean)[0] || '';
  var titleSeed = String(input.title || '').trim();

  var bestSeed = primaryKeywordSeed || categorySeed || titleSeed || null;
  if (!bestSeed) return null;

  var found = await lookupKeywordCache(bestSeed);
  if (!found) {
    found = await tryDataForSeoSingleCall(bestSeed, auth);
    writeKeywordCache(bestSeed, found); // fire-and-forget, don't block the response on a cache write
  }

  // Standing rule (ReaderBull_Project_Rules.md, rule 12): keyword research
  // must never come back empty to the author. But the single paid
  // DataForSEO call above (or a cached miss) is as far as this ever pays
  // for. If it's genuinely empty, fall back to free Claude-suggested
  // search terms with no live search volume, rather than a second paid
  // DataForSEO lookup.
  if (!found.items.length) {
    var aiSeeds = await generateSearchSeeds(input);
    if (!aiSeeds.length) return null;

    return {
      seedKeyword: bestSeed,
      totalFound: 0,
      suggestedOnly: true,
      amazonKeywords: [],
      recommendedKeywords: aiSeeds.map(function (s) { return { keyword: s, volume: null, status: 'Suggested' }; }),
      // No portfolio opportunity signal here either, classifyKeywords never ran
      // (there was nothing from DataForSEO to classify), same empty-array
      // convention used throughout this file.
      portfolioOpportunities: []
    };
  }

  var classified = await classifyKeywords(input, found.seed, found.items);
  if (classified) {
    classified.totalFound = found.totalFound;
    classified.seedKeyword = found.seed;
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
    // Classification (classifyKeywords) is what actually spots portfolio
    // opportunities, this branch only runs when that call failed (e.g. no
    // Anthropic key), so there's nothing to report, same empty-array
    // convention as recommendedKeywords above.
    portfolioOpportunities: []
  };
}

// Exactly one HTTP call to DataForSEO for the given seed. Replaces the old
// tryDataForSeoCandidates loop (which retried up to 3 candidates per
// pass), see the cost-cap comment above findKeywordResearch.
async function tryDataForSeoSingleCall(seed, auth) {
  try {
    var response = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/amazon/related_keywords/live', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json'
      },
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
    if (!response.ok) return { items: [], totalFound: 0, seed: seed };

    var task = data.tasks && data.tasks[0];
    var result = task && task.result && task.result[0];
    if (!result) return { items: [], totalFound: 0, seed: seed };

    var totalFound = result.total_count || (result.items ? result.items.length : 0);
    var items = (result.items || []).map(function (it) {
      var kd = it.keyword_data || {};
      var info = kd.keyword_info || {};
      return { keyword: kd.keyword || null, volume: (typeof info.search_volume === 'number') ? info.search_volume : null };
    }).filter(function (it) { return it.keyword; });

    return { items: items, totalFound: totalFound, seed: seed };
  } catch (err) {
    return { items: [], totalFound: 0, seed: seed };
  }
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
    'Portfolio opportunity (added 8 August 2026, reuses this same keyword list, no extra paid ' +
    'call): separately from the Use/Skip/Recommended judgment above, look for up to 2 keywords in ' +
    'the SAME list that represent a genuinely different book topic or niche, not a variant, synonym ' +
    'or sub-angle of THIS book (for example, if this book is about reincarnation, "twin flame" or ' +
    '"shadow work" would qualify as a different topic, but "past life regression" would not, that\'s ' +
    'still this book\'s own topic). Only include a keyword here if a knowledgeable KDP consultant ' +
    'would genuinely say "that\'s a different book", not just a different phrasing of this one. It is ' +
    'completely fine, and expected most of the time, for this list to be empty, only include a ' +
    'keyword when the fit is real. For each one, write a single short sentence explaining why it ' +
    'reads as a distinct opportunity rather than an angle on the current book. Never invent a ' +
    'keyword or volume beyond what is given in the list below. ' +
    'Respond with ONLY a JSON object, no markdown fences, no commentary, matching exactly this shape: ' +
    '{"amazonKeywords": [{"keyword": "...", "volume": <number or null>, "status": "Use"|"Skip"}], ' +
    '"recommendedKeywords": [{"keyword": "...", "volume": <number or null>, "status": "Priority"|"Best Fit"}], ' +
    '"portfolioOpportunities": [{"keyword": "...", "volume": <number or null>, "why": "one short sentence"}]}. ' +
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
    // Portfolio opportunity (8 August 2026): defensive default so
    // dashboard.html can always assume an array, never undefined, same
    // convention as recommendedKeywords above. Capped at 2, matching the
    // limit already told to the model in the system prompt.
    parsed.portfolioOpportunities = Array.isArray(parsed.portfolioOpportunities) ? parsed.portfolioOpportunities.slice(0, 2) : [];
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
    nicheStats: nicheStats || null,
    // Added 19 August 2026 for the rebuilt bookInsight "what needs
    // attention" bullet (rule 17/18): the author's own chosen Growth
    // Tracker competitors, once that table exists (not built yet). Each
    // entry expected as {name, rank, monthlyRevenue}, sourced from real
    // tracked-competitor data, never computed here. Until the Growth
    // Tracker ships and its caller passes input.trackedCompetitors, this
    // is always null and the prompt below falls back to niche-relative
    // language with no named competitors, per the "never invent data"
    // rule. No caller currently sets input.trackedCompetitors, this field
    // is forward-compatible plumbing only, added now so the Growth
    // Tracker build doesn't need to touch this prompt again later.
    trackedCompetitors: Array.isArray(input.trackedCompetitors) ? input.trackedCompetitors : null
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
    'Book Insight (rebuilt as 4 bullets, 19 August 2026, per rule 17 in ReaderBull_Project_Rules.md, ' +
    'replaces the old single-sentence format entirely): bookInsight is the very first thing an author sees ' +
    'about their book and must feel like a real opportunity, not a data report. It is now an object with ' +
    'exactly these 4 keys, potential, whatsWorking, whatNeedsAttention, whatToDoNext (see the JSON shape ' +
    'below), each a single string of 1-2 short, warm sentences, never an array and never one long block ' +
    'of text. Vary your phrasing, structure and word choice meaningfully from book to book, this must ' +
    'never read like the same template sentence with numbers swapped in. Never state a rank comparison ' +
    'as a ratio or multiple ("150 times deeper", "3x behind"), that phrasing is banned everywhere in the ' +
    'narrative, not just here. Never use the term "rank gap" or any other internal-sounding jargon label ' +
    'anywhere in these 4 bullets, state the actual numbers plainly instead, the numbers already carry the ' +
    'meaning. ' +
    'potential: name a concrete real revenue figure for top books in this niche, sourced only from ' +
    'nicheStats.benchmarkCompetitor.estimatedRevenue or nicheStats.targetRevenue/revenueRange, phrased ' +
    'like "top books in this niche earn around $X/month". If revenue data is genuinely missing, name the ' +
    'niche\'s real demand instead (nicheStats.estimatedNicheRevenue or competitorCount) rather than ' +
    'inventing a number or falling back to jargon. ' +
    'whatsWorking: name the book\'s genuinely strong metric(s), reviews and/or rating, stated plainly. ' +
    'Only credit book.rating as a positive signal once book.reviewCount is 3 or higher, a perfect average ' +
    'built on 1-2 reviews is not credible evidence of anything and must not be praised as if it were. If ' +
    'neither reviews nor rating are genuinely strong yet, say so honestly rather than inventing a strength ' +
    'that is not there, for example note plainly that nothing there is holding the book back and point ' +
    'forward to where the real opportunity is, never force a compliment the data does not support. ' +
    'whatNeedsAttention: the real gap, using actual numbers. Ground this in nicheStats.bestSellerRank, ' +
    'book\'s own category rank (nicheStats.bestSellerRank.yours) against nicheAverage and/or ' +
    'topCompetitor. When trackedCompetitors is given (the author\'s own chosen Growth Tracker competitors, ' +
    'each with name, rank and monthlyRevenue, real tracked data, never invented or estimated by you), name ' +
    'up to 2 of them by name, but only after introducing them first, for example "one similar book you\'re ' +
    'tracking, [name]," or "two similar books you\'re tracking, [name] and [name],", never drop a name in ' +
    'cold with no lead-in. Follow the name(s) immediately with that competitor\'s real category rank, then ' +
    'its real monthly sales figure from trackedCompetitors, in the pattern "sit at A and B. Monthly sales ' +
    'are $X and $Y, respectively." (adjust to singular for one competitor). When trackedCompetitors is ' +
    'empty or not given, which is the normal case until the author has added tracked competitors on their ' +
    'Growth Tracker, do not name any competitor, use niche-relative language instead, comparing this ' +
    'book\'s own rank against nicheAverage and/or topCompetitor plainly, then name the real cause ' +
    '(visibility and discoverability, keyword coverage, category fit, whichever the data best supports), ' +
    'never book quality. Either way, end by naming the real cause of the gap plainly, this is the pattern ' +
    'to follow, using only real data every time, never these literal names, numbers or exact wording: ' +
    '"your book sits at 195 in its category. Two similar books you\'re tracking, Bake & Blend Co. and The ' +
    'Herbal Kitchen, sit at 55 and 31. Monthly sales are $410 and $748, respectively. That gap is ' +
    'visibility and discoverability, not book quality." ' +
    'whatToDoNext: the plain-English next action. Point at the Growth Tracker by name generally ("track ' +
    'your progress on your Growth Tracker"), never re-list any competitor name(s) already used in ' +
    'whatNeedsAttention. Mention ensuring the book listing is fully optimised and running a paid ads ' +
    'campaign. Keep this short: no ad budget figures, no ad-return target, no sales-per-spend ratio. ' +
    'Apply rule 14\'s tone (ReaderBull_Project_Rules.md) to all 4 bullets: confident and direct, never ' +
    'hedge ("likely", "probably", "may be"), and whenever a bullet names a strong metric only to rule it ' +
    'out as the cause of a gap, credit that metric plainly first, then name the real cause, never state ' +
    'that a strong metric helped cause or is responsible for a gap the book is losing on, that is ' +
    'logically backwards. ' +
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
    '{"bookInsight": {"potential": "real earning potential for top books in this niche", ' +
    '"whatsWorking": "the book\'s genuinely strong metric(s), stated plainly", ' +
    '"whatNeedsAttention": "the real gap, named competitors if trackedCompetitors is given, niche-relative if not", ' +
    '"whatToDoNext": "the plain-English next action, points at the Growth Tracker generally"}, ' +
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

// Added 19 August 2026 for the Growth Tracker weekly snapshot job
// (api/growth-tracker.js): exposes the existing BSR-to-revenue estimator
// as named properties on the default export, so that file can
// require('./enrich-audit').estimateMonthlyRevenue etc. and reuse the
// exact same calculation rather than a second copy drifting out of sync,
// per rule 18 ("reuse that logic rather than writing a second
// BSR-to-revenue estimator"). module.exports stays a function (the
// Vercel request handler for THIS file's own route), attaching named
// properties onto it doesn't change that, Node functions are objects.
module.exports.parsePrice = parsePrice;
module.exports.estimateMonthlySalesFromRank = estimateMonthlySalesFromRank;
module.exports.estimateMonthlyRevenue = estimateMonthlyRevenue;
