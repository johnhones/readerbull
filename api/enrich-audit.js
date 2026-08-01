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
// Standing rule (ReaderBull_Project_Rules.md, rule 12): keyword research
// must never come back empty. findKeywordResearch tries category, then the
// author's own keyword, then the book title against DataForSEO; if all of
// those dead-end (or there was nothing to try), it asks Claude to guess two
// natural shopper-style search phrases and retries with those before giving
// up. This adds at most one extra cheap Anthropic call, only on the rare
// book where every mechanical seed fails.
//
// POST { title, category, keywords, asin, price, rating, reviewCount,
//        bestsellerRank, boughtTogether }
// -> { competitors: [...], pageRank: {...}, keywordResearch: {...}, narrative: {...} }
//
// Competitor accuracy fix (29 July 2026): findCompetitors now prefers
// boughtTogether (Amazon's own "frequently bought together" data for this
// exact ASIN, passed through from api/import-book.js where it was pulled
// for free on the same call already made at import time) over a fresh
// SerpApi category search. This fixes a confirmed live bug where a broad
// or formal Amazon category (e.g. a cannabis cookbook categorised under
// general cooking) returned generic, off-topic competitors. When
// boughtTogether is empty (not every listing has it), falls back to the
// same seed-fallback pattern already proven for findKeywordResearch:
// category leaf, then the author's own primary keyword, then the book
// title, then an AI-guessed shopper phrase as a last resort.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var authToken = ((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, ''); if (!authToken) { res.status(401).json({ error: 'Please sign in again, your session could not be found.' }); return; } var authCheck = await fetch((process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co') + '/auth/v1/user', { headers: { apikey: 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm', Authorization: 'Bearer ' + authToken } }); if (!authCheck.ok) { res.status(401).json({ error: 'Your session has expired, please sign in again.' }); return; }

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

// ---------- Competitor discovery ----------
// Preferred source: Amazon's own "bought together" data for this exact
// ASIN (see boughtTogether comment near the top of this file), zero extra
// paid calls since it was already pulled at import time. Only when that's
// empty do we fall back to a fresh SerpApi Amazon Search call, using the
// same category/keyword/title/AI-seed fallback chain as
// findKeywordResearch below, since the root cause (a formal or overly
// broad category label) is identical for both.
async function findCompetitors(input) {
  var ownAsin = (input.asin || '').toUpperCase();

  var boughtTogether = Array.isArray(input.boughtTogether) ? input.boughtTogether : [];
  var fromBoughtTogether = boughtTogether
    .filter(function (r) { return r && r.asin && r.title && r.asin.toUpperCase() !== ownAsin; })
    .slice(0, 5)
    .map(function (r, i) {
      return {
        title: r.title,
        asin: r.asin,
        rating: r.rating || null,
        reviews: r.reviews || null,
        price: r.price || null,
        sponsored: false,
        position: i + 1
      };
    });
  if (fromBoughtTogether.length) return fromBoughtTogether;

  var apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];

  var categorySeed = String(input.category || '').trim();
  if (categorySeed.indexOf('>') !== -1) {
    var segments = categorySeed.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    categorySeed = segments[segments.length - 1] || categorySeed;
  }
  var primaryKeywordSeed = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean)[0] || '';
  var titleSeed = String(input.title || '').trim();

  var mechanicalCandidates = [categorySeed, primaryKeywordSeed, titleSeed]
    .filter(Boolean)
    .filter(function (s, i, arr) { return arr.indexOf(s) === i; });

  var found = await trySerpApiCompetitorCandidates(mechanicalCandidates, apiKey, ownAsin);

  if (!found.length) {
    var aiSeeds = await generateSearchSeeds(input);
    if (aiSeeds.length) found = await trySerpApiCompetitorCandidates(aiSeeds, apiKey, ownAsin);
  }

  return found;
}

