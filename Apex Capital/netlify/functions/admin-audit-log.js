// netlify/functions/admin-audit-log.js
// Returns the full audit log across all users, paginated and filterable.
// Admin only.
//
// GET /.netlify/functions/admin-audit-log
// Query params: page=1, limit=50, action=login, user_id=uuid

const { ok, serverErr } = require('./_db');
const { requireAdmin }  = require('./_admin-guard');

exports.handler = requireAdmin(async (event) => {
  const q      = event.queryStringParameters || {};
  const page   = Math.max(1, parseInt(q.page  || '1'));
  const limit  = Math.min(200, parseInt(q.limit || '50'));
  const from   = (page - 1) * limit;
  const to     = from + limit - 1;

  let filter = 'select=id,user_id,action,ip_address,user_agent,meta,created_at,users(email,name)&order=created_at.desc';
  if (q.action  && /^[a-z_]+$/.test(q.action))  filter += `&action=eq.${q.action}`;
  if (q.user_id && /^[0-9a-f-]{36}$/.test(q.user_id)) filter += `&user_id=eq.${q.user_id}`;

  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/audit_log?${filter}`, {
    headers: {
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Range':         `${from}-${to}`,
      'Range-Unit':    'items',
      'Prefer':        'count=exact',
    },
  });

  const rows         = await res.json();
  const contentRange = res.headers.get('content-range') || '';
  const total        = parseInt(contentRange.split('/')[1]) || rows.length;

  const entries = rows.map(r => ({
    id:         r.id,
    user_id:    r.user_id,
    user_email: r.users?.email || null,
    user_name:  r.users?.name  || null,
    action:     r.action,
    ip_address: r.ip_address,
    user_agent: r.user_agent,
    meta:       typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta,
    created_at: r.created_at,
  }));

  return ok({
    entries,
    pagination: {
      page, limit, total,
      total_pages: Math.ceil(total / limit),
      has_next: page * limit < total,
      has_prev: page > 1,
    },
  });
});
