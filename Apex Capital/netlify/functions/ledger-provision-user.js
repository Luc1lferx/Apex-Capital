// netlify/functions/ledger-provision-user.js
// Called immediately after login (from dashboard boot) to ensure the
// authenticated user has a row in `users`, seed balances, and strategy allocations.
// Idempotent — safe to call on every login.
//
// POST /.netlify/functions/ledger-provision-user
// Auth: apex_session cookie required

const { supabase, getSession, auditLog, ok, unauth, serverErr } = require('./_db');

// Default starting assets for new users (zero balances)
const DEFAULT_ASSETS = ['BTC', 'ETH', 'USDT', 'USDC', 'SOL', 'USD'];

// Default strategy allocation buckets (all zero until first deposit invested)
const DEFAULT_STRATEGIES = [
  { strategy: 'long_short', usd_value: 0, pct: 0 },
  { strategy: 'defi_yield', usd_value: 0, pct: 0 },
  { strategy: 'quant_arb',  usd_value: 0, pct: 0 },
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const session = getSession(event);
  if (!session) return unauth();

  try {
    const { sub, email, name, picture } = session;

    // 1. Upsert user row
    const [user] = await supabase.post('/rest/v1/users', {
      auth0_sub:   sub,
      email,
      name:        name || email,
      picture_url: picture || null,
      updated_at:  new Date().toISOString(),
    }).catch(async () => {
      // Already exists — fetch by sub
      const rows = await supabase.get(
        '/rest/v1/users',
        `auth0_sub=eq.${encodeURIComponent(sub)}&select=*`
      );
      // Update name/picture in case they changed
      if (rows.length) {
        await supabase.patch(
          '/rest/v1/users',
          `auth0_sub=eq.${encodeURIComponent(sub)}`,
          { name: name || email, picture_url: picture || null, updated_at: new Date().toISOString() }
        );
      }
      return rows;
    });

    if (!user) throw new Error('Could not provision user row');

    const userId = user.id;

    // 2. Seed zero balances for any missing assets (INSERT … ON CONFLICT DO NOTHING)
    for (const asset of DEFAULT_ASSETS) {
      await supabase(
        `/rest/v1/balances`,
        {
          method: 'POST',
          body: JSON.stringify({ user_id: userId, asset, amount: 0, updated_at: new Date().toISOString() }),
          headers: { Prefer: 'resolution=ignore-duplicates' },
        }
      ).catch(() => {}); // silently skip if already exists
    }

    // 3. Seed strategy allocation rows
    for (const alloc of DEFAULT_STRATEGIES) {
      await supabase(
        `/rest/v1/strategy_allocations`,
        {
          method: 'POST',
          body: JSON.stringify({ user_id: userId, ...alloc, updated_at: new Date().toISOString() }),
          headers: { Prefer: 'resolution=ignore-duplicates' },
        }
      ).catch(() => {});
    }

    // 4. Audit: login event
    await auditLog({ userId, action: 'login', meta: { email }, event });

    return ok({ userId, email, provisioned: true });
  } catch (err) {
    console.error('ledger-provision-user error:', err);
    return serverErr(err.message);
  }
};
