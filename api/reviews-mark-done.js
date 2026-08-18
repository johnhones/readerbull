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
//
// Verified Purchase proof-of-purchase (17 August 2026, handover Section 4
// items 6-7, refined 18 August 2026 — decided: proof required for
// Verified Purchase only, not Manuscript/Kindle Unlimited; mechanism is a
// link to the posted review. The reviewer's Amazon display name is
// captured earlier, at claim time (api/reviews-request.js), not here, so
// this endpoint just needs the link.
//
// This does NOT gate the reviewer's own slot credit on anything getting
// checked — status flips to "completed" and the slot opens up the moment
// the link is submitted, same as every other tier (direct user
// instruction, 18 August 2026: "the books open slot should always be
// open"). proof_status is a parallel, non-blocking review trail for
// whoever checks these by hand later: 'pending_review' when first
// submitted, then 'approved' or 'flagged' via api/admin-arc-proofs.js. A
// flagged submission can be fixed and resubmitted — POST again with a new
// proofUrl on an already-completed assignment updates the link and resets
// proof_status to 'pending_review', it does not re-run the wait-day gate
// or touch status/completed_at again.

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
    SUPABASE_URL + '/rest/v1/review_assignments?select=id,book_id,reviewer_id,status,assigned_at&id=eq.' + encodeURIComponent(assignmentId),
    { headers: headers }
  );
  var existingRows = existingResp.ok ? await existingResp.json() : [];
  var existing = existingRows && existingRows[0];
  if (!existing || existing.reviewer_id !== authUser.id) {
    res.status(404).json({ error: 'Assignment not found.' });
    return;
  }

  var proofUrl = (req.body && req.body.proofUrl ? String(req.body.proofUrl).trim() : '');

  if (existing.status === 'completed') {
    // Already done. A resubmission (fixing a flagged proof link) is the
    // only thing this can still do — no proofUrl means "just tell me the
    // current state", same as before.
    if (!proofUrl) {
      res.status(200).json({ assignment: existing });
      return;
    }
    if (!/^https:\/\/(www\.)?amazon\.[a-z.]+\//i.test(proofUrl)) {
      res.status(400).json({ error: 'That doesn\'t look like an Amazon link. Paste the link to your posted review.' });
      return;
    }
    var resubmitResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?id=eq.' + encodeURIComponent(assignmentId),
      {
        method: 'PATCH',
        headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
        body: JSON.stringify({ review_proof_url: proofUrl, proof_status: 'pending_review' })
      }
    );
    if (!resubmitResp.ok) {
      res.status(502).json({ error: 'Could not save your updated link right now, please try again.' });
      return;
    }
    var resubmitted = await resubmitResp.json();
    res.status(200).json({ assignment: resubmitted && resubmitted[0] });
    return;
  }

  var eligibleAt = new Date(existing.assigned_at).getTime() + MIN_WAIT_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() < eligibleAt) {
    var daysLeft = Math.max(1, Math.ceil((eligibleAt - Date.now()) / (24 * 60 * 60 * 1000)));
    res.status(400).json({
      error: 'Reviews can be marked done starting ' + MIN_WAIT_DAYS + ' days after you claim a book, ' +
        'this protects your Amazon reviewer account from posting too many reviews too quickly. ' +
        'Check back in about ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '.'
    });
    return;
  }

  // Verified Purchase requires proof-of-purchase; Manuscript / Kindle
  // Unlimited do not (Section 4 item 7 decision).
  var updateBody = { status: 'completed', completed_at: new Date().toISOString() };
  var tierResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=offer_type&book_id=eq.' + encodeURIComponent(existing.book_id),
    { headers: headers }
  );
  var tierRows = tierResp.ok ? await tierResp.json() : [];
  var offerType = (tierRows && tierRows[0] && tierRows[0].offer_type) || 'manuscript';

  if (offerType === 'verified_purchase') {
    if (!proofUrl || !/^https:\/\/(www\.)?amazon\.[a-z.]+\//i.test(proofUrl)) {
      res.status(400).json({ error: 'This is a Verified Purchase review. Paste the link to your posted Amazon review before marking it done.' });
      return;
    }
    // The Amazon name itself was already captured at claim time
    // (api/reviews-request.js) — this is just a safety net for any
    // assignment claimed before that existed.
    var storedName = (authUser.user_metadata && authUser.user_metadata.amazon_reviewer_name) || '';
    if (!storedName) {
      res.status(400).json({ error: 'We don\'t have your Amazon reviewer name on file yet. Please contact support to add it before marking this done.' });
      return;
    }
    updateBody.review_proof_url = proofUrl;
    updateBody.proof_status = 'pending_review';
  }

  var updateResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?id=eq.' + encodeURIComponent(assignmentId),
    {
      method: 'PATCH',
      headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
      body: JSON.stringify(updateBody)
    }
  );
  if (!updateResp.ok) {
    res.status(502).json({ error: 'Could not mark this as done right now, please try again.' });
    return;
  }
  var updated = await updateResp.json();
  res.status(200).json({ assignment: updated && updated[0] });
};
