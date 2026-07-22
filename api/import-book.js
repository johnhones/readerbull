// Vercel serverless function: looks up an Amazon book listing by ASIN or URL
// using SerpApi's Amazon Product API. Runs server-side only, so SERPAPI_KEY
// (a Vercel environment variable) is never exposed to the browser.
//
// POST { input: "<ASIN or Amazon URL>" }
// -> { asin, title, description, rating, reviewCount, price, extractedPrice,
//      coverImage, category, bestsellerRankText, amazonUrl }
// or -> { error: "..." } with a 4xx/5xx status.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var input = (req.body && req.body.input) || '';
  var asin = extractAsin(input);

  if (!asin) {
    res.status(400).json({ error: 'Could not find a valid Amazon ASIN in "' + input + '". Paste the ASIN itself or a full Amazon listing URL.' });
    return;
  }

  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
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

  var bestRank = null;
    ranks.forEach(function (r) {
      if (typeof r.extracted_rank === 'number' && (!bestRank || r.extracted_rank < bestRank.extracted_rank)) {
        bestRank = r;
      }
    });

  var coverImage = (product.thumbnails && product.thumbnails[0]) || product.thumbnail || null;

  res.status(200).json({
    asin: asin,
    title: product.title || null,
    description: product.description || null,
    rating: product.rating || details.rating || null,
    reviewCount: product.reviews || details.review || null,
    price: product.price || null,
    extractedPrice: product.extracted_price || null,
    coverImage: coverImage,
    category: bestRank ? (bestRank.link_text || bestRank.text) : null,
    bestsellerRank: bestRank ? bestRank.extracted_rank : null,
    bestsellerRankText: bestRank ? bestRank.text : null,
    amazonUrl: (data.search_metadata && data.search_metadata.amazon_product_url) || null
  });
  } catch (err) {
    res.status(502).json({ error: 'Amazon lookup failed, please try again.' });
  }
};

function extractAsin(input) {
  var trimmed = String(input || '').trim();
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  var match = trimmed.match(/\/(?:dp|gp\/product|ASIN)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}
