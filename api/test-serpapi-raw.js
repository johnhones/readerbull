// TEMPORARY test endpoint, not part of the product. Dumps the FULL raw
// SerpApi amazon_product response so we can check field coverage against
// the R27 Discoverability Score formula before rewriting scoring.js.
// Safe to delete once the data-availability check is done.
//
// GET /api/test-serpapi-raw?asin=B0F4L6TMDP

module.exports = async function handler(req, res) {
  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'SERPAPI_KEY not set' });
    return;
  }

  var asin = (req.query && req.query.asin) || '';
  if (!asin) {
    res.status(400).json({ error: 'Pass ?asin=' });
    return;
  }

  var url = 'https://serpapi.com/search.json?engine=amazon_product&asin=' +
    encodeURIComponent(asin) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);

  try {
    var response = await fetch(url);
    var data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'SerpApi request failed', detail: String(err) });
  }
};
