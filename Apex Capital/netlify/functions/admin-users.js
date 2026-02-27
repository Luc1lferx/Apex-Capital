// netlify/functions/admin-users.js
// GET all users with their total USD balance and KYC status.
// Admin only.
//
// GET /.netlify/functions/admin-users
// Query params: page=1, limit=20, search=email_or_name, kyc_status=pending|verified|rejected

const { supabase, ok, serverErr } = require('./_db');
const { requireAdmin }            = require('./_admin-guard');

exports.handler = requireAdmin(async (event) => {
  const q      = event.queryStringParameters || {};
  const page   = Math.max(1, parseInt(q.page  || '1'));
  const limit  = Math.min(100, parseInt(q.limit || '20'));
  const from   = (page - 1) * limit;
  const to     = from + limit - 1;
  const search = q.search?.trim() || '';
  const kycFilter = q.kyc_status || '';

  // Build filter
  let filter = 'select=id,auth0_sub,email,name,picture_url,kyc_status,created_at&order=created_at.desc';
  if (kycFilter) filter += `&kyc_status=eq.${encodeURIComponent(kycFilter)}`;
  if (search)    filter += `&or=(email.ilike.*${encodeURIComponent(search)}*,name.ilike.*${encodeURIComponent(search)}*)`;

  // Fetch users with pagination
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users?${filter}`, {
    headers: {
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Range':         `${from}-${to}`,
      'Range-Unit':    'items',
      'Prefer':        'count=exact',
    },
  });

  const users        = await res.json();
  const contentRange = res.headers.get('content-range') || '';
  const total        = parseInt(contentRange.split('/')[1]) || users.length;

  // Fetch balances for these users in one query
  const userIds = users.map(u => u.id);
  let balanceMap = {};

  if (userIds.length) {
    const idList = userIds.map(id => `"${id}"`).join(',');
    const balRows = await supabase.get(
      '/rest/v1/balances',
      `user_id=in.(${userIds.join(',')})&select=user_id,asset,amount`
    );

    // Fetch live prices once
    let prices = { USD:1, USDT:1, USDC:1 };
    try {
      const pr = await fetch(`${process.env.URL}/.netlify/functions/crypto-prices`);
      const pj = await pr.json();
      if (pj.ok) pj.data.forEach(c => { prices[c.sym] = c.priceRaw; });
    } catch {}

    balRows.forEach(b => {
      if (!balanceMap[b.user_id]) balanceMap[b.user_id] = 0;
      balanceMap[b.user_id] += parseFloat(b.amount) * (prices[b.asset] || 0);
    });
  }

  const enriched = users.map(u => ({
    id:          u.id,
    auth0_sub:   u.auth0_sub,
    email:       u.email,
    name:        u.name,
    picture_url: u.picture_url,
    kyc_status:  u.kyc_status,
    created_at:  u.created_at,
    total_usd:   parseFloat((balanceMap[u.id] || 0).toFixed(2)),
  }));

  return ok({
    users: enriched,
    pagination: {
      page, limit, total,
      total_pages: Math.ceil(total / limit),
      has_next: page * limit < total,
      has_prev: page > 1,
    },
  });
});
