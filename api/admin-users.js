// Vercel serverless function: a read-only summary of every author for
// John to browse (name, email, plan, status, signup date), since the
// website itself has no admin view and Supabase's own Table Editor only
// shows raw rows keyed by user_id, not names (see ReaderBull_Master_Handover.md
// for context on why this was needed, added 10 August 2026).
//
// Joins three things server-side using the service-role key, the same
// pattern already used in stripe-webhook.js and export-backup.js:
//   auth.users        -> email, signup date
//   subscriptions      -> plan, status, book_limit
//   books (most recent) -> author_name, as a stand-in for "who this is"
//     (author_name is captured per book at onboarding, not per account,
//     so a user with several books under different pen names will only
//     show their most recently added one here, that is an accepted
//     simplification for a first cut, not a bug)
//
// Protected the same way as export-backup.js: a shared secret header,
// not a Supabase login, so this cannot be reached by any ordinary
// author account, only by whoever holds ADMIN_SECRET (a Vercel
// environment variable, set directly in Vercel, never committed here).
//
// GET /api/admin-users
// Header: x-admin-secret: <ADMIN_SECRET>
// -> { users: [{ userId, email, createdAt, authorName, plan, status,
//                bookLimit, stripeCustomerId, currentPeriodEnd }] }
// or -> { error: "..." } with a 4xx/5xx status.
//
// GET /api/admin-users?resource=proofs
// -> { proofs: [{ assignmentId, bookTitle, reviewerEmail,
//                 amazonReviewerName, proofUrl, assignedAt,
//                 completedAt, proofStatus }] }
//   The ARC Verified Purchase proof-of-purchase review queue (18 August
//   2026, handover Section 4 items 6-7). Folded into this file rather
//   than kept as its own api/admin-arc-proofs.js (18 August 2026) purely
//   to stay under the Vercel Hobby plan's 12-serverless-function cap,
//   nothing about the logic changed. This does NOT gate anything, a
//   reviewer's slot credit and "completed" status land the moment they
//   submit a proof link (see api/reviews-mark-done.js), independent of
//   whether anyone's checked it. This is a parallel, after-the-fact audit
//   trail: every Verified Purchase submission starts 'pending_review';
//   whoever holds ADMIN_SECRET can mark it 'approved' or 'flagged' below.
//   Flagging doesn't undo the slot credit, it just tells the reviewer
//   (via api/reviews-my-status.js's proofStatus field) that their link
//   needs fixing, they can submit a new one, which resets it to
//   'pending_review' (api/reviews-mark-done.js's resubmission path).
//   Lists every 'pending_review' or 'flagged' submission, newest first.
//   'approved' ones are left out on purpose, once cleared there's nothing
//   left to do, pull the full table directly in Supabase if a complete
//   history is ever needed.
//
// POST /api/admin-users
// Body: { assignmentId, action: 'approve' | 'flag' } -> { assignment: {...} }
//   Approve/flag action for the proof queue above. Same shared-secret
//   protection as the GET routes.

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
  var authHeaders = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };

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
          headers: Object.assign({}, authHeaders, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
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

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var wantsProofs = req.query && req.query.resource === 'proofs';

  if (wantsProofs) {
    try {
      var proofsResp = await fetch(
        supabaseUrl + '/rest/v1/review_assignments?select=id,reviewer_id,assigned_at,completed_at,review_proof_url,proof_status,books(book_title)' +
          '&proof_status=in.(pending_review,flagged)&order=completed_at.desc',
        { headers: authHeaders }
      );
      var proofRows = await proofsResp.json();
      if (!proofsResp.ok) {
        res.status(502).json({ error: 'Could not read the review_assignments table.', detail: proofRows });
        return;
      }

      // Reviewer email + their Amazon name, same pattern as the user list
      // below: walk auth.users directly with the service key.
      var proofUsers = [];
      var proofPage = 1;
      while (true) {
        var proofUsersResp = await fetch(supabaseUrl + '/auth/v1/admin/users?page=' + proofPage + '&per_page=200', { headers: authHeaders });
        var proofUsersData = await proofUsersResp.json();
        if (!proofUsersResp.ok) {
          res.status(502).json({ error: 'Could not read the user list.', detail: proofUsersData });
          return;
        }
        var proofPageUsers = (proofUsersData && proofUsersData.users) || [];
        proofUsers = proofUsers.concat(proofPageUsers);
        if (proofPageUsers.length < 200) break;
        proofPage += 1;
        if (proofPage > 20) break;
      }
      var userById = {};
      proofUsers.forEach(function (u) { userById[u.id] = u; });

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

  try {
    // auth.users: paginated 50 at a time by default, walk every page
    // rather than assuming the author list stays under 50 forever.
    var users = [];
    var page = 1;
    while (true) {
      var usersResp = await fetch(
        supabaseUrl + '/auth/v1/admin/users?page=' + page + '&per_page=200',
        { headers: authHeaders }
      );
      var usersData = await usersResp.json();
      if (!usersResp.ok) {
        res.status(502).json({ error: 'Could not read the user list.', detail: usersData });
        return;
      }
      var pageUsers = (usersData && usersData.users) || [];
      users = users.concat(pageUsers);
      if (pageUsers.length < 200) break;
      page += 1;
      if (page > 20) break; // sanity stop, 4000 users, well beyond MVP scale
    }

    var subsResp = await fetch(
      supabaseUrl + '/rest/v1/subscriptions?select=user_id,plan,status,book_limit,stripe_customer_id,current_period_end',
      { headers: authHeaders }
    );
    var subs = await subsResp.json();
    if (!subsResp.ok) {
      res.status(502).json({ error: 'Could not read the subscriptions table.', detail: subs });
      return;
    }
    var subsByUser = {};
    (Array.isArray(subs) ? subs : []).forEach(function (row) {
      subsByUser[row.user_id] = row;
    });

    // Most recent book per author: order newest-first, keep the first
    // one seen per user_id.
    var booksResp = await fetch(
      supabaseUrl + '/rest/v1/books?select=user_id,author_name,created_at&order=created_at.desc',
      { headers: authHeaders }
    );
    var books = await booksResp.json();
    if (!booksResp.ok) {
      res.status(502).json({ error: 'Could not read the books table.', detail: books });
      return;
    }
    var latestBookByUser = {};
    (Array.isArray(books) ? books : []).forEach(function (row) {
      if (!latestBookByUser[row.user_id]) {
        latestBookByUser[row.user_id] = row;
      }
    });

    var result = users.map(function (u) {
      var sub = subsByUser[u.id] || {};
      var book = latestBookByUser[u.id];
      return {
        userId: u.id,
        email: u.email || null,
        createdAt: u.created_at || null,
        authorName: (book && book.author_name) || null,
        plan: sub.plan || 'free',
        status: sub.status || null,
        bookLimit: (typeof sub.book_limit === 'number') ? sub.book_limit : 1,
        stripeCustomerId: sub.stripe_customer_id || null,
        currentPeriodEnd: sub.current_period_end || null
      };
    });

    // Newest signups first, most useful default when checking on recent activity.
    result.sort(function (a, b) {
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

    res.status(200).json({ users: result });
  } catch (err) {
    res.status(500).json({ error: 'Admin user list failed: ' + err.message });
  }
};
