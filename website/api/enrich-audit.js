// Vercel serverless function: builds the "deep" audit content for the
// native dashboard, real competitor data plus a narrative write-up, so the
// automated Market Analysis / Marketing Strategy / Quick Wins panels can
// match the depth of the legacy hand-built dashboards.
//
// Runs once, at onboarding submit time, and the result is stored on the
// books row (competitors_json, audit_narrative_json), not recomputed on
// every dashboard view. Two paid calls per audit: one SerpApi Amazon
// search (competitor discovery) and one Anthropic Messages call
// (narrative). If either fails, this returns whatever it could get rather
// than erroring the whole submit, dashboard.html falls back to its
// existing lighter-weight rendering when a field is missing.
//
// Deliberately does NOT attempt keyword search-volume data, no reliable
// source is wired in yet, see ReaderBull_ARC_Roadmap.md.
//
// POST { title, category, keywords, asin, price, rating, reviewCount,
//        bestsellerRank, score, breakdown }
// -> { competitors: [...], narrative: {...} }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var input = req.body || {};
  var result = { competitors: [], narrative: null };

  var competitors = await findCompetitors(input);
  result.competitors = competitors;

  var narrative = await generateNarrative(input, competitors);
  result.narrative = narrative;

  // Always 200: this is a best-effort enrichment step, a partial or empty
  // result still lets the submit flow continue and store what it got.
  res.status(200).json(result);
};

// ---------- Competitor discovery (SerpApi Amazon Search) ----------
async function findCompetitors(input) {
  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  var query = (input.category || input.title || '').trim();
  if (!query) return [];

  var url = 'https://serpapi.com/search.json?engine=amazon&k=' +
    encodeURIComponent(query) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);

  try {
    var response = await fetch(url);
    var data = await response.json();
    if (!response.ok) return [];

    var results = Array.isArray(data.organic_results) ? data.organic_results : [];
    var ownAsin = (input.asin || '').toUpperCase();

    return results
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
  } catch (err) {
    return [];
  }
}

// ---------- Narrative generation (Anthropic Messages API) ----------
async function generateNarrative(input, competitors) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  var breakdown = input.breakdown || {};
  var payload = {
    book: {
      title: input.title || null,
      category: input.category || null,
      price: input.price || null,
      rating: input.rating || null,
      reviewCount: input.reviewCount || null,
      bestsellerRank: input.bestsellerRank || null,
      keywords: input.keywords || null,
      discoverabilityScore: input.score || null
    },
    scoreBreakdown: breakdown,
    competitors: competitors
  };

  var systemPrompt =
    'You write the Market Analysis, Marketing Strategy and Quick Wins content for Readerbull, ' +
    'a platform that helps self-published authors sell more books. You are writing for one specific ' +
    'author about their one specific book, using only the structured data given to you below. ' +
    'Never invent competitor names, numbers, ranks, prices or reviews beyond what is in the data. ' +
    'If a field is missing, write around it honestly rather than guessing. Use British spelling ' +
    '(optimise, personalise, recognise). Never use the em dash character. Keep the tone direct, ' +
    'encouraging and specific, not generic SaaS filler. ' +
    'Respond with ONLY a JSON object, no markdown fences, no commentary, matching exactly this shape: ' +
    '{"bookInsight": "one bolded-worthy sentence summarising the single biggest takeaway", ' +
    '"marketAnalysis": "2-3 short paragraphs on where this book stands versus the competitors given", ' +
    '"strategySteps": [{"title": "short step title", "body": "1-2 sentences, specific to this book\'s data"}], ' +
    '"quickWins": [{"title": "short action title", "body": "1-2 sentences on why this is the next best move"}]}. ' +
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
        max_tokens: 1200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the structured audit data:\n\n' + JSON.stringify(payload, null, 2) }
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

    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    return null;
  }
}
