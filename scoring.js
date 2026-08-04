/*
 * Readerbull Discoverability Score - R27 formula
 * -----------------------------------------------------------------------
 * Rebuilt 28 July 2026 to match R27, the locked formula documented in
 * JOHN_HONES_MASTER_RULES_BACKUP_2026-07-06.md, replacing the old
 * four-category (Reviews & Ratings /40, Keyword Coverage /30, Listing
 * Setup /15, Category Fit /15) formula this file used to run. See
 * ReaderBull_Scoring_Rebuild_Handover.md for the full data-availability
 * writeup and the decisions this rebuild is based on.
 *
 * Five factors, each worth 20 points, total /100:
 *   1. Listing            /20 - sub-signals folded into one score.
 *   2. Reviews & Ratings  /20 - APPROXIMATED from SerpApi's combined
 *                                ratings total, not a written-review-only
 *                                count (Amazon doesn't expose that
 *                                separately, and self-report was ruled
 *                                out for this rebuild). Every place this
 *                                is surfaced must label it as approximate.
 *   3. Star Rating        /20 - straightforward from the pulled rating.
 *   4. Sales/mo           /20 - ESTIMATED from bestseller rank (BSR) via
 *                                a log-interpolated rank-to-sales curve,
 *                                self-report was ruled out for this
 *                                rebuild. Must be labelled as an estimate
 *                                wherever surfaced, never shown as a
 *                                literal number to the author (matches
 *                                the locked spec regardless of source).
 *   5. Price vs Niche     /20 - fully internal, never shown as a bar.
 *   Amazon Ads pill (0 pts) - status only, self-reported, contributes
 *                                nothing to the total.
 *
 * A+ Content is deliberately OUT of scope for this rebuild (no automated
 * signal exists and it was ruled out of the Listing sub-factors).
 *
 * Every point below is still a fixed, inspectable rule, no black box, but
 * the Listing /20 sub-factors are a deterministic approximation of a
 * partly qualitative spec (things like "description quality" and "cover
 * quality" were originally graded by eye when these dashboards were hand
 * built). Where the original spec gives an exact rule, e.g. the 12/20 cap
 * when backend keywords aren't fully confirmed, that rule is applied
 * exactly.
 */

// ---------- shared helpers ----------

function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 0 ? v : null;
  var m = String(v).match(/[\d]+(\.\d+)?/);
  if (!m) return null;
  var n = Number(m[0]);
  return n > 0 ? n : null;
}

function parseKeywordList(keywordsRaw) {
  return String(keywordsRaw || '')
    .split(',')
    .map(function (k) { return k.trim(); })
    .filter(Boolean);
}

// ---------- Listing /20 ----------

function scoreListing(inputs) {
  var title = String(inputs.title || '');
  var keywordsList = parseKeywordList(inputs.keywords);
  var primaryKeyword = keywordsList[0] || '';
  var backendCount = Math.min(keywordsList.length, 7);

  var pts = 0;

  // Primary keyword present in the title (3)
  if (primaryKeyword && title.toLowerCase().indexOf(primaryKeyword.toLowerCase()) !== -1) {
    pts += 3;
  }

  // Backend keyword fields filled, up to 7 (4)
  pts += Math.round((backendCount / 7) * 4);

  // Description quality, length as a proxy for depth (4)
  var descLen = String(inputs.description || '').trim().length;
  if (descLen >= 250) pts += 4;
  else if (descLen >= 150) pts += 3;
  else if (descLen >= 100) pts += 2;
  else if (descLen > 0) pts += 1;

  // Number of categories the listing appears in, 1-3 (3)
  var catCount = Number(inputs.categoryCount);
  if (!catCount || catCount < 0) catCount = inputs.category ? 1 : 0;
  catCount = Math.max(0, Math.min(3, catCount));
  pts += catCount;

  // Category selection quality, via achievable bestseller rank (3)
  var rank = Number(inputs.bestsellerRank);
  if (rank && rank > 0) {
    if (rank <= 100) pts += 3;
    else if (rank <= 1000) pts += 2;
    else if (rank <= 10000) pts += 1;
  }

  // Organic page rank on incognito search, primary keyword only (2)
  // Built this rebuild: one extra paid SerpApi search call per book
  // (primary keyword only, not all 7 backend keywords) via
  // api/enrich-audit.js. "Page 1" treated as within the first 16 organic
  // results returned by SerpApi's amazon search engine.
  if (inputs.pageRank && inputs.pageRank.position) {
    pts += inputs.pageRank.position <= 16 ? 2 : 1;
  }

  // Cover pulled and present (1)
  if (inputs.coverImage) pts += 1;

  pts = Math.max(0, Math.min(20, pts));

  // Locked rule: cap at 12/20 until all 7 backend keyword fields are
  // confirmed, regardless of how strong everything else is.
  if (backendCount < 7) pts = Math.min(pts, 12);

  return pts;
}

