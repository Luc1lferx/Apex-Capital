// netlify/functions/ledger-transaction-create.js
// Creates a new deposit or withdrawal transaction and atomically updates
// the user's balance via the upsert_balance() Postgres function.
//
// POST /.netlify/functions/ledger-transaction-create
// Auth: apex_session cookie required
// Body (JSON):
// {
//   type:    'deposit' | 'withdrawal',
//   asset:   'BTC' | 'ETH' | 'USDT' | 'USDC' | 'SOL',
//   amount:  number,          // in asset units
//   network: string,          // e.g. 'Ethereum (ERC-20)'
//   address: string,          // source (deposit) or destination (withdrawal)
//   tx_hash: string | null,   // optional, can be added later
//   notes:   string | null,
// }

const { supabase, getSession, auditLog, ok, unauth, badReq, serverErr } = require('./_db');
const notify = require('./_notify');

const ALLOWED_ASSETS   = new Set(['BTC', 'ETH', 'USDT', 'USDC', 'SOL']);
const ALLOWED_TYPES    = new Set(['deposit', 'withdrawal']);
const PLATFORM_FEE_PCT = 0.001; // 0.1% on withdrawals

// Approximate USD prices as fallback when live prices are unavailable
const FALLBACK_PRICES = { BTC: 67000, ETH: 3500, USDT: 1, USDC: 1, SOL: 180 };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const session = getSession(event);
  if (!session) return unauth();

  // ── Parse & validate body ─────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return badReq('Invalid JSON'); }

  const { type, asset, amount, network, address, tx_hash = null, notes = null } = body;

  if (!ALLOWED_TYPES.has(type))   return badReq(`Invalid type: ${type}`);
  if (!ALLOWED_ASSETS.has(asset)) return badReq(`Unsupported asset: ${asset}`);
  if (!amount || isNaN(amount) || amount <= 0) return badReq('amount must be a positive number');
  if (type === 'withdrawal' && !address) return badReq('address is required for withdrawals');

  const numAmount = parseFloat(parseFloat(amount).toFixed(8));

  try {
    // ── Lookup internal user ──────────────────────────────────────────────────
    const users = await supabase.get(
      '/rest/v1/users',
      `auth0_sub=eq.${encodeURIComponent(session.sub)}&select=id,kyc_status`
    );
    if (!users.length) return unauth();
    const { id: userId, kyc_status } = users[0];

    if (kyc_status === 'rejected') return badReq('Account suspended. Contact support.');

    // ── Get live USD price ────────────────────────────────────────────────────
    let price = FALLBACK_PRICES[asset] || 1;
    try {
      const priceRes  = await fetch(`${process.env.URL}/.netlify/functions/crypto-prices`);
      const priceJson = await priceRes.json();
      if (priceJson.ok) {
        const coin = priceJson.data.find(c => c.sym === asset);
        if (coin) price = coin.priceRaw;
      }
    } catch { /* use fallback */ }

    const usd_value  = parseFloat((numAmount * price).toFixed(2));

    // ── Compute fees ──────────────────────────────────────────────────────────
    const fee_amount = type === 'withdrawal'
      ? parseFloat((numAmount * PLATFORM_FEE_PCT).toFixed(8))
      : 0;
    const fee_usd = parseFloat((fee_amount * price).toFixed(2));

    // ── Enforce minimum amounts ───────────────────────────────────────────────
    if (type === 'deposit'    && usd_value < 500) return badReq('Minimum deposit is $500 USD equivalent');
    if (type === 'withdrawal' && usd_value < 100) return badReq('Minimum withdrawal is $100 USD equivalent');

    // ── Atomic balance update via Postgres RPC ────────────────────────────────
    // Deposits: credit full amount. Withdrawals: debit amount + fee.
    const delta = type === 'deposit' ? numAmount : -(numAmount + fee_amount);

    try {
      await supabase.rpc('upsert_balance', {
        p_user_id: userId,
        p_asset:   asset,
        p_delta:   delta,
      });
    } catch (err) {
      if (err.message.includes('Insufficient balance')) {
        return badReq('Insufficient balance');
      }
      throw err;
    }

    // ── Create transaction record ─────────────────────────────────────────────
    // Deposits start as 'processing' (awaiting on-chain confirmation).
    // Withdrawals start as 'pending' (awaiting compliance review).
    const status = type === 'deposit' ? 'processing' : 'pending';

    const [tx] = await supabase.post('/rest/v1/transactions', {
      user_id:    userId,
      type,
      asset,
      amount:     numAmount,
      usd_value,
      fee_amount: fee_amount || null,
      fee_usd:    fee_usd    || null,
      status,
      tx_hash,
      network:    network || null,
      address:    address || null,
      notes:      notes   || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // ── Audit log ─────────────────────────────────────────────────────────────
    await auditLog({
      userId,
      action: `${type}_initiated`,
      meta: {
        transaction_id: tx.id,
        asset,
        amount:    numAmount,
        usd_value,
        fee_usd,
        network,
        address,
        status,
      },
      event,
    });

    // ── Email notification (non-blocking) ─────────────────────────────────────
    notify.transactionInitiated({
      userName:  session.name  || session.email,
      userEmail: session.email,
      type,
      asset,
      amount:   numAmount,
      usdValue: usd_value,
      feeUsd:   fee_usd || null,
      status,
      txId:     tx.id,
      ip: event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown',
    }).catch(err => console.error('notify.transactionInitiated error:', err));

    return ok({
      transaction: {
        id:         tx.id,
        type,
        asset,
        amount:     numAmount,
        usd_value,
        fee_amount,
        fee_usd,
        status,
        tx_hash,
        network,
        created_at: tx.created_at,
      },
    });
  } catch (err) {
    console.error('ledger-transaction-create error:', err);
    return serverErr(err.message);
  }
};
