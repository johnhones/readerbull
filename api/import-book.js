// Vercel serverless function: looks up an Amazon book listing by ASIN or URL
// using SerpApi's Amazon Product API. Runs server-side only, so SERPAPI_KEY
// (a Vercel environment variable) is never exposed to the browser.
//
// POST { input: "<ASIN or Amazon URL>" }
// -> { asin, title, description, rating, reviewCount, price, extractedPrice,
//      coverImage, category, categoryCount, bestsellerRankText, amazonUrl,
//      boughtTogether }
// or -> { error: "..." } with a 4xx/5xx status.
//
// boughtTogether rides along on this same call at no extra cost (see below),
// onboarding.html carries it through to api/enrich-audit.js at submit time,
// where findCompetitors prefers it over a fresh category search.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  var authToken = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, ''); if (!authToken) { res.status(401).json({ error: 'Please sign in again, your session could not be found.' }); return; } var authCheck = await fetch((process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co') + '/auth/v1/user', { headers: { apikey: 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm', Authorization: 'Bearer ' + authToken } }); if (!authCheck.ok) { res.status(401).json({ error: 'Your session has expired, please sign in again.' }); return; }

  var authToken = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, ''); if (!authToken) { res.status(401).json({ error: 'Please sign in again, your session could not be found.' }); return; } var authCheck = await fetch((process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co') + '/auth/v1/user', { headers: { apikey: 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm', Authorization: 'Bearer ' + authToken } }); if (!authCheck.ok) { res.status(401).json({ error: 'Your session has expired, please sign in again.' }); return; }

  var input = (req.body && req.body.input) || '';
  var asin = extractAsin(input);

  if (!asin) {
    res.status(400).json({ error: 'Could not find a valid Amazon ASIN in "' + input + '". Paste the ASIN itself or a full Amazon listing URL.' });
    return;
  }

  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    await sendErrorAlert('import-book', 'SERPAPI_KEY is missing in Vercel env vars, no imports can work until this is set.');
    res.status(500).json({ error: 'Import is not configured yet, SERPAPI_KEY is missing.' });
    return;
  }

  var serpUrl = 'https://serpapi.com/search.json?engine=amazon_product&asin=' +
    encodeURIComponent(asin) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);

  try {
    var response = await fetch(serpUrl);
    var data = await response.json();

    if (!response.ok || (data.search_metadata && data.search_metadata.status === 'Error')) {
      res.status(404).json({ error: (data && data.error) || 'Could not find that book on Amazon. Double check the ASIN or URL.' });
      return;
    }

    var product = data.product_results || {};
    var details = data.product_details || {};
    var ranks = details.best_sellers_rank || [];

    // Pick the strongest (lowest) rank across every category the book
    // shows up in, that's the category most worth surfacing as "category
    // fit" for the Discoverability Score, auto-picked, no author input.
    var bestRank = null;
    ranks.forEach(function (r) {
      if (typeof r.extracted_rank === 'number' && (!bestRank || r.extracted_rank < bestRank.extracted_rank)) {
        bestRank = r;
      }
    });

    var coverImage = (product.thumbnails && product.thumbnails[0]) || product.thumbnail || null;

    // "Frequently bought together" for this exact ASIN, when Amazon shows
    // it (SerpApi surfaces it as `bought_together` on the same amazon_product
    // call we're already making, so this costs nothing extra). Real
    // cross-purchase behaviour, this is a much more reliable "who is this
    // book actually competing with" signal than a broad category search,
    // confirmed by comparing it against a live case where category search
    // returned off-topic results (see api/enrich-audit.js findCompetitors).
    // Not every listing has this section, Amazon only shows it once enough
    // purchase-pattern data exists, so this is often empty for lower-volume
    // KDP titles.
    var boughtTogether = Array.isArray(data.bought_together)
      ? data.bought_together
          .filter(function (r) { return r && r.asin && r.title; })
          .slice(0, 5)
          .map(function (r) {
            return {
              title: r.title,
              asin: r.asin,
              rating: (typeof r.rating === 'number') ? r.rating : null,
              reviews: (typeof r.reviews === 'number') ? r.reviews : null,
              price: r.price || null
            };
          })
      : [];

    // Plain book listings rarely have a `product_results.description` field.
    // The real description text (Amazon's "A+ content") lives under the
    // top-level `product_description` block instead, as a list of feature
    // entries with their own text. Fall back to feature_bullets after that,
    // so the author always has real pulled text to start from rather than
    // an empty box they have to write from scratch.
    //
    // Known gap, confirmed by hand (ASIN B0F4L6TMDP, 28 July 2026): for at
    // least some Kindle eBook listings, SerpApi's amazon_product engine
    // returns no description anywhere in the payload at all (checked with
    // no_cache=true too, not a stale-cache issue), even though the listing
    // visibly has one on the real Amazon page. This isn't fixable by
    // reading a different field, the text simply isn't in SerpApi's
    // response for those listings. onboarding.html handles this by letting
    // the author type their own description when this comes back null.
    var descriptionParts = [];
    if (Array.isArray(data.product_description)) {
      data.product_description.forEach(function (block) {
        if (Array.isArray(block.features)) {
          block.features.forEach(function (f) {
            if (f && f.text) descriptionParts.push(f.text);
          });
        }
      });
    }

    var description = product.description
      || (descriptionParts.length ? descriptionParts.join('\n\n') : null)
      || (Array.isArray(product.feature_bullets) ? product.feature_bullets.join(' ') : null)
      || null;

    res.status(200).json({
      asin: asin,
      title: product.title || null,
      description: description,
      rating: product.rating || details.rating || null,
      reviewCount: product.reviews || details.review || null,
      price: product.price || null,
      extractedPrice: product.extracted_price || null,
      coverImage: coverImage,
      category: bestRank ? (bestRank.link_text || bestRank.text) : null,
      // How many categories this listing shows up in per SerpApi's
      // best_sellers_rank list, feeds the R27 Listing "number of
      // categories" sub-factor (scoring.js), 0-3 used, more than 3 capped
      // there.
      categoryCount: ranks.length,
      bestsellerRank: bestRank ? bestRank.extracted_rank : null,
      bestsellerRankText: bestRank ? bestRank.text : null,
      amazonUrl: (data.search_metadata && data.search_metadata.amazon_product_url) || null,
      boughtTogether: boughtTogether
    });
  } catch (err) {
    await sendErrorAlert('import-book', 'Amazon lookup threw an unexpected error: ' + (err && err.message ? err.message : String(err)));
    res.status(502).json({ error: 'Amazon lookup failed, please try again.' });
  }
};

function extractAsin(input) {
  var trimmed = String(input || '').trim();
  // bare ASIN pasted directly, e.g. B0H2CZYD6R
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  // full Amazon URL, e.g. .../dp/B0H2CZYD6R/ or .../gp/product/B0H2CZYD6R
  var match = trimmed.match(/\/(?:dp|gp\/product|ASIN)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

function sendErrorAlert(endpoint, detail) { var key = process.env.RESEND_API_KEY; if (!key) return Promise.resolve(); return fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Readerbull Alerts <alerts@readerbull.com>', to: ['coastlvibes@gmail.com'], subject: 'Readerbull error: ' + endpoint, text: detail + '\n\nTime: ' + new Date().toISOString() }) }).catch(function () {}); }
