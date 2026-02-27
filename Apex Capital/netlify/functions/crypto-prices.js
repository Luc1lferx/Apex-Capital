// netlify/functions/crypto-prices.js
// Fetches live crypto prices from CoinGecko's free API.
// Endpoint: /.netlify/functions/crypto-prices

const COINS = [
  { id: 'bitcoin',     sym: 'BTC',  icon: '₿',  name: 'Bitcoin'   },
  { id: 'ethereum',    sym: 'ETH',  icon: 'Ξ',  name: 'Ethereum'  },
  { id: 'solana',      sym: 'SOL',  icon: '◎',  name: 'Solana'    },
  { id: 'binancecoin', sym: 'BNB',  icon: '⬡',  name: 'BNB'       },
  { id: 'avalanche-2', sym: 'AVAX', icon: '⬡',  name: 'Avalanche' },
  { id: 'chainlink',   sym: 'LINK', icon: '⬟',  name: 'Chainlink' },
  { id: 'cardano',     sym: 'ADA',  icon: '◈',  name: 'Cardano'   },
  { id: 'matic-network', sym: 'MATIC', icon: '◉', name: 'Polygon' },
];

const COIN_IDS = COINS.map(c => c.id).join(',');

exports.handler = async function () {
  try {
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd` +
      `&ids=${COIN_IDS}` +
      `&order=market_cap_desc` +
      `&price_change_percentage=24h,7d` +
      `&sparkline=false`;

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // If you have a CoinGecko Pro API key, add it here:
        // 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY,
      },
    });

    if (!res.ok) {
      throw new Error(`CoinGecko responded with ${res.status}`);
    }

    const raw = await res.json();

    // Map to a clean shape our frontend expects
    const data = raw.map((coin, i) => {
      const meta = COINS.find(c => c.id === coin.id) || {};
      const change24 = coin.price_change_percentage_24h ?? 0;
      const change7d  = coin.price_change_percentage_7d_in_currency ?? 0;

      return {
        rank:   i + 1,
        id:     coin.id,
        name:   coin.name,
        sym:    meta.sym  || coin.symbol.toUpperCase(),
        icon:   meta.icon || '◎',
        price:  formatPrice(coin.current_price),
        priceRaw: coin.current_price,
        d24:    formatChange(change24),
        d7:     formatChange(change7d),
        cap:    formatCap(coin.market_cap),
        up24:   change24 >= 0,
      };
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Cache for 60 seconds on Netlify's CDN so we don't hammer CoinGecko
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ ok: true, data, fetchedAt: new Date().toISOString() }),
    };
  } catch (err) {
    console.error('crypto-prices error:', err);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

// ── helpers ──────────────────────────────────────────────────────────────────

function formatPrice(n) {
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}

function formatChange(n) {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function formatCap(n) {
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(1)  + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(1)  + 'M';
  return '$' + n.toLocaleString();
}
