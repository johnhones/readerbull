// Vercel serverless function: the manual review queue for Verified
// Purchase proof-of-purchase submissions (18 August 2026, handover
// Section 4 items 6-7, refined per direct user instruction the same day).
//
// This does NOT gate anything — a reviewer's slot credit and "completed"
// status land the moment they submit a proof link (see
// api/reviews-mark-done.js), independent of whether anyone's checked it.
// This is a parallel, after-the-fact audit trail: every Verified Purchase
// submission starts 'pending_review'; whoever holds ADMIN_SECRET can mark
// it 'approved' or 'flagged' here. Flagging doesn't undo the slot credit,
// it just tells the reviewer (via api/reviews-my-status.js's proofStatus
// field) that their link needs fixing — they can submit a new one, which
// resets it to 'pending_review' (api/reviews-mark-done.js's resubmission
// path).
//
// GET  -> { proofs: [{ assignmentId, bookTitle, reviewerEmail,
//                       amazonReviewerName, proofUrl, assignedAt,
//                       completedAt, proofStatus }] }
//   Lists every 'pending_review' or 'flagged' submission, newest first.
//   'approved' ones are left out on purpose, once cleared there's nothing
//   left to do — pull the full table directly in Supabase if a complete
//   history is ever needed.
// POST { assignmentId, action: 'approve' | 'flag' } -> { assignment: {...} }
//
// Protected the same way as api/admin-users.js: a shared secret header,
// not a Supabase login.

module.exports = async function handler(req, res) {
  var expectedSecret = process.env.ADMIN_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: 'Admin view is not configured yet, ADMIN_SECRET is missing.' });
    return;
  }
  var suppliedSecret = req.headers && req.headers['x-admin-secret'];
  if (!suppliedSecret || suppliedSecret !== expectedSecret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  var supabaseUrl = process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co';
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    res.status(500).json({ error: 'Admin view is not configured yet, SUPABASE_SERVICE_ROLE_KEY is missing.' });
    return;
  }
  var headers = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };

  if (req.method === 'GET') {
    try {
      var proofsResp = await fetch(
        supabaseUrl + '/rest/v1/review_assignments?select=id,reviewer_id,assigned_at,completed_at,review_proof_url,proof_status,books(book_title)' +
          '&proof_status=in.(pending_review,flagged)&order=completed_at.desc',
        { headers: headers }
      );
      var proofRows = await proofsResp.json();
      if (!proofsResp.ok) {
        res.status(502).json({ error: 'Could not read the review_assignments table.', detail: proofRows });
        return;
      }

      // Reviewer email + their Amazon name, same admin-users.js pattern of
      // walking auth.users directly with the service key.
      var users = [];
      var page = 1;
      while (true) {
        var usersResp = await fetch(supabaseUrl + '/auth/v1/admin/users?page=' + page + '&per_page=200', { headers: headers });
        var usersData = await usersResp.json();
        if (!usersResp.ok) {
          res.status(502).json({ error: 'Could not read the user list.', detail: usersData });
          return;
        }
        var pageUsers = (usersData && usersData.users) || [];
        users = users.concat(pageUsers);
        if (pageUsers.length < 200) break;
        page += 1;
        if (page > 20) break;
      }
      var userById = {};
      users.forEach(function (u) { userById[u.id] = u; });

      var proofs = (Array.isArray(proofRows) ? proofRows : []).map(function (r) {
        var u = userById[r.reviewer_id] || {};
        var bk = r.books || {};
        return {
          assignmentId: r.id,
          bookTitle: bk.book_title || 'Untitled book',
          reviewerEmail: u.email || null,
          amazonReviewerName: (u.user_metadata && u.user_metadata.amazon_reviewer_name) || null,
          proofUrl: r.review_proof_url || null,
          assignedAt: r.assigned_at,
          completedAt: r.completed_at,
          proofStatus: r.proof_status
        };
      });

      res.status(200).json({ proofs: proofs });
    } catch (err) {
      res.status(500).json({ error: 'Could not load the proof queue: ' + err.message });
    }
    return;
  }

  if (req.method === 'POST') {
    var assignmentId = req.body && req.body.assignmentId;
    var action = req.body && req.body.action;
    if (!assignmentId || (action !== 'approve' && action !== 'flag')) {
      res.status(400).json({ error: 'Missing assignmentId or action must be "approve" or "flag".' });
      return;
    }
    try {
      var updateResp = await fetch(
        supabaseUrl + '/rest/v1/review_assignments?id=eq.' + encodeURIComponent(assignmentId),
        {
          method: 'PATCH',
          headers: Object.assign({}, headers, { Prefer: 'return=representation' }),
          body: JSON.stringify({ proof_status: action === 'approve' ? 'approved' : 'flagged' })
        }
      );
      var updated = await updateResp.json();
      if (!updateResp.ok) {
        res.status(502).json({ error: 'Could not update that submission.', detail: updated });
        return;
      }
      res.status(200).json({ assignment: updated && updated[0] });
    } catch (err) {
      res.status(500).json({ error: 'Could not update that submission: ' + err.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
