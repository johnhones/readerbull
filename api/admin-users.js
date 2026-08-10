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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
