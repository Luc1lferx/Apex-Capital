// netlify/functions/admin-transaction-update.js
// Update a transaction's status. Handles special logic for approvals/rejections
// (e.g. rejection refunds the balance).
// Admin only.
//
// POST /.netlify/functions/admin-transaction-update
// Body: { transactionId, status, notes }
//   status: 'completed' | 'processing' | 'failed' | 'cancelled'

const { supabase, auditLog, ok, badReq, serverErr } = require('./_db');
const { requireAdmin } = require('./_admin-guard');
const notify           = require('./_notify');

const ALLOWED_STATUSES = new Set(['completed','processing','failed','cancelled']);

exports.handler = requireAdmin(async (event, session) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return badReq('Invalid JSON'); }

  const { transactionId, status, notes } = body;

  if (!transactionId)              return badReq('transactionId is required');
  if (!ALLOWED_STATUSES.has(status)) return badReq(`Invalid status: ${status}. Must be one of: ${[...ALLOWED_STATUSES].join(', ')}`);

  // Fetch the transaction + user
  const txRows = await supabase.get(
    '/rest/v1/transactions',
    `id=eq.${transactionId}&select=*`
  );
  if (!txRows.length) return badReq('Transaction not found');
  const tx = txRows[0];

  const prevStatus = tx.status;
  if (prevStatus === status) return badReq(`Transaction is already ${status}`);

  // If a withdrawal is being failed/cancelled → refund the balance
  // (the balance was already debited when the withdrawal was created)
  if (tx.type === 'withdrawal' && (status === 'failed' || status === 'cancelled') &&
      prevStatus !== 'failed' && prevStatus !== 'cancelled') {
    try {
      await supabase.rpc('upsert_balance', {
        p_user_id: tx.user_id,
        p_asset:   tx.asset,
        p_delta:   parseFloat(tx.amount) + (parseFloat(tx.fee_amount) || 0),
      });
    } catch (err) {
      console.error('Refund failed:', err);
      // Continue — log it but don't block status update
    }
  }

  // Update transaction
  await supabase.patch(
    '/rest/v1/transactions',
    `id=eq.${transactionId}`,
    {
      status,
      notes:      notes ? `${tx.notes || ''}\n[ADMIN ${new Date().toISOString()}] ${notes}`.trim() : tx.notes,
      updated_at: new Date().toISOString(),
    }
  );

  // Fetch user for notification
  const userRows = await supabase.get('/rest/v1/users', `id=eq.${tx.user_id}&select=email,name`);
  const user = userRows[0];

  // Audit log
  await auditLog({
    userId: null,
    action: 'admin_transaction_status_update',
    meta: {
      admin_email:    session.email,
      transaction_id: transactionId,
      prev_status:    prevStatus,
      new_status:     status,
      type:           tx.type,
      asset:          tx.asset,
      amount:         tx.amount,
      notes,
      refunded:       tx.type === 'withdrawal' && (status === 'failed' || status === 'cancelled'),
    },
    event,
  });

  // Notify user of status change
  if (user) {
    notify.transactionInitiated({
      userName:  user.name || user.email,
      userEmail: user.email,
      type:      tx.type,
      asset:     tx.asset,
      amount:    parseFloat(tx.amount),
      usdValue:  tx.usd_value || 0,
      feeUsd:    tx.fee_usd   || null,
      status,
      txId:      transactionId,
      ip:        'admin-update',
    }).catch(() => {});
  }

  return ok({
    updated:        true,
    transactionId,
    prev_status:    prevStatus,
    new_status:     status,
    refunded:       tx.type === 'withdrawal' && (status === 'failed' || status === 'cancelled'),
  });
});
