/*
 * Readerbull Discoverability Score
 * -----------------------------------------------------------------------
 * Simple, deterministic, rules-based scoring for the MVP audit.
 * No black box: every point awarded is a fixed rule tied to one input.
 * Inputs come straight from the self-reported onboarding form, there is
 * no live Amazon data pulled in for the MVP (see ReaderBull_MVP_Build_Plan.md).
 *
 * Score is out of 100, split across four factors:
 *   1. Reviews & Ratings   (max 40) - reviews are the strongest ranking
 *                                     and trust signal on Amazon, so they
 *                                     carry the most weight.
 *   2. Keyword Coverage    (max 30) - 10 points per keyword supplied,
 *                                     up to 3 keywords.
 *   3. Listing Setup       (max 15) - a valid Amazon listing link is on
 *                                     file.
 *   4. Category Fit        (max 15) - the author has assigned a category,
 *                                     so we know what shelf they're
 *                                     competing on.
 */

function scoreReviews(reviewCount) {
  var n = Number(reviewCount) || 0;
  if (n >= 100) return 40;
  if (n >= 50) return 30;
  if (n >= 10) return 20;
  if (n >= 1) return 10;
  return 0;
}

function scoreKeywords(keywordsRaw) {
  var list = String(keywordsRaw || '')
    .split(',')
    .map(function (k) { return k.trim(); })
    .filter(Boolean);
  var count = Math.min(list.length, 3);
  return count * 10;
}

function scoreListing(amazonLink) {
  var link = String(amazonLink || '').trim();
  if (!link) return 0;
  try {
    var url = new URL(link);
    if (/amazon\./i.test(url.hostname)) return 15;
  } catch (e) {
    // not a valid URL at all
  }
  return 0;
}

function scoreCategory(category) {
  return String(category || '').trim() ? 15 : 0;
}

/**
 * computeDiscoverabilityScore
 * @param {Object} inputs
 * @param {string|number} inputs.reviewCount
 * @param {string} inputs.keywords - comma separated
 * @param {string} inputs.amazonLink
 * @param {string} inputs.category
 * @returns {{score: number, breakdown: Object}}
 */
function computeDiscoverabilityScore(inputs) {
  inputs = inputs || {};

  var reviews = scoreReviews(inputs.reviewCount);
  var keywords = scoreKeywords(inputs.keywords);
  var listing = scoreListing(inputs.amazonLink);
  var category = scoreCategory(inputs.category);

  var breakdown = {
    reviews: { label: 'Reviews & Ratings', points: reviews, max: 40 },
    keywords: { label: 'Keyword Coverage', points: keywords, max: 30 },
    listing: { label: 'Listing Setup', points: listing, max: 15 },
    category: { label: 'Category Fit', points: category, max: 15 }
  };

  var score = reviews + keywords + listing + category;

  return { score: score, breakdown: breakdown };
}
