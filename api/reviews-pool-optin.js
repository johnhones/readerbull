// Vercel serverless function: opt a book into (or out of) the Reciprocal
// Reviews pool (Track A of Get Reviews — see ReaderBull_Review_System_Scoping.md).
//
// POST { bookId, active, cleanContentOnly }
// -> { entry: {...} } or -> { error: "..." } with a 4xx/5xx status.
//
// A book can only be opted in once it has a manuscript_url (RLS enforces
// this on insert too, but this checks first so the error message is
// readable instead of a raw Postgres/RLS denial). Re-opting-in an
// already-existing entry updates active/cleanContentOnly rather than
// erroring, so the dashboard toggle can call this endpoint either way
// without needing to know if a row already exists.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

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
  var authCheck = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + authToken }
  });
  if (!authCheck.ok) {
    res.status(401).json({ error: 'Your session has expired, please sign in again.' });
    return;
  }
  var authUser = await authCheck.json();

  var bookId = req.body && req.body.bookId;
  var active = !!(req.body && req.body.active);
  var cleanContentOnly = !!(req.body && req.body.cleanContentOnly);
  if (!bookId) {
    res.status(400).json({ error: 'Missing bookId.' });
    return;
  }

  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + authToken,
    'Content-Type': 'application/json'
  };

  // Confirm this book belongs to the caller and has a manuscript uploaded,
  // before touching review_pool_entries at all.
  var bookResp = await fetch(
    SUPABASE_URL + '/rest/v1/books?select=id,user_id,manuscript_url,book_title&id=eq.' + encodeURIComponent(bookId),
    { headers: headers }
  );
  if (!bookResp.ok) {
    res.status(502).json({ error: 'Could not look up that book right now, please try again.' });
    return;
  }
  var books = await bookResp.json();
  var book = books && books[0];
  if (!book || book.user_id !== authUser.id) {
    res.status(404).json({ error: 'Book not found.' });
    return;
  }
  if (active && !book.manuscript_url) {
    res.status(400).json({
      error: 'Upload a manuscript PDF for "' + (book.book_title || 'this book') +
        '" first (from your dashboard) before adding it to Reciprocal Reviews.'
    });
    return;
  }

  // Does a pool entry already exist for this book?
  var existingResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=id&book_id=eq.' + encodeURIComponent(bookId),
    { headers: headers }
  );
  var existing = existingResp.ok ? await existingResp.json() : [];

  var entry, saveResp;
  if (existing && existing[0]) {
    saveResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_pool_entries?id=eq.' + encodeURIComponent(existing[0].id),
      {
        method: 'PATCH',
        headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
        body: JSON.stringify({ active: active, clean_content_only: cleanContentOnly })
      }
    );
  } else {
    saveResp = await fetch(SUPABASE_URL + '/rest/v1/review_pool_entries', {
      method: 'POST',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        book_id: bookId,
        user_id: authUser.id,
        active: active,
        clean_content_only: cleanContentOnly
      })
    });
  }

  if (!saveResp.ok) {
    var errBody = await saveResp.text();
    res.status(502).json({ error: 'Could not save your pool settings right now, please try again.', detail: errBody });
    return;
  }
  var saved = await saveResp.json();
  entry = saved && saved[0];

  res.status(200).json({ entry: entry });
};
