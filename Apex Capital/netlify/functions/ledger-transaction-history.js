// netlify/functions/ledger-transaction-history.js
// Returns the authenticated user's transaction history with pagination and filters.
//
// GET /.netlify/functions/ledger-transaction-history
// Auth: apex_session cookie required
// Query params:
//   page=1          (1-based, default 1)
//   limit=20        (max 100, default 20)
//   type=deposit    (optional filter: deposit | withdrawal)
//   asset=BTC       (optional filter)
//   status=pending  (optional filter)

const { supabase, getSession, ok, unauth, badReq, serverErr } = require('./_db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const session = getSession(event);
  if (!session) return unauth();

  const q = event.queryStringParameters || {};
  const page  = Math.max(1, parseInt(q.page  || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || '20')));
  const from  = (page - 1) * limit;
  const to    = from + limit - 1;

  try {
    // Lookup user
    const users = await supabase.get(
      '/rest/v1/users',
      `auth0_sub=eq.${encodeURIComponent(session.sub)}&select=id`
    );
    if (!users.length) return unauth();
    const userId = users[0].id;

    // Build filter string
    let filter = `user_id=eq.${userId}`;
    if (q.type   && ['deposit','withdrawal'].includes(q.type))   filter += `&type=eq.${q.type}`;
    if (q.asset  && /^[A-Z]{2,6}$/.test(q.asset))               filter += `&asset=eq.${q.asset}`;
    if (q.status && /^[a-z_]+$/.test(q.status))                 filter += `&status=eq.${q.status}`;

    // Fetch with range header for pagination
    const path = `/rest/v1/transactions?${filter}&order=created_at.desc&select=*`;
    const res  = await fetch(`${process.env.SUPABASE_URL}${path}`, {
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Range':         `${from}-${to}`,
        'Range-Unit':    'items',
        'Prefer':        'count=exact',
      },
    });

    const transactions = await res.json();
    const contentRange = res.headers.get('content-range') || '';
    // content-range: 0-19/47 → total = 47
    const total = parseInt(contentRange.split('/')[1]) || transactions.length;

    return ok({
      transactions: transactions.map(formatTx),
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next:    page * limit < total,
        has_prev:    page > 1,
      },
    });
  } catch (err) {
    console.error('ledger-transaction-history error:', err);
    return serverErr(err.message);
  }
};

function formatTx(tx) {
  return {
    id:         tx.id,
    type:       tx.type,
    asset:      tx.asset,
    amount:     parseFloat(tx.amount),
    usd_value:  tx.usd_value  ? parseFloat(tx.usd_value)  : null,
    fee_amount: tx.fee_amount ? parseFloat(tx.fee_amount) : null,
    fee_usd:    tx.fee_usd    ? parseFloat(tx.fee_usd)    : null,
    status:     tx.status,
    tx_hash:    tx.tx_hash,
    network:    tx.network,
    address:    tx.address,
    notes:      tx.notes,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
  };
}
