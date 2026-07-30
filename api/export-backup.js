// Vercel serverless function: exports a full JSON snapshot of the books
// table plus the Supabase Auth user list, for backup purposes.
//
// Why this exists: the project's Supabase instance is on the free tier,
// which has no automated database backups at all (confirmed 30 July 2026,
// see ReaderBull_Infrastructure.md section 7). This endpoint is the free
// stopgap: a scheduled task calls it daily and saves the result to a local
// timestamped file, so there is at least a recent, restorable copy of the
// real data if something goes wrong. It is not a substitute for a real
// point-in-time database backup (see the Supabase Pro plan) if the
// business grows past MVP.
//
// Protected by a shared secret (BACKUP_SECRET, a Vercel environment
// variable, chosen when this was built, never committed to this repo) so
// the export cannot be scraped by anyone who finds the URL. This endpoint
// returns every author's email and audit data, treat the secret and the
// response with the same care as the database itself.
//
// GET /api/export-backup
// Header: x-backup-secret: <BACKUP_SECRET>
// -> { exportedAt, books: [...], users: [...] }
// or -> { error: "..." } with a 4xx/5xx status.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var expectedSecret = process.env.BACKUP_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ error: 'Backup export is not configured yet, BACKUP_SECRET is missing.' });
    return;
  }

  var suppliedSecret = req.headers && req.headers['x-backup-secret'];
  if (!suppliedSecret || suppliedSecret !== expectedSecret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  var supabaseUrl = process.env.SUPABASE_URL || 'https://tqkeqjisqqvxasyzrfax.supabase.co';
  var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    res.status(500).json({ error: 'Backup export is not configured yet, SUPABASE_SERVICE_ROLE_KEY is missing.' });
    return;
  }

  try {
    var booksResp = await fetch(supabaseUrl + '/rest/v1/books?select=*', {
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }
    });
    var books = await booksResp.json();
    if (!booksResp.ok) {
      res.status(502).json({ error: 'Could not read the books table.', detail: books });
      return;
    }

    var usersResp = await fetch(supabaseUrl + '/auth/v1/admin/users', {
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }
    });
    var usersData = await usersResp.json();
    if (!usersResp.ok) {
      res.status(502).json({ error: 'Could not read the user list.', detail: usersData });
      return;
    }

    res.status(200).json({
      exportedAt: new Date().toISOString(),
      books: books,
      users: (usersData && usersData.users) || []
    });
  } catch (err) {
    res.status(500).json({ error: 'Backup export failed: ' + err.message });
  }
};
