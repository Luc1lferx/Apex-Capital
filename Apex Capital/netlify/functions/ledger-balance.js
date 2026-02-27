// netlify/functions/ledger-balance.js
// Returns the authenticated user's balances and strategy allocations.
//
// GET /.netlify/functions/ledger-balance
// Auth: apex_session cookie required
//
// Response:
// {
//   ok: true,
//   balances: [ { asset, amount, usd_value }, ... ],
//   totals: { total_usd, invested_usd, available_usd, total_return_usd, total_return_pct },
//   allocations: [ { strategy, usd_value, pct }, ... ]
// }

const { supabase, getSession, auditLog, ok, unauth, serverErr } = require('./_db');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const session = getSession(event);
  if (!session) return unauth();

  try {
    // 1. Look up internal user ID from Auth0 sub
    const users = await supabase.get(
      '/rest/v1/users',
      `auth0_sub=eq.${encodeURIComponent(session.sub)}&select=id,kyc_status`
    );
    if (!users.length) return unauth(); // not provisioned yet

    const { id: userId, kyc_status } = users[0];

    // 2. Fetch balances
    const balanceRows = await supabase.get(
      '/rest/v1/balances',
      `user_id=eq.${userId}&select=asset,amount&order=asset.asc`
    );

    // 3. Fetch live prices from our own crypto-prices function
    //    (internal fetch — same Netlify instance, no external rate limit concerns)
    let prices = {};
    try {
      const priceRes  = await fetch(
        `${process.env.URL}/.netlify/functions/crypto-prices`
      );
      const priceJson = await priceRes.json();
      if (priceJson.ok) {
        priceJson.data.forEach(c => { prices[c.sym] = c.priceRaw; });
      }
    } catch { /* prices stay empty — USD values will be null */ }

    // USD is always 1:1
    prices['USD']  = 1;
    prices['USDT'] = prices['USDT'] || 1;
    prices['USDC'] = prices['USDC'] || 1;

    // 4. Enrich balances with USD values
    const balances = balanceRows.map(b => ({
      asset:     b.asset,
      amount:    parseFloat(b.amount),
      usd_price: prices[b.asset] || null,
      usd_value: prices[b.asset] != null
        ? parseFloat((b.amount * prices[b.asset]).toFixed(2))
        : null,
    }));

    // 5. Compute totals
    const total_usd = balances.reduce((s, b) => s + (b.usd_value || 0), 0);

    // 6. Strategy allocations
    const allocRows = await supabase.get(
      '/rest/v1/strategy_allocations',
      `user_id=eq.${userId}&select=strategy,usd_value,pct&order=strategy.asc`
    );
    const invested_usd   = allocRows.reduce((s, a) => s + parseFloat(a.usd_value), 0);
    const available_usd  = Math.max(0, total_usd - invested_usd);

    // Simple unrealised P&L placeholder (replace with real cost-basis tracking later)
    const total_return_usd = parseFloat((total_usd * 0.139).toFixed(2)); // 13.9% demo ROI
    const total_return_pct = 13.9;

    return ok({
      balances,
      totals: {
        total_usd:        parseFloat(total_usd.toFixed(2)),
        invested_usd:     parseFloat(invested_usd.toFixed(2)),
        available_usd:    parseFloat(available_usd.toFixed(2)),
        total_return_usd,
        total_return_pct,
        kyc_status,
      },
      allocations: allocRows.map(a => ({
        strategy:  a.strategy,
        usd_value: parseFloat(a.usd_value),
        pct:       parseFloat(a.pct),
      })),
    });
  } catch (err) {
    console.error('ledger-balance error:', err);
    return serverErr(err.message);
  }
};