// Tries each candidate search term against SerpApi's Amazon Search engine
// in order, stops at the first one that returns at least one real
// (non-own-ASIN, titled) result. Mirrors tryDataForSeoCandidates below.
async function trySerpApiCompetitorCandidates(candidates, apiKey, ownAsin) {
  for (var c = 0; c < candidates.length; c++) {
    var query = candidates[c];
    if (!query) continue;

    var url = 'https://serpapi.com/search.json?engine=amazon&k=' +
      encodeURIComponent(query) + '&amazon_domain=amazon.com&api_key=' + encodeURIComponent(apiKey);

    try {
      var response = await fetch(url);
      var data = await response.json();
      if (!response.ok) continue;

      var results = Array.isArray(data.organic_results) ? data.organic_results : [];
      var mapped = results
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

      if (mapped.length) return mapped;
    } catch (err) {
      continue;
    }
  }
  return [];
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

  var auth = Buffer.from(login + ':' + password).toString('base64');

  // Build a short list of mechanical candidate seed terms to try, in order.
  // Amazon's real category names (pulled by import-book.js) are often formal
  // browse node labels like "Personal Transformation Self-Help" rather than
  // something a reader would actually type into search, and DataForSEO's
  // related-keywords endpoint returns zero results for a lot of those
  // (confirmed live 29 July 2026: "Personal Transformation Self-Help"
  // returned 0 items, "self help" returned 30). So try the category leaf
  // first, then the author's own primary backend keyword if they gave one,
  // then the book title as a last mechanical option.
  var categorySeed = String(input.category || '').trim();
  if (categorySeed.indexOf('>') !== -1) {
    var segments = categorySeed.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    categorySeed = segments[segments.length - 1] || categorySeed;
  }
  var primaryKeywordSeed = String(input.keywords || '').split(',').map(function (k) { return k.trim(); }).filter(Boolean)[0] || '';
  var titleSeed = String(input.title || '').trim();

  var mechanicalCandidates = [categorySeed, primaryKeywordSeed, titleSeed]
    .filter(Boolean)
    .filter(function (s, i, arr) { return arr.indexOf(s) === i; }); // dedupe, keep order

  var found = await tryDataForSeoCandidates(mechanicalCandidates, auth);

  // Standing rule (ReaderBull_Project_Rules.md, rule 12): keyword research
  // must never come back empty to the author. If every mechanical seed
  // (category, author keyword, title) failed to return anything, or there
  // was no author keyword to try at all, ask Claude to guess a couple of
  // short, natural phrases a reader would actually type into Amazon search
  // for a book like this, then retry with those. One extra cheap AI call
  // (well under a cent), it only fires on the book where every mechanical
  // seed dead-ends, confirmed live 29 July 2026 this happens for real
  // (a book categorised "Medical Child Psychology" with no author keyword).
  if (!found.items.length) {
    var aiSeeds = await generateSearchSeeds(input);
    if (aiSeeds.length) {
      found = await tryDataForSeoCandidates(aiSeeds, auth);
    }
  }

  if (!found.items.length) return null;

  var classified = await classifyKeywords(input, found.seed, found.items);
  if (classified) {
    classified.totalFound = found.totalFound;
    classified.seedKeyword = found.seed;
    return classified;
  }

  // Classification failed (e.g. no Anthropic key), fall back to the raw
  // list with no Use/Skip judgment rather than losing the DataForSEO data
  // entirely, dashboard.html treats missing status as "Use".
  return {
    seedKeyword: found.seed,
    totalFound: found.totalFound,
    amazonKeywords: found.items.slice(0, 30).map(function (it) { return { keyword: it.keyword, volume: it.volume, status: 'Use' }; }),
    recommendedKeywords: []
  };
}

// Tries each candidate seed against DataForSEO in order, stops at the first
// one that returns at least one keyword. Shared by the mechanical-candidate
// pass and the AI-guessed-candidate pass in findKeywordResearch above.
async function tryDataForSeoCandidates(candidates, auth) {
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

  return { items: items, totalFound: totalFound, seed: seed };
}

