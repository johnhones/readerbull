// Vercel serverless function: everything the Reciprocal Reviews dashboard
// card needs to render for the signed-in author — their own books' pool
// status and slot counts, what they've been assigned to review, and how
// many of their own books are currently being reviewed by someone else.
//
// GET -> {
//   myBooks: [ { bookId, title, manuscriptUploaded, inPool, availableSlots } ],
//   toReview: [ { assignmentId, bookId, title, coverImageUrl, status } ],
//   beingReviewed: [ { bookId, title, activeCount, completedCount } ]
// }
//
// Reviewer/owner identity is deliberately not surfaced to the other party
// anywhere in this response — see the anonymity note in
// ReaderBull_Review_System_Scoping.md Section 8/9.

var SUPABASE_URL = 'https://tqkeqjisqqvxasyzrfax.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_0L4W_eHRcnYNm5MR1gDDDg_Bn1d3nPm';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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
  var headers = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + authToken };

  // How many reviews has this author completed for others — feeds the
  // slot arithmetic for every one of their own books below.
  var completedResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id&reviewer_id=eq.' +
      encodeURIComponent(authUser.id) + '&status=eq.completed',
    { headers: headers }
  );
  var completedRows = completedResp.ok ? await completedResp.json() : [];
  var completedCount = (completedRows || []).length;

  // This author's own books, plus whatever pool entry exists for each.
  var booksResp = await fetch(
    SUPABASE_URL + '/rest/v1/books?select=id,book_title,manuscript_url&user_id=eq.' + encodeURIComponent(authUser.id),
    { headers: headers }
  );
  var books = booksResp.ok ? await booksResp.json() : [];

  var poolResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_pool_entries?select=id,book_id,active,bonus_slots&user_id=eq.' + encodeURIComponent(authUser.id),
    { headers: headers }
  );
  var poolRows = poolResp.ok ? await poolResp.json() : [];
  var poolByBook = {};
  (poolRows || []).forEach(function (p) { poolByBook[p.book_id] = p; });

  var myBooks = [];
  for (var i = 0; i < (books || []).length; i++) {
    var b = books[i];
    var pool = poolByBook[b.id];
    var availableSlots = null;
    if (pool && pool.active) {
      var usedResp = await fetch(
        SUPABASE_URL + '/rest/v1/review_assignments?select=id&book_id=eq.' + encodeURIComponent(b.id),
        { headers: headers }
      );
      var usedRows = usedResp.ok ? await usedResp.json() : [];
      availableSlots = (pool.bonus_slots || 0) + completedCount - (usedRows || []).length;
    }
    myBooks.push({
      bookId: b.id,
      title: b.book_title || 'Untitled book',
      manuscriptUploaded: !!b.manuscript_url,
      inPool: !!(pool && pool.active),
      availableSlots: availableSlots
    });
  }

  // Books this author has been assigned to review.
  var toReviewResp = await fetch(
    SUPABASE_URL + '/rest/v1/review_assignments?select=id,book_id,owner_id,status,books(book_title,cover_image_url)&reviewer_id=eq.' +
      encodeURIComponent(authUser.id) + '&order=assigned_at.desc',
    { headers: headers }
  );
  var toReviewRows = toReviewResp.ok ? await toReviewResp.json() : [];
  var toReview = (toReviewRows || []).map(function (r) {
    var bk = r.books || {};
    return {
      assignmentId: r.id,
      bookId: r.book_id,
      ownerId: r.owner_id,
      manuscriptPath: r.owner_id + '/' + r.book_id + '.pdf',
      title: bk.book_title || 'Untitled book',
      coverImageUrl: bk.cover_image_url || null,
      status: r.status
    };
  });

  // How many people are currently reviewing (or have completed reviewing)
  // each of this author's own books — counts only, no reviewer identity.
  var beingReviewed = [];
  for (var j = 0; j < myBooks.length; j++) {
    var bookId = myBooks[j].bookId;
    var assignResp = await fetch(
      SUPABASE_URL + '/rest/v1/review_assignments?select=status&book_id=eq.' + encodeURIComponent(bookId),
      { headers: headers }
    );
    var assignRows = assignResp.ok ? await assignResp.json() : [];
    if (assignRows && assignRows.length) {
      var activeCount = assignRows.filter(function (r) { return r.status === 'assigned'; }).length;
      var doneCount = assignRows.filter(function (r) { return r.status === 'completed'; }).length;
      beingReviewed.push({ bookId: bookId, title: myBooks[j].title, activeCount: activeCount, completedCount: doneCount });
    }
  }

  res.status(200).json({ myBooks: myBooks, toReview: toReview, beingReviewed: beingReviewed });
};