// ---------- Reviews & Ratings /20 ----------

function scoreReviewsRatings(reviewCount) {
  var n = Number(reviewCount) || 0;
  if (n >= 30) return 20;
  if (n >= 15) return 14;
  if (n >= 8) return 10;
  if (n >= 3) return 5;
  if (n >= 1) return 2;
  return 0;
}

// ---------- Star Rating /20 ----------

function scoreStarRating(rating) {
  var r = Number(rating);
  if (!r || r <= 0) return 0;
  if (r >= 4.5) return 20;
  if (r >= 4.0) return 16;
  if (r >= 3.5) return 10;
  if (r >= 3.0) return 5;
  return 0;
}

// ---------- Sales/mo /20, BSR-based estimate ----------

// Rough, publicly-documented Kindle Store BSR-to-daily-sales benchmarks
// (rank 1,000 =~ 100+/day, 10,000 =~ 10-15/day, 100,000 =~ 1/day, 200,000
// =~ 0.5/day, 500,000 =~ 0.2/day, 1,000,000 =~ 0.1/day), log-log
// interpolated between anchor points. This is an estimate, not a fact,
// actual sales-per-rank varies by category and season. Anything derived
// from this must be labelled as estimated wherever it's surfaced.
var BSR_SALES_ANCHORS = [
  [1, 3500],
  [100, 450],
  [500, 180],
  [1000, 100],
  [5000, 25],
  [10000, 12.5],
  [50000, 2.5],
  [100000, 1],
  [200000, 0.5],
  [500000, 0.2],
  [1000000, 0.1],
  [3000000, 0.02]
];

function estimateDailySalesFromBsr(bsr) {
  var rank = Number(bsr);
  if (!rank || rank <= 0) return null;

  var anchors = BSR_SALES_ANCHORS;
  if (rank <= anchors[0][0]) return anchors[0][1];
  if (rank >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];

  for (var i = 0; i < anchors.length - 1; i++) {
    var lo = anchors[i], hi = anchors[i + 1];
    if (rank >= lo[0] && rank <= hi[0]) {
      var t = (Math.log(rank) - Math.log(lo[0])) / (Math.log(hi[0]) - Math.log(lo[0]));
      var logSales = Math.log(lo[1]) + t * (Math.log(hi[1]) - Math.log(lo[1]));
      return Math.exp(logSales);
    }
  }
  return null;
}

function estimateMonthlyRevenue(bsr, price) {
  var daily = estimateDailySalesFromBsr(bsr);
  var p = parsePrice(price);
  if (daily === null || !p) return null;
  return daily * 30.4 * p;
}

// bsr here should be storeWideRank whenever it's available (see
// computeDiscoverabilityScore below): bestsellerRank alone is the
// lowest-numbered entry across every category a listing appears in (e.g.
// "#32 in Blogging"), a narrow category-specific rank, not Amazon's
// overall store-wide sales rank. Running that small category number
// through this store-wide curve reads as a huge overall seller and wildly
// overstates the estimate, the same scale-mismatch bug already fixed for
// the Overview "KDP Niche Revenue" figure in api/enrich-audit.js (see the
// comment on estimateNicheStats there), caught again 4 August 2026 when a
// book showing "$1,000+ milestone reached" here had a niche-wide revenue
// estimate of only $247/mo. Falls back to bestsellerRank only when
// storeWideRank truly isn't available (an older book, or the SerpApi call
// failed), better than showing nothing.
function scoreSalesPerMonth(bsr, price) {
  var revenue = estimateMonthlyRevenue(bsr, price);
  var points;
  if (revenue === null) points = 0;
  else if (revenue >= 500) points = 20;
  else if (revenue >= 200) points = 15;
  else if (revenue >= 50) points = 10;
  else if (revenue >= 10) points = 5;
  else if (revenue >= 1) points = 2;
  else points = 0;
  return { points: points, estimatedRevenue: revenue };
}

// ---------- Price vs Niche /20, fully internal ----------

