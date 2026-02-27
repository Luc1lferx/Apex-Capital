// netlify/functions/admin-kyc-update.js
// Update a user's KYC status. Admin only.
//
// POST /.netlify/functions/admin-kyc-update
// Body: { userId, kyc_status, notes }
//   kyc_status: 'pending' | 'verified' | 'rejected'

const { supabase, auditLog, ok, badReq } = require('./_db');
const { requireAdmin } = require('./_admin-guard');

const ALLOWED_STATUSES = new Set(['pending','verified','rejected']);

exports.handler = requireAdmin(async (event, session) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return badReq('Invalid JSON'); }

  const { userId, kyc_status, notes } = body;

  if (!userId)                            return badReq('userId is required');
  if (!ALLOWED_STATUSES.has(kyc_status))  return badReq(`Invalid status: ${kyc_status}`);

  // Verify user exists and get current status
  const users = await supabase.get('/rest/v1/users', `id=eq.${userId}&select=id,email,name,kyc_status`);
  if (!users.length) return badReq('User not found');
  const user = users[0];

  const prevStatus = user.kyc_status;

  // Update KYC status
  await supabase.patch(
    '/rest/v1/users',
    `id=eq.${userId}`,
    { kyc_status, updated_at: new Date().toISOString() }
  );

  // Audit log
  await auditLog({
    userId: null,
    action: 'admin_kyc_update',
    meta: {
      admin_email:    session.email,
      target_user_id: userId,
      target_email:   user.email,
      prev_status:    prevStatus,
      new_status:     kyc_status,
      notes:          notes || null,
    },
    event,
  });

  return ok({
    updated:     true,
    userId,
    email:       user.email,
    prev_status: prevStatus,
    new_status:  kyc_status,
  });
});
