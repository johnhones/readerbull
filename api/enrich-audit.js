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
// POST { title, category, keywords, asin, price, rating, reviewCount,
//        bestsellerRank }
// -> { competitors: [...], pageRank: {...}, keywordResearch: {...}, narrative: {...} }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var input = req.body || {};
  var result = { competitors: [], pageRank: null, keywordResearch: null, narrative: null };

  var competitors = await findCompetitors(input);
  result.competitors = competitors;

  result.pageRank = await findPageRank(input);

  result.keywordResearch = await findKeywordResearch(input);

  var narrative = await generateNarrative(input, competitors);
  result.narrative = narrative;

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

// ---------- Keyword research (DataForSEO Amazon Related Keywords + Anthropic classification) ----------
// Two paid calls: one DataForSEO request for related keywords with
// volume, one Anthropic call to classify them the way the legacy
// dashboards were hand-built (Use/Skip on the full list, a curated
// Priority/Best Fit subset), since DataForSEO returns raw related terms
// with no relevance judgment of its own (it doesn't know this is a
// non-fiction reincarnation book vs a manga, for example).
async function findKeywordResearch(input) {
  var login = process.env.DATAFORSEO_LOGIN;
  var password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;

  // Build a short list of candidate seed terms to try, in order. Amazon's
  // real category names (pulled by import-book.js) are often formal browse
  // node labels like "Personal Transformation Self-Help" rather than
  // something a reader would actually type into search, and DataForSEO's
  // related-keywords endpoint returns zero results for a lot of those
  // (confirmed by a live test on 29 July 2026: "Personal Transformation
  // Self-Help" returned 0 items, but the simpler "self help" returned 30).
  // So try the category leaf first, and if that comes back empty, fall
  // back to the author's own primary backend keyword, which is a real
  // search-style phrase a human chose. Each attempt is the same flat-ish
  // DataForSEO cost, this only ever fires a second request on the rare
  // book where the first seed dead-ends, so it does not change normal
  // per-audit cost.
  var categorySeed = String(input.category || '').trim();
  if (categorySeed.indexOf('>') !== -1) {
    var segments = categorySeed.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    categorySeed = segments[segments.length - 1] || categorySeed;
  }
  var primaryKeywordSeed = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean)[0] || '';
  var titleSeed = String(input.title || '').trim();

  var candidates = [categorySeed, primaryKeywordSeed, titleSeed]
    .filter(Boolean)
    .filter(function (s, i, arr) { return arr.indexOf(s) === i; }); // dedupe, keep order
  if (!candidates.length) return null;

  var auth = Buffer.from(login + ':' + password).toString('base64');

  var items = [];
  var totalFound = 0;
  var seed = null;

  for (var c = 0; c < candidates.length; c++) {
    seed = candidates[c];
    try {
      var response = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/amazon/related_keywords/live', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + auth,
          'Content-Type': 'application/json'
        },
        // Cost control (tightened 29 July 2026): a 7-keyword KDP author
        // never needs 60 candidates, 30 is plenty of choice while keeping
        // the Anthropic classification step (which reads every keyword)
        // smaller and faster. DataForSEO itself barely notices the
        // difference, it is roughly a flat $0.01 per request plus $0.0001
        // per item, so 30 vs 60 items is a difference of about half a cent
        // per audit either way.
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
      if (!response.ok) continue;

      var task = data.tasks && data.tasks[0];
      var result = task && task.result && task.result[0];
      if (!result) continue;

      totalFound = result.total_count || (result.items ? result.items.length : 0);
      items = (result.items || []).map(function (it) {
        var kd = it.keyword_data || {};
        var info = kd.keyword_info || {};
        return { keyword: kd.keyword || null, volume: (typeof info.search_volume === 'number') ? info.search_volume : null };
      }).filter(function (it) { return it.keyword; });

      if (items.length) break; // this seed worked, stop trying further candidates
    } catch (err) {
      // try the next candidate seed
      continue;
    }
  }

  if (!items.length) return null;

  var classified = await classifyKeywords(input, seed, items);
  if (classified) {
    classified.totalFound = totalFound;
    classified.seedKeyword = seed;
    return classified;
  }

  // Classification failed (e.g. no Anthropic key), fall back to the raw
  // list with no Use/Skip judgment rather than losing the DataForSEO data
  // entirely, dashboard.html treats missing status as "Use".
  return {
    seedKeyword: seed,
    totalFound: totalFound,
    amazonKeywords: items.slice(0, 30).map(function (it) { return { keyword: it.keyword, volume: it.volume, status: 'Use' }; }),
    recommendedKeywords: []
  };
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
    'Respond with ONLY a JSON object, no markdown fences, no commentary, matching exactly this shape: ' +
    '{"amazonKeywords": [{"keyword": "...", "volume": <number or null>, "status": "Use"|"Skip"}], ' +
    '"recommendedKeywords": [{"keyword": "...", "volume": <number or null>, "status": "Priority"|"Best Fit"}]}. ' +
    'Include every keyword given to you exactly once in amazonKeywords, preserve the volume value given.';

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
        // Sized for up to 30 input keywords (see the limit in
        // findKeywordResearch above), comfortable margin without paying
        // for headroom that's no longer needed.
        max_tokens: 1200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the keyword research data:\n\n' + JSON.stringify(payload, null, 2) }
        ]
      })
    });

    var data = await response.json();
    if (!response.ok) return { _debugClassify: { httpStatus: response.status, body: data } };

    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    var parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { _debugClassify: { parseError: String(e && e.message || e), stopReason: data.stop_reason, textLength: text.length, textTail: text.slice(-300) } };
    }

    if (!parsed || !Array.isArray(parsed.amazonKeywords)) return { _debugClassify: { note: 'parsed but amazonKeywords not array', parsedKeys: parsed && Object.keys(parsed) } };
    parsed.recommendedKeywords = Array.isArray(parsed.recommendedKeywords) ? parsed.recommendedKeywords.slice(0, 8) : [];
    return parsed;
  } catch (err) {
    return { _debugClassify: { fetchError: String(err && err.message || err) } };
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
