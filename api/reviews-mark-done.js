// Vercel serverless function: reviewer marks a Reciprocal Reviews
// assignment as completed, after leaving their honest review (with the
// required ARC disclosure line) on Amazon.
//
// POST { assignmentId }
// -> { assignment: {...} } or -> { error: "..." }
//
// This is the honesty-based "mark as done" described in
// ReaderBull_Review_System_Scoping.md Section 8 — ReaderBull has no Amazon
// API access to verify the review was actually posted at indie scale, same
// as Bookblaze and BookVillage. Completing this is what credits the
// reviewer's own book(s) with an available slot (see the arithmetic in
// api/reviews-browse.js's docblock).

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

// Fixed safety turnaround: reviews can't be marked done until this many
// days after the assignment was made. Posting a wave of reviews the same
// day they're claimed is exactly the pattern Amazon's abuse detection
// watches for — this protects reviewer accounts, matching the mechanic
// BookVillage documents publicly (their window is day 5 through day 7).
// Added 17 August 2026 per direct user instruction; applies to every
// assignment regardless of how the book was offered.
var MIN_WAIT_DAYS = 5;

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
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + authToken,
    'Content-Type': 'application/json'
  };

  var assignmentId = req.body && req.body.assignmentId;
  if (!assignmentId) {
    res.status(400).json({ error: 'Missing assignmentId.' });
    return;
  }

  var existingResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id,reviewer_id,status,assigned_at&id=eq.' + encodeURIComponent(assignmentId),
    { headers: headers }
  );
  var existingRows = existingResp.ok ? await existingResp.json() : [];
  var existing = existingRows && existingRows[0];
  if (!existing || existing.reviewer_id !== authUser.id) {
    res.status(404).json({ error: 'Assignment not found.' });
    return;
  }
  if (existing.status === 'completed') {
    res.status(200).json({ assignment: existing });
    return;
  }

  var eligibleAt = new Date(existing.assigned_at).getTime() + MIN_WAIT_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() < eligibleAt) {
    var daysLeft = Math.max(1, Math.ceil((eligibleAt - Date.now()) / (24 * 60 * 60 * 1000)));
    res.status(400).json({
      error: 'Reviews can be marked done starting ' + MIN_WAIT_DAYS + ' days after you claim a book — ' +
        'this protects your Amazon reviewer account from posting too many reviews too quickly. ' +
        'Check back in about ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
    });
    return;
  }

  var updateResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?id=eq.' + encodeURIComponent(assignmentId),
    {
      method: 'PATCH',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
    }
  );
  if (!updateResp.ok) {
    res.status(502).json({ error: 'Could not mark this as done right now, please try again.' });
    return;
  }
  var updated = await updateResp.json();
  res.status(200).json({ assignment: updated && updated[0] });
};
