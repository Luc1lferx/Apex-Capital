// netlify/functions/admin-balance-adjust.js
// Manually credit or debit a user's balance. Creates an admin adjustment
// transaction record and writes a full audit entry.
// Admin only.
//
// POST /.netlify/functions/admin-balance-adjust
// Body: { userId, asset, delta, reason }
//   delta > 0 = credit, delta < 0 = debit

const { supabase, auditLog, ok, badReq, serverErr } = require('./_db');
const { requireAdmin } = require('./_admin-guard');
const notify           = require('./_notify');

const ALLOWED_ASSETS = new Set(['BTC','ETH','USDT','USDC','SOL','USD']);

exports.handler = requireAdmin(async (event, session) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return badReq('Invalid JSON'); }

  const { userId, asset, delta, reason } = body;

  if (!userId)                         return badReq('userId is required');
  if (!ALLOWED_ASSETS.has(asset))      return badReq(`Unsupported asset: ${asset}`);
  if (delta === undefined || delta === null || isNaN(delta) || delta === 0)
                                        return badReq('delta must be a non-zero number');
  if (!reason?.trim())                 return badReq('reason is required for audit trail');

  const numDelta = parseFloat(parseFloat(delta).toFixed(8));

  // Verify user exists
  const users = await supabase.get('/rest/v1/users', `id=eq.${userId}&select=id,email,name`);
  if (!users.length) return badReq('User not found');
  const user = users[0];

  // Atomic balance update
  try {
    await supabase.rpc('upsert_balance', {
      p_user_id: userId,
      p_asset:   asset,
      p_delta:   numDelta,
    });
  } catch (err) {
    if (err.message.includes('Insufficient balance')) return badReq('Insufficient balance — debit would go negative');
    throw err;
  }

  // Create an admin adjustment transaction record
  const [tx] = await supabase.post('/rest/v1/transactions', {
    user_id:    userId,
    type:       numDelta > 0 ? 'deposit' : 'withdrawal',
    asset,
    amount:     Math.abs(numDelta),
    status:     'completed',
    notes:      `[ADMIN ADJUSTMENT] ${reason} — by ${session.email}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Audit log
  await auditLog({
    userId: null, // admin action — not tied to a user session userId
    action: 'admin_balance_adjustment',
    meta: {
      admin_email:    session.email,
      target_user_id: userId,
      target_email:   user.email,
      asset,
      delta:          numDelta,
      reason,
      transaction_id: tx?.id,
    },
    event,
  });

  // Notify the affected user
  notify.transactionInitiated({
    userName:  user.name || user.email,
    userEmail: user.email,
    type:      numDelta > 0 ? 'deposit' : 'withdrawal',
    asset,
    amount:    Math.abs(numDelta),
    usdValue:  0, // admin adjustments skip USD calc
    status:    'completed',
    txId:      tx?.id || 'admin-adj',
    ip:        event.headers['x-forwarded-for']?.split(',')[0] || 'admin',
  }).catch(() => {});

  // Fetch updated balance to return
  const balRows = await supabase.get(
    '/rest/v1/balances',
    `user_id=eq.${userId}&asset=eq.${asset}&select=amount`
  );
  const newBalance = balRows[0] ? parseFloat(balRows[0].amount) : null;

  return ok({
    adjusted: true,
    userId,
    asset,
    delta:       numDelta,
    new_balance: newBalance,
    transaction_id: tx?.id,
  });
});