// Last-resort seed guesser (ReaderBull_Project_Rules.md, rule 12). Asks
// Claude to think like a shopper, not a librarian: short, natural search
// phrases rather than the formal Amazon category label or the literal book
// title, both of which have been confirmed live to return zero DataForSEO
// results for some real books.
async function generateSearchSeeds(input) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  var systemPrompt =
    'You help find real Amazon search phrases for a self-published book, for a keyword data ' +
    'tool that only returns results for short, broad, high-traffic search terms, not specific ' +
    'or sentence-like phrases. Given the book\'s title, category and description, suggest 3 ' +
    'short search terms, ordered from broadest to narrowest: 1 to 2 words, then 2 words, then ' +
    'up to 3 words. Every term must read exactly like something typed into a search bar, not a ' +
    'description of the book. Good examples: "screen time", "self help", "habit tracker", ' +
    '"meal prep", "anxiety relief". Bad examples, too long or too sentence-like: "kids screen ' +
    'time dangers", "smartphone effects on children", "how to build better habits". Do not ' +
    'repeat the book title, and do not repeat the formal Amazon category label verbatim if it ' +
    'reads like a stiff catalogue term. Each of the 3 terms should cover a different angle on ' +
    'the book\'s topic, but all three must stay short and broad, favour a common everyday word ' +
    'over a precise one every time there is a choice. ' +
    'Respond with ONLY compact JSON on one line, no markdown fences, no commentary, no ' +
    'indentation, matching exactly this shape: {"seeds": ["term one", "term two", "term three"]}.';

  var payload = {
    title: input.title || null,
    category: input.category || null,
    description: (input.description || '').slice(0, 500) || null
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
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the book:\n\n' + JSON.stringify(payload, null, 2) }
        ]
      })
    });

    var data = await response.json();
    if (!response.ok) return [];

    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();

    var parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return [];
    }

    if (!parsed || !Array.isArray(parsed.seeds)) return [];
    return parsed.seeds.map(function (s) { return String(s || '').trim(); }).filter(Boolean).slice(0, 3);
  } catch (err) {
    return [];
  }
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
    'Include every keyword given to you exactly once in amazonKeywords, preserve the volume value given. ' +
    'Output MINIFIED JSON on a single line, no indentation, no line breaks, no extra spaces, this keeps ' +
    'the response short enough to never get cut off.';

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
        // 2000 with a minified-JSON instruction (see systemPrompt above):
        // the earlier 1200 cap was getting hit mid-response because the
        // model was pretty-printing the JSON with indentation, which
        // burns 2-3x the tokens of compact JSON, confirmed live on 29
        // July 2026 (stop_reason "max_tokens", parse error on truncated
        // output). Telling it to minify fixes the root cause; this higher
        // cap is just a safety margin so a slightly verbose response
        // still completes instead of silently losing the Recommended list.
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: 'Here is the keyword research data:\n\n' + JSON.stringify(payload, null, 2) }
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

    if (!parsed || !Array.isArray(parsed.amazonKeywords)) return null;
    parsed.recommendedKeywords = Array.isArray(parsed.recommendedKeywords) ? parsed.recommendedKeywords.slice(0, 8) : [];
    return parsed;
  } catch (err) {
    return null;
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
      discoverabilityScore: input.score || null,
      // Added 29 July 2026 (content-quality rewrite, see
      // ReaderBull_Next_Chat_Handover_Prompt.md item 8) so the prompt can
      // gate the paid-ads and portfolio-expansion recommendations below on
      // real data rather than guessing.
      amazonAdsActive: !!input.amazonAdsActive,
      authorBookCount: (typeof input.authorBookCount === 'number') ? input.authorBookCount : null
    },
    scoreBreakdown: breakdown,
    competitors: competitors
  };

  // Content-quality rewrite, 29 July 2026 (ReaderBull_Next_Chat_Handover_Prompt.md
  // item 8, all points below confirmed directly with John): removes the
  // off-platform review-trust angle (Amazon is a closed marketplace, authors
  // can't reference their own reviews off it), demotes "price justifies
  // value" out of the top 3, adds a review-count-gated (15+) paid-ads
  // recommendation with concrete guidance rather than "you should run ads",
  // adds a single-book portfolio-expansion idea, softens the backend-keyword
  // assumption to "if you haven't already", and points the reviews
  // recommendation at Readerbull's own Build Your ARC tool (free to start,
  // reciprocal) instead of emailing readers or naming an external ARC site.
  var systemPrompt =
    'You write the Market Analysis, Marketing Strategy and Quick Wins content for Readerbull, ' +
    'a platform that helps self-published authors sell more books. You are writing for one specific ' +
    'author about their one specific book, using only the structured data given to you below. ' +
    'Never invent competitor names, numbers, ranks, prices or reviews beyond what is in the data. ' +
    'If a field is missing, write around it honestly rather than guessing. Use British spelling ' +
    '(optimise, personalise, recognise). Never use the em dash character. Keep the tone direct, ' +
    'encouraging and specific, not generic SaaS filler. ' +
    'Data-gating principle: only make a recommendation whose credibility depends on a specific data ' +
    'threshold if the book\'s own data actually supports it. Never suggest leveraging review volume, ' +
    'reviews as a trust signal, or building authority with hesitant buyers off Amazon\'s own platform, ' +
    'Amazon is a closed marketplace and authors cannot meaningfully reference their own reviews ' +
    'anywhere else. Apply this same gating logic to any other recommendation whose credibility ' +
    'depends on the book already having a certain amount of data behind it. ' +
    'Paid Amazon Ads: if book.amazonAdsActive is false, always include a paid-ads recommendation ' +
    'somewhere in strategySteps. It only qualifies for a guaranteed top-3 quickWins placement once ' +
    'book.reviewCount is 15 or more, below that threshold other quick wins (such as building reviews ' +
    'first) may rank above it. When you recommend ads, give concrete, actionable guidance rather than ' +
    'just "you should run ads": suggest a modest starting daily budget range, a target ACoS ' +
    '(advertising cost of sale) ceiling to judge profitability, targeting the book\'s own keywords plus ' +
    '(only if competitor data is given) Sponsored Display against those specific competitor ASINs, and ' +
    'a short review-and-adjust timeframe (for example 14 days) before scaling spend. ' +
    'Price vs value: "price justifies value" is a valid angle but must never be one of the top 3 most ' +
    'prominent points across marketAnalysis, strategySteps or quickWins combined, rank it further down ' +
    'if you use it at all. ' +
    'Reviews: if book.reviewCount is below 15, recommend the author launch or grow their Build Your ARC ' +
    'campaign (Readerbull\'s own built-in tool, found under Tools in the sidebar) to reach opted-in ' +
    'readers for honest reviews, it is free to start and reciprocal: the more an author reads and ' +
    'reviews other authors\' books through it, the more they get back for their own book. Never suggest ' +
    'emailing or messaging existing readers/reviewers directly to ask for reviews, and never name any ' +
    'external ARC or review-swap service. ' +
    'Backend keywords: never assume the author has already filled in their 7 KDP backend keyword ' +
    'fields. Phrase any related advice as "if you haven\'t already" rather than assuming they\'re ' +
    'already populated, since we don\'t actually know their KDP backend state. ' +
    'Portfolio angle: if book.authorBookCount is exactly 1, consider including a quickWin or strategy ' +
    'step suggesting the author think about a second, related title, since a second book compounds ' +
    'discoverability (cross-sell, a new keyword footprint, a new category placement). Do not suggest ' +
    'this if authorBookCount is missing, null, or greater than 1. ' +
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
