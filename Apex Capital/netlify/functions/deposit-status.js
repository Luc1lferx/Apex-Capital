// netlify/functions/deposit-status.js
// Returns the current status of a deposit charge for the authenticated user.
// Used by the dashboard to poll for confirmation updates.
//
// GET /.netlify/functions/deposit-status?charge_id=<uuid>
// Auth: apex_session cookie required

const { supabase, getSession, ok, badReq, unauth, serverErr } = require('./_db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const session = getSession(event);
  if (!session) return unauth();

  const chargeId = event.queryStringParameters?.charge_id;
  if (!chargeId) return badReq('charge_id is required');

  try {
    // Lookup user
    const users = await supabase.get(
      '/rest/v1/users',
      `auth0_sub=eq.${encodeURIComponent(session.sub)}&select=id`
    );
    if (!users.length) return unauth();
    const userId = users[0].id;

    // Fetch charge — enforce ownership so users can't poll other users' charges
    const charges = await supabase.get(
      '/rest/v1/deposit_charges',
      `id=eq.${chargeId}&user_id=eq.${userId}&select=id,asset,amount_usd,crypto_amount,deposit_address,hosted_url,status,confirmations,confirm_threshold,credited,network_tx,expires_at,created_at,updated_at`
    );

    if (!charges.length) return badReq('Charge not found');

    const c = charges[0];
    const expired = c.status === 'pending' && new Date(c.expires_at) < new Date();

    return ok({
      charge: {
        id:                c.id,
        asset:             c.asset,
        amount_usd:        c.amount_usd,
        crypto_amount:     c.crypto_amount,
        deposit_address:   c.deposit_address,
        hosted_url:        c.hosted_url,
        status:            expired ? 'expired' : c.status,
        confirmations:     c.confirmations,
        confirm_threshold: c.confirm_threshold,
        credited:          c.credited,
        network_tx:        c.network_tx,
        expires_at:        c.expires_at,
        created_at:        c.created_at,
        updated_at:        c.updated_at,
        // convenience flags for the UI
        is_pending:    c.status === 'pending'    && !expired,
        is_detected:   c.status === 'detected'   || c.status === 'confirming',
        is_complete:   c.status === 'completed'  && c.credited,
        is_failed:     c.status === 'failed'     || c.status === 'expired' || expired,
      },
    });
  } catch (err) {
    console.error('deposit-status error:', err);
    return serverErr(err.message);
  }
};
