// ═══════════════════════════════════════════════════════
// NEXUS BOT — Server som kör dygnet runt
// Hämtar riktiga priser från CoinGecko + paper-trading
// ═══════════════════════════════════════════════════════

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── STATE (bot memory) ──
// Data sparas i state.json så boten kommer ihåg allt även efter omstart
const STATE_FILE = path.join(__dirname, 'state.json');
let state = {
  cash: 1000,
  startCash: 1000,
  holdings: {},        // { BTC: {qty, avgCost}, ... }
  trades: [],          // all trades
  priceHistory: {},    // last 60 prices per asset
  botOn: true,         // bot starts automatically
  mode: 'smart',
  cfg: { takeProfit: 1.2, tradeSize: 8, stopLoss: 2.0 },
  lastTradeAt: {},
  realizedPnl: 0,
  bestTrade: null,
  worstTrade: null,
  winStreak: 0,
  lossStreak: 0,
  startedAt: Date.now()
};

// Load saved state if it exists
if (fs.existsSync(STATE_FILE)) {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    console.log('✓ Loaded saved state');
  } catch (e) { console.log('⚠ Could not load state, starting fresh'); }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── ASSETS (CoinGecko IDs) ──
const ASSETS = [
  { id: 'BTC',  cgId: 'bitcoin',    name: 'Bitcoin',  color: '#F7931A' },
  { id: 'ETH',  cgId: 'ethereum',   name: 'Ethereum', color: '#627EEA' },
  { id: 'SOL',  cgId: 'solana',     name: 'Solana',   color: '#9945FF' },
  { id: 'XRP',  cgId: 'ripple',     name: 'Ripple',   color: '#00AAE4' },
  { id: 'DOGE', cgId: 'dogecoin',   name: 'Dogecoin', color: '#C2A633' },
  { id: 'BNB',  cgId: 'binancecoin',name: 'BNB',      color: '#F3BA2F' },
];

let currentPrices = {};
let lastPriceUpdate = 0;
let logLines = [];  // recent log for dashboard
let consecutiveFailures = 0;

