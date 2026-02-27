// netlify/functions/deposit-create.js
// Creates a Coinbase Commerce charge (unique deposit address) for the
// authenticated user. Stores the charge in deposit_charges table.
//
// POST /.netlify/functions/deposit-create
// Auth: apex_session cookie required
// Body: { asset: 'BTC'|'ETH'|'USDT'|'USDC'|'SOL', amount_usd: number }
//
// Required env vars:
//   COINBASE_COMMERCE_API_KEY   from Coinbase Commerce dashboard → Settings → API keys
//   URL                         your Netlify site URL

const { supabase, getSession, auditLog, ok, badReq, unauth, serverErr } = require('./_db');

const COINBASE_API = 'https://api.commerce.coinbase.com';

// Map our asset symbols to Coinbase Commerce currency codes
const ASSET_MAP = {
  BTC:  'BTC',
  ETH:  'ETH',
  USDT: 'USDT',
  USDC: 'USDC',
  SOL:  'SOL',
};

// Confirmation thresholds per asset before crediting
const CONFIRM_THRESHOLDS = {
  BTC:  parseInt(process.env.CONFIRM_THRESHOLD_BTC  || '3'),
  ETH:  parseInt(process.env.CONFIRM_THRESHOLD_ETH  || '2'),
  USDT: parseInt(process.env.CONFIRM_THRESHOLD_USDT || '2'),
  USDC: parseInt(process.env.CONFIRM_THRESHOLD_USDC || '2'),
  SOL:  parseInt(process.env.CONFIRM_THRESHOLD_SOL  || '2'),
};

const MINIMUM_USD = 500; // platform minimum

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const session = getSession(event);
  if (!session) return unauth();

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return badReq('Invalid JSON'); }

  const { asset, amount_usd } = body;

  if (!ASSET_MAP[asset])                      return badReq(`Unsupported asset: ${asset}`);
  if (!amount_usd || isNaN(amount_usd))       return badReq('amount_usd is required');
  if (parseFloat(amount_usd) < MINIMUM_USD)   return badReq(`Minimum deposit is $${MINIMUM_USD} USD`);

  const numAmountUsd = parseFloat(parseFloat(amount_usd).toFixed(2));

  try {
    // 1. Look up internal user
    const users = await supabase.get(
      '/rest/v1/users',
      `auth0_sub=eq.${encodeURIComponent(session.sub)}&select=id,email,name,kyc_status`
    );
    if (!users.length) return unauth();
    const user = users[0];

    // 2. Check for an existing pending charge for same user+asset to avoid duplicates
    const existing = await supabase.get(
      '/rest/v1/deposit_charges',
      `user_id=eq.${user.id}&asset=eq.${asset}&status=eq.pending&select=id,coinbase_charge_id,hosted_url,deposit_address,expires_at`
    );
    if (existing.length) {
      // Return the existing charge if it hasn't expired
      const charge = existing[0];
      const expiresAt = new Date(charge.expires_at);
      if (expiresAt > new Date()) {
        return ok({
          charge_id:       charge.id,
          coinbase_id:     charge.coinbase_charge_id,
          deposit_address: charge.deposit_address,
          hosted_url:      charge.hosted_url,
          expires_at:      charge.expires_at,
          asset,
          amount_usd:      numAmountUsd,
          reused:          true,
        });
      }
      // Expired — fall through to create a new one
    }

    // 3. Create charge via Coinbase Commerce API
    const chargePayload = {
      name:        `Apex Capital Deposit`,
      description: `${asset} deposit for ${user.email}`,
      pricing_type: 'fixed_price',
      local_price: {
        amount:   numAmountUsd.toString(),
        currency: 'USD',
      },
      requested_info: [], // we already know the user
      metadata: {
        user_id:    user.id,
        user_email: user.email,
        asset,
        platform:   'apex_capital',
      },
      redirect_url: `${process.env.URL}/dashboard.html?deposit=success`,
      cancel_url:   `${process.env.URL}/dashboard.html?deposit=cancelled`,
    };

    const cbRes = await fetch(`${COINBASE_API}/charges`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-CC-Api-Key':  process.env.COINBASE_COMMERCE_API_KEY,
        'X-CC-Version':  '2018-03-22',
      },
      body: JSON.stringify(chargePayload),
    });

    if (!cbRes.ok) {
      const err = await cbRes.text();
      console.error('Coinbase Commerce error:', err);
      return serverErr('Failed to create deposit charge. Please try again.');
    }

    const { data: charge } = await cbRes.json();

    // 4. Extract the deposit address for the requested asset
    const addresses  = charge.addresses  || {};
    const pricing    = charge.pricing    || {};
    const depositAddress = addresses[ASSET_MAP[asset].toLowerCase()] || null;

    // Coinbase gives crypto amount in pricing
    const cryptoAmount = pricing[ASSET_MAP[asset].toLowerCase()]?.amount || null;

    // Charge expires in 60 minutes
    const expiresAt = charge.expires_at || new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // 5. Store in deposit_charges table
    const [dbCharge] = await supabase.post('/rest/v1/deposit_charges', {
      user_id:             user.id,
      coinbase_charge_id:  charge.id,
      coinbase_charge_code: charge.code,
      asset,
      amount_usd:          numAmountUsd,
      crypto_amount:       cryptoAmount ? parseFloat(cryptoAmount) : null,
      deposit_address:     depositAddress,
      hosted_url:          charge.hosted_url,
      status:              'pending',
      confirmations:       0,
      confirm_threshold:   CONFIRM_THRESHOLDS[asset],
      credited:            false,
      expires_at:          expiresAt,
      created_at:          new Date().toISOString(),
      updated_at:          new Date().toISOString(),
    });

    // 6. Audit log
    await auditLog({
      userId: user.id,
      action: 'deposit_charge_created',
      meta: {
        charge_id:      dbCharge.id,
        coinbase_id:    charge.id,
        asset,
        amount_usd:     numAmountUsd,
        crypto_amount:  cryptoAmount,
        deposit_address: depositAddress,
      },
      event,
    });

    return ok({
      charge_id:       dbCharge.id,
      coinbase_id:     charge.id,
      deposit_address: depositAddress,
      crypto_amount:   cryptoAmount,
      hosted_url:      charge.hosted_url,
      expires_at:      expiresAt,
      asset,
      amount_usd:      numAmountUsd,
      confirm_threshold: CONFIRM_THRESHOLDS[asset],
    });

  } catch (err) {
    console.error('deposit-create error:', err);
    return serverErr(err.message);
  }
};