function scorePriceVsNiche(price, competitors) {
  var p = parsePrice(price);
  if (!p || !competitors || !competitors.length) return { points: 0, nicheAvg: null };

  var prices = competitors
    .map(function (c) { return parsePrice(c && c.price); })
    .filter(function (v) { return v !== null; });

  if (!prices.length) return { points: 0, nicheAvg: null };

  var avg = prices.reduce(function (a, b) { return a + b; }, 0) / prices.length;
  var diffPct = Math.abs(p - avg) / avg * 100;

  var points;
  if (diffPct <= 20) points = 20;
  else if (diffPct <= 50) points = 13;
  else points = 5;

  return { points: points, nicheAvg: avg };
}

// ---------- Score badge ----------

function scoreBadge(score) {
  var s = Number(score) || 0;
  if (s >= 76) return 'Established';
  if (s >= 51) return 'Growing';
  if (s >= 26) return 'Early Stage';
  return 'Getting Started';
}

/**
 * computeDiscoverabilityScore
 * @param {Object} inputs
 * @param {string} [inputs.title] - pulled listing title
 * @param {string|number} inputs.reviewCount - pulled total ratings (approximation for Reviews & Ratings)
 * @param {string|number} [inputs.rating] - pulled star rating
 * @param {string} inputs.keywords - comma separated backend keywords, self-reported, up to 7
 * @param {string} [inputs.description] - listing/description text, pulled or author-written
 * @param {string} [inputs.category] - auto-detected category text
 * @param {number} [inputs.categoryCount] - number of categories the listing appears in, from SerpApi best_sellers_rank
 * @param {number} [inputs.bestsellerRank] - pulled bestseller rank number (category-specific, lowest-numbered entry)
 * @param {number} [inputs.storeWideRank] - Amazon's broadest/overall rank (ranks[0] from SerpApi), preferred over
 *   bestsellerRank for the Sales/mo estimate specifically, see the comment on scoreSalesPerMonth above
 * @param {string|number} [inputs.price] - pulled listing price
 * @param {string} [inputs.coverImage] - pulled cover image URL
 * @param {Object} [inputs.pageRank] - { position, keyword } from api/enrich-audit.js
 * @param {Array} [inputs.competitors] - competitor listings from api/enrich-audit.js, used for Price vs Niche only
 * @param {boolean} [inputs.amazonAdsActive] - self-reported, status pill only, contributes no points
 * @returns {{score: number, breakdown: Object}}
 */
function computeDiscoverabilityScore(inputs) {
  inputs = inputs || {};

  var listingPoints = scoreListing(inputs);
  var reviewsPoints = scoreReviewsRatings(inputs.reviewCount);
  var starPoints = scoreStarRating(inputs.rating);
  var salesRank = (typeof inputs.storeWideRank === 'number') ? inputs.storeWideRank : inputs.bestsellerRank;
  var sales = scoreSalesPerMonth(salesRank, inputs.price);
  var priceVsNiche = scorePriceVsNiche(inputs.price, inputs.competitors);

  var score = listingPoints + reviewsPoints + starPoints + sales.points + priceVsNiche.points;

  var breakdown = {
    listing: {
      label: 'Listing', points: listingPoints, max: 20, visible: 'bar',
      // Cached so the dashboard's Keywords tab can recompute the Listing
      // score after an add/remove without a fresh paid categoryCount pull
      // or a fresh paid SerpApi page-rank call every click. pageRank goes
      // stale if the author's primary keyword changes afterward, that's a
      // known, accepted tradeoff to keep re-scoring free, see
      // dashboard.html's keyword picker.
      categoryCount: (inputs.categoryCount !== undefined && inputs.categoryCount !== null) ? Number(inputs.categoryCount) : null,
      pageRank: inputs.pageRank || null
    },
    reviews: {
      label: 'Reviews & Ratings', points: reviewsPoints, max: 20, visible: 'bar',
      rawCount: Number(inputs.reviewCount) || 0, approximate: true
    },
    starRating: {
      label: 'Star Rating', points: starPoints, max: 20, visible: 'bar',
      rating: (inputs.rating !== undefined && inputs.rating !== null && inputs.rating !== '') ? Number(inputs.rating) : null
    },
    salesPerMonth: {
      label: 'Sales/mo', points: sales.points, max: 20, visible: 'milestone',
      estimatedRevenue: sales.estimatedRevenue,
      basis: (typeof inputs.storeWideRank === 'number') ? 'storeWideRank-estimate' : 'bsr-estimate'
    },
    priceVsNiche: {
      label: 'Price vs Niche', points: priceVsNiche.points, max: 20, visible: 'internal',
      nicheAvg: priceVsNiche.nicheAvg
    },
    amazonAds: {
      label: 'Amazon Ads', points: 0, max: 0, visible: 'pill',
      active: !!inputs.amazonAdsActive
    }
  };

  return { score: score, breakdown: breakdown, badge: scoreBadge(score) };
}