function log(msg, type='info') {
  const ts = new Date().toISOString().slice(11,19);
  const line = { ts, msg, type };
  logLines.unshift(line);
  if (logLines.length > 200) logLines.length = 200;
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════
// FETCH REAL PRICES FROM COINGECKO (free, no API key needed)
// CoinGecko's free tier allows ~10-30 calls/min — we stay well under that
// ═══════════════════════════════════════════════════════
async function fetchPrices() {
  try {
    const ids = ASSETS.map(a => a.cgId).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=sek`;
    const res = await fetch(url);

    if (res.status === 429) {
      consecutiveFailures++;
      log(`⚠ CoinGecko: för många förfrågningar (429). Väntar längre nästa gång.`, 'error');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    consecutiveFailures = 0;

    ASSETS.forEach(a => {
      const price = data[a.cgId]?.sek;
      if (price) {
        currentPrices[a.id] = price;
        if (!state.priceHistory[a.id]) state.priceHistory[a.id] = [];
        state.priceHistory[a.id].push(price);
        if (state.priceHistory[a.id].length > 60) state.priceHistory[a.id].shift();
      }
    });
    lastPriceUpdate = Date.now();
  } catch (e) {
    consecutiveFailures++;
    log(`⚠ Prisfetch misslyckades: ${e.message}`, 'error');
  }
}

// ═══════════════════════════════════════════════════════
// TECHNICAL SIGNALS
// ═══════════════════════════════════════════════════════
function computeRSI(hist, period=14) {
  if (hist.length < period+1) return 50;
  const recent = hist.slice(-period-1);
  let gains=0, losses=0;
  for (let i=1; i<recent.length; i++) {
    const d = recent[i]-recent[i-1];
    if (d>0) gains+=d; else losses-=d;
  }
  const avgG = gains/period, avgL = losses/period;
  if (avgL === 0) return 100;
  return 100 - (100/(1 + avgG/avgL));
}

function getSignal(assetId) {
  const hist = state.priceHistory[assetId];
  if (!hist || hist.length < 20) return 'HOLD';
  const price = currentPrices[assetId];
  const recent = hist.slice(-20);
  const min = Math.min(...recent), max = Math.max(...recent), range = max-min || 1;
  const posInRange = (price-min)/range;
  const rsi = computeRSI(hist);
  const ma5 = hist.slice(-5).reduce((a,b)=>a+b,0) / Math.min(5, hist.length);
  const held = state.holdings[assetId];

  if (!held) {
    const oversold = rsi < 38;
    const nearLow = posInRange < 0.3;
    const notFalling = price >= ma5 * 0.998;
    if ((oversold || nearLow) && notFalling) return 'BUY';
  } else {
    const overbought = rsi > 62;
    const nearHigh = posInRange > 0.75;
    const profitTarget = price > held.avgCost * (1 + state.cfg.takeProfit/100);
    const stopLoss = price < held.avgCost * (1 - state.cfg.stopLoss/100);
    if (stopLoss) return 'STOPLOSS';
    if (profitTarget || overbought || nearHigh) return 'SELL';
  }
  return 'HOLD';
}

// ═══════════════════════════════════════════════════════
// BOT TICK — check all assets, execute trades
// ═══════════════════════════════════════════════════════
function botTick() {
  if (!state.botOn) return;

  ASSETS.forEach(asset => {
    const price = currentPrices[asset.id];
    if (!price) return;

    const lastT = state.lastTradeAt[asset.id] || 0;
    const cooldown = 30000; // 30 sec cooldown per asset (real markets move slower)
    if (Date.now() - lastT < cooldown) return;

    const signal = getSignal(asset.id);

    if (signal === 'BUY') {
      const usd = state.cash * (state.cfg.tradeSize/100);
      if (usd < 10 || usd > state.cash) return;
      const qty = usd / price;
      state.cash -= usd;
      const cur = state.holdings[asset.id] || { qty:0, avgCost:0 };
      const nq = cur.qty + qty;
      const na = (cur.qty*cur.avgCost + usd) / nq;
      state.holdings[asset.id] = { qty:nq, avgCost:na };
      state.trades.unshift({
        id: Date.now(), side: 'BUY', assetId: asset.id, name: asset.name,
        qty, price, usd, ts: new Date().toLocaleTimeString('sv-SE'),
        date: new Date().toISOString().slice(0,10)
      });
      state.lastTradeAt[asset.id] = Date.now();
      log(`🟢 KÖP ${asset.id} för ${usd.toFixed(0)} kr @ ${price.toFixed(0)} kr`, 'buy');
    } else if (signal === 'SELL' || signal === 'STOPLOSS') {
      const h = state.holdings[asset.id];
      if (!h || h.qty <= 0) return;
      const usd = h.qty * price;
      const pnl = (price - h.avgCost) * h.qty;
      state.cash += usd;
      state.realizedPnl += pnl;
      delete state.holdings[asset.id];
      state.trades.unshift({
        id: Date.now(), side: 'SÄLJ', assetId: asset.id, name: asset.name,
        qty: h.qty, price, usd, pnl,
        exitReason: signal === 'STOPLOSS' ? 'SL' : 'TP',
        ts: new Date().toLocaleTimeString('sv-SE'),
        date: new Date().toISOString().slice(0,10)
      });
      state.lastTradeAt[asset.id] = Date.now();
      if (pnl > 0) { state.winStreak++; state.lossStreak = 0; }
      else { state.lossStreak++; state.winStreak = 0; }
      if (state.bestTrade === null || pnl > state.bestTrade) state.bestTrade = pnl;
      if (state.worstTrade === null || pnl < state.worstTrade) state.worstTrade = pnl;
      const emoji = signal === 'STOPLOSS' ? '🛑' : '🎯';
      log(`${emoji} SÄLJ ${asset.id} @ ${price.toFixed(0)} kr — PnL: ${pnl>=0?'+':''}${pnl.toFixed(1)} kr`, pnl>=0?'sell-win':'sell-loss');
    }
  });

  if (state.trades.length > 500) state.trades = state.trades.slice(0, 500);
  saveState();
}

// ═══════════════════════════════════════════════════════
// INTERVALS
// ═══════════════════════════════════════════════════════
setInterval(fetchPrices, 45000); // every 45 sec — stays safely under CoinGecko's free rate limit
setInterval(botTick, 60000);     // check for trades every 60 sec (real markets move slower than our old demo)

// Fetch initial prices immediately
fetchPrices().then(() => log('✓ NEXUS bot startad — hämtar riktiga priser från CoinGecko', 'system'));

// ═══════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  const portVal = Object.entries(state.holdings)
    .reduce((s,[id,h]) => s + (currentPrices[id] || h.avgCost) * h.qty, 0);
  const totalVal = state.cash + portVal;

  res.json({
    prices: currentPrices,
    priceHistory: state.priceHistory,
    holdings: state.holdings,
    cash: state.cash,
    startCash: state.startCash,
    totalVal,
    pnl: totalVal - state.startCash,
    realizedPnl: state.realizedPnl,
    trades: state.trades.slice(0, 100),
    botOn: state.botOn,
    mode: state.mode,
    cfg: state.cfg,
    logs: logLines.slice(0, 60),
    bestTrade: state.bestTrade,
    worstTrade: state.worstTrade,
    winStreak: state.winStreak,
    startedAt: state.startedAt,
    lastPriceUpdate,
    assets: ASSETS,
    signals: Object.fromEntries(ASSETS.map(a => [a.id, getSignal(a.id)]))
  });
});

app.post('/api/toggle', express.json(), (req, res) => {
  state.botOn = !state.botOn;
  log(state.botOn ? 'Bot startad' : 'Bot stoppad', 'system');
  saveState();
  res.json({ botOn: state.botOn });
});

app.post('/api/reset', express.json(), (req, res) => {
  state.cash = 1000;
  state.startCash = 1000;
  state.holdings = {};
  state.trades = [];
  state.realizedPnl = 0;
  state.bestTrade = null;
  state.worstTrade = null;
  state.winStreak = 0;
  state.lossStreak = 0;
  state.startedAt = Date.now();
  log('Bot återställd', 'system');
  saveState();
  res.json({ ok: true });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  log(`✓ NEXUS server körs på port ${PORT}`, 'system');
});
