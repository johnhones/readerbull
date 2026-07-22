/*
 * Readerbull Discoverability Score
 * -----------------------------------------------------------------------
 * Deterministic, rules-based scoring for the MVP audit. Every point is a
 * fixed rule tied to one input, no black box.
 *
 * As of Phase 1 (Amazon import), most inputs are pulled automatically from
 * the book's real Amazon listing via SerpApi instead of typed in by hand
 * (see ReaderBull_ARC_Roadmap.md). Authors onboarded the old, fully
 * self-reported way (see ReaderBull_MVP_Build_Plan.md) still score exactly
 * as before, this file supports both inputs shapes so existing scores
 * don't shift under anyone.
 *
 * Same four-part breakdown as always, out of 100:
 *   1. Reviews & Ratings   (max 40) - review count, nudged down a little
 *                                     when we have a real pulled rating
 *                                     and it's weak.
 *   2. Keyword Coverage    (max 30) - still self-reported and optional,
 *                                     Amazon never exposes an author's
 *                                     backend KDP keywords, 10 points per
 *                                     keyword, up to 3.
 *   3. Listing Setup       (max 15) - full marks automatically for any
 *                                     book that completed an Amazon
 *                                     import, since that only succeeds
 *                                     against a real, resolved listing.
 *   4. Category Fit        (max 15) - auto-detected category, graded by
 *                                     how strong the pulled bestseller
 *                                     rank is where we have one.
 */

function scoreReviews(reviewCount, rating) {
  var n = Number(reviewCount) || 0;
  var base;
  if (n >= 100) base = 40;
  else if (n >= 50) base = 30;
  else if (n >= 10) base = 20;
  else if (n >= 1) base = 10;
  else base = 0;

  // Where we have a real pulled rating, a weak rating pulls the score down
  // a little within the same bucket, it doesn't change the max achievable.
  if (rating !== undefined && rating !== null && rating !== '') {
    var r = Number(rating);
    if (r > 0 && r < 3) base = Math.min(base, 15);
    else if (r > 0 && r < 3.5) base = Math.min(base, 25);
  }
  return base;
}

function scoreKeywords(keywordsRaw) {
  var list = String(keywordsRaw || '')
    .split(',')
    .map(function (k) { return k.trim(); })
    .filter(Boolean);
  var count = Math.min(list.length, 3);
  return count * 10;
}

function scoreListing(inputs) {
  // Any book that completed an Amazon import has, by definition, a real
  // resolved listing, full marks. Legacy self-reported authors still score
  // on whether they typed in a plausible Amazon link.
  if (inputs.imported) return 15;
  var link = String(inputs.amazonLink || '').trim();
  if (!link) return 0;
  try {
    var url = new URL(link);
    if (/amazon\./i.test(url.hostname)) return 15;
  } catch (e) {
    // not a valid URL at all
  }
  return 0;
}

function scoreCategory(inputs) {
  var category = String(inputs.category || '').trim();
  if (!category) return 0;

  var rank = Number(inputs.bestsellerRank);
  if (!rank || rank <= 0) return 15; // legacy self-reported: binary, category known

  if (rank <= 100) return 15;
  if (rank <= 1000) return 12;
  if (rank <= 10000) return 9;
  if (rank <= 100000) return 6;
  return 3;
}

/**
 * computeDiscoverabilityScore
 * @param {Object} inputs
 * @param {string|number} inputs.reviewCount - review count, pulled or self-reported
 * @param {string|number} [inputs.rating] - pulled star rating, if available
 * @param {string} inputs.keywords - comma separated, always self-reported
 * @param {string} [inputs.amazonLink] - legacy self-reported listing link
 * @param {boolean} [inputs.imported] - true for books imported via Amazon URL/ASIN
 * @param {string} inputs.category - auto-detected or self-reported
 * @param {number} [inputs.bestsellerRank] - pulled bestseller rank number, if available
 * @returns {{score: number, breakdown: Object}}
 */
function computeDiscoverabilityScore(inputs) {
  inputs = inputs || {};

  var reviews = scoreReviews(inputs.reviewCount, inputs.rating);
  var keywords = scoreKeywords(inputs.keywords);
  var listing = scoreListing(inputs);
  var category = scoreCategory(inputs);

  var breakdown = {
    reviews: { label: 'Reviews & Ratings', points: reviews, max: 40 },
    keywords: { label: 'Keyword Coverage', points: keywords, max: 30 },
    listing: { label: 'Listing Setup', points: listing, max: 15 },
    category: { label: 'Category Fit', points: category, max: 15 }
  };

  var score = reviews + keywords + listing + category;

  return { score: score, breakdown: breakdown };
}
