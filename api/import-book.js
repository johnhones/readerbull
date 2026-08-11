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
//
// Rate limiting (3 August 2026): on top of the existing session check
// below, this now also caps each signed-in author at MAX_PER_HOUR calls,
// backed by the api_call_log table, see api/_auth.js.

var rateLimit = require('./_auth');
var MAX_PER_HOUR = 30;

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

  var withinLimit = await rateLimit.checkRateLimit({ userId: authUser.id, token: authToken }, 'import-book', MAX_PER_HOUR);
  if (!withinLimit) {
    res.status(429).json({ error: 'Too many import requests, please wait a bit and try again.' });
    return;
  }

  var input = (req.body && req.body.input) || '';
  var asin = await resolveAsin(input);

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

    // Store-wide rank, separate from bestRank above (fixed 4 August 2026,
    // scoped after John flagged the missing Book Summary panel and a
    // question about why the old niche-revenue stat card had been pulled).
    // Amazon lists best_sellers_rank broadest-first on the real product
    // page: the top-level store rank (e.g. "#45,231 in Books") comes
    // before any narrower subcategory rank (e.g. "#12 in Near-Death
    // Experiences"), confirmed against SerpApi's own documented example
    // ("#129 in Grocery & Gourmet Food" listed before "#1 in Ground
    // Coffee"). bestRank above deliberately picks the LOWEST number across
    // the whole array, which is correct for "category fit" but almost
    // always lands on a narrow subcategory, not the store-wide rank. A
    // BSR-to-sales curve needs the store-wide rank specifically, using
    // bestRank for that produced a wildly inflated revenue figure before
    // (see the removal note in api/enrich-audit.js, 4 August 2026). ranks[0]
    // is the fix: the first entry Amazon lists is always the broadest one.
    var storeWideRankEntry = ranks[0] || null;
    var storeWideRank = (storeWideRankEntry && typeof storeWideRankEntry.extracted_rank === 'number')
      ? storeWideRankEntry.extracted_rank
      : null;

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
    // `product_description` (Amazon's A+ content) and `about_item`/
    // `feature_bullets` (the generic "About this item" bullets most
    // physical/grocery products show) are cheap to check first since
    // they're already sitting in this same response, so try those before
    // paying for an extra fetch below.
    var descriptionParts = [];
    if (Array.isArray(data.product_description)) {
      data.product_description.forEach(function (block) {
        if (block && block.text) descriptionParts.push(block.text);
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
      || (Array.isArray(data.about_item) && data.about_item.length ? data.about_item.join(' ') : null)
      || null;

    // Real fix (11 August 2026), replacing the 28 July/3 August diagnostic
    // effort below. Confirmed by hand across 6 live listings (Kindle,
    // Paperback and Hardcover, including two of John's own books and two
    // outside bestsellers, Atomic Habits and The Let Them Theory): none of
    // the fields above are where Amazon actually puts a book's synopsis.
    // That text lives in its own dedicated section of the listing page,
    // Amazon's `#bookDescription_feature_div` block, a book-category
    // fixture, separate from A+ content and separate from the generic
    // "About this item" bullets, which is why the fields above kept
    // coming back empty regardless of format. SerpApi doesn't parse that
    // section into a JSON field, but every amazon_product call already
    // includes a link to the raw HTML page it scraped
    // (search_metadata.raw_html_file), retrieving it costs no extra
    // SerpApi search credit, so when nothing above found real text, pull
    // the description out of that page ourselves instead of asking the
    // author to retype something that genuinely exists on the real
    // listing.
    if (!description && data.search_metadata && data.search_metadata.raw_html_file) {
      description = await extractBookDescriptionFromHtml(data.search_metadata.raw_html_file, apiKey);
    }

    // Format availability (3 August 2026): confirmed live that SerpApi's
    // top-level `prices` array lists every format Amazon shows a buy box
    // for on this listing (Kindle, Paperback, Hardcover, Audiobook), each
    // with its own title and price. Not the same as product_results,
    // which only reflects whichever format the search matched. Feeds the
    // Overview "Professional Assessment" tag pills (dashboard.html), no
    // extra paid call, this was already sitting unused in the same
    // response every import already makes.
    // Confirmed live 4 August 2026: some listings carry two `prices`
    // entries with the same format title (e.g. two separate "Paperback"
    // rows for different bindings/sellers), which produced a duplicate
    // "Paperback & Paperback" tag before this dedupe was added.
    var formats = Array.isArray(data.prices)
      ? data.prices.map(function (p) { return p && p.title; }).filter(Boolean)
        .filter(function (f, i, arr) { return arr.indexOf(f) === i; })
      : [];

    // A+ Content presence (3 August 2026): SerpApi has no explicit "A+
    // content live" boolean, confirmed live by inspecting the raw
    // response. The closest honest proxy is whether Amazon's
    // product_description block (the enhanced-content module A+ listings
    // use) came back non-empty, same signal already used for the
    // description fallback above. Treated as a proxy, not a confirmed
    // fact, dashboard.html should word this as "content" rather than
    // certainty if it can't be confirmed another way.
    var hasEnhancedContent = descriptionParts.length > 0;

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
      storeWideRank: storeWideRank,
      storeWideRankText: storeWideRankEntry ? storeWideRankEntry.text : null,
      amazonUrl: (data.search_metadata && data.search_metadata.amazon_product_url) || null,
      boughtTogether: boughtTogether,
      formats: formats,
      hasEnhancedContent: hasEnhancedContent
    });
  } catch (err) {
    await sendErrorAlert('import-book', 'Amazon lookup threw an unexpected error: ' + (err && err.message ? err.message : String(err)));
    res.status(502).json({ error: 'Amazon lookup failed, please try again.' });
  }
};

