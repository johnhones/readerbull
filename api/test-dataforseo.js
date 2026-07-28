// TEMPORARY test endpoint, not part of the product. Lets us check DataForSEO's
// Amazon Related Keywords data quality before wiring it into enrich-audit.js.
// Safe to delete once we've decided whether to keep using DataForSEO.
//
// GET /api/test-dataforseo?keyword=screen time parenting

module.exports = async function handler(req, res) {
  var login = process.env.DATAFORSEO_LOGIN;
  var password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    res.status(500).json({ error: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set' });
    return;
  }

  var keyword = (req.query && req.query.keyword) || 'screen time parenting';
  var cred = Buffer.from(login + ':' + password).toString('base64');

  try {
    var response = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/amazon/related_keywords/live', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + cred,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        {
          keyword: keyword.toLowerCase(),
          language_code: 'en',
          location_code: 2840,
          limit: 10,
          include_seed_keyword: true
        }
      ])
    });

    var data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'DataForSEO request failed', detail: String(err) });
  }
};