// Amazon's mobile app "Share" button (and some desktop share links) don't
// hand out a normal /dp/ or /gp/product/ URL, they hand out a shortened
// redirect link instead: amzn.eu/d/xxxxxxxx, amzn.to/xxxxxxxx, a.co/d/xxxxxxxx.
// The token after /d/ isn't an ASIN, it's a short-link code, so extractAsin
// never matches it and every mobile-app share link failed to import. Fixed
// by following the redirect server-side first (fetch() follows redirects by
// default and response.url is the final, real Amazon listing URL), then
// running the normal extraction on that resolved URL. Confirmed against
// https://amzn.eu/d/03aL2ssM, 1 August 2026.
async function resolveAsin(input) {
  var asin = extractAsin(input);
  if (asin) return asin;

  var trimmed = String(input || '').trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  try {
    var resolved = await fetch(trimmed, { method: 'GET', redirect: 'follow' });
    return extractAsin(resolved.url || '');
  } catch (err) {
    return null;
  }
}

// Pulls the real book synopsis out of Amazon's own listing HTML, see the
// long comment where this is called from for why this exists. No HTML
// parser library is available in this project (no package.json, kept
// dependency-free deliberately), so this walks the tags by hand: find
// Amazon's #bookDescription_feature_div, count nested <div> tags to find
// its true matching closing tag (a naive "stop at the next </div>" would
// truncate at the first nested div instead of the whole block), then
// strip markup down to plain text.
async function extractBookDescriptionFromHtml(rawHtmlUrl, apiKey) {
  try {
    var sep = rawHtmlUrl.indexOf('?') === -1 ? '?' : '&';
    var resp = await fetch(rawHtmlUrl + sep + 'api_key=' + encodeURIComponent(apiKey));
    if (!resp.ok) return null;
    var html = await resp.text();

    var marker = html.indexOf('id="bookDescription_feature_div"');
    if (marker === -1) return null;
    var divStart = html.lastIndexOf('<div', marker);
    if (divStart === -1) return null;

    var tagRegex = /<div\b[^>]*>|<\/div>/gi;
    tagRegex.lastIndex = divStart;
    var depth = 0;
    var divEnd = -1;
    var match;
    while ((match = tagRegex.exec(html))) {
      if (match[0].charAt(1) === '/') {
        depth--;
        if (depth === 0) { divEnd = match.index + match[0].length; break; }
      } else {
        depth++;
      }
    }
    if (divEnd === -1) return null;

    var text = html.slice(divStart, divEnd)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    // Guards against an empty/near-empty match on one side, and an
    // absurdly long one (parsing gone wrong) on the other.
    if (text.length < 20) return null;
    return text.slice(0, 3000);
  } catch (err) {
    return null;
  }
}

function extractAsin(input) {
  var trimmed = String(input || '').trim();
  // bare ASIN pasted directly, e.g. B0H2CZYD6R
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  // full Amazon URL, e.g. .../dp/B0H2CZYD6R/ or .../gp/product/B0H2CZYD6R
  var match = trimmed.match(/\/(?:dp|gp\/product|ASIN)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
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
