// ═══════════════════════════════════════════════════════
// NEXUS BOT — Server som kör dygnet runt
// Hämtar riktiga priser från CoinGecko + paper-trading + nyhetsveto
// ═══════════════════════════════════════════════════════

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── API-NYCKLAR (läses från Railway Variables, ALDRIG hårdkodade här) ──
const CRYPTOPANIC_KEY = process.env.CRYPTOPANIC_API_KEY || '';
const ALPHAVANTAGE_KEY = process.env.ALPHA_VANTAGE_API_KEY || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── STATE (bot memory) ──
// VIKTIGT: sparas i /app/data/ som är en Railway Volume (permanent lagring)
// Utan detta skulle all data (trades, dagar, kassa) försvinna varje gång koden uppdateras
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');

let state = {
  cash: 1000,
  startCash: 1000,
  holdings: {},        // { BTC: {qty, avgCost}, ... }
  trades: [],          // all trades
  priceHistory: {},    // last 60 prices per asset
  botOn: true,         // bot starts automatically
  cfg: {
    takeProfit: 0.6,     // % vinstmål — INSTÄLLNINGSBAR av användaren
    tradeSize: 8,        // % av kassan per trade — INSTÄLLNINGSBAR
    stopLoss: 1.5,       // % stop loss per enskild trade (fast just nu)
    killSwitchPct: 20    // % nedgång från högsta värde innan NÖDBROMS — INSTÄLLNINGSBAR
  },
  lastTradeAt: {},
  realizedPnl: 0,
  bestTrade: null,
  worstTrade: null,
  winStreak: 0,
  lossStreak: 0,
  startedAt: Date.now(),
  testDurationDays: 14,
  testStartDate: new Date().toISOString().slice(0,10),
  dailySnapshots: [],
  // Nödbroms
  highWaterMark: 1000,      // högsta kontovärde någonsin nått — nödbromsen mäts mot detta
  haltedByKillSwitch: false,
  // Nyhetsveto
  newsVetoEnabled: true,
  newsStatus: {},           // { BTC: {sentiment, blocked, headline, ts} }
  claudeCallsToday: 0,
  claudeCallsDate: new Date().toISOString().slice(0,10),
  maxClaudeCallsPerDay: 40  // utgiftsspärr — max Claude-anrop per dygn
};

// Load saved state if it exists
if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...loaded, cfg: { ...state.cfg, ...(loaded.cfg||{}) } };
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
let logLines = [];
let consecutiveFailures = 0;
let newsCheckIdx = 0;

function log(msg, type='info') {
  const ts = new Date().toISOString().slice(11,19);
  const line = { ts, msg, type };
  logLines.unshift(line);
  if (logLines.length > 200) logLines.length = 200;
  console.log(`[${ts}] ${msg}`);
}

// ═══════════════════════════════════════════════════════
// FETCH REAL PRICES FROM COINGECKO (free, no API key needed)
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

// Wraps the pure technical signal with the news veto layer
function getSignal(assetId) {
  const hist = state.priceHistory[assetId];
  if (!hist || hist.length < 20) return 'HOLD';
  const price = currentPrices[assetId];
  const recent = hist.slice(-20);
  const min = Math.min(...recent), max = Math.max(...recent), range = max-min || 1;
  const posInRange = (price-min)/range;
  const rsi = computeRSI(hist);
  const held = state.holdings[assetId];

  let signal = 'HOLD';
  if (!held) {
    if (posInRange < 0.45 || rsi < 45) signal = 'BUY';
  } else {
    const profitTarget = price > held.avgCost * (1 + state.cfg.takeProfit/100);
    const stopLoss = price < held.avgCost * (1 - state.cfg.stopLoss/100);
    if (stopLoss) signal = 'STOPLOSS';
    else if (profitTarget) signal = 'SELL';
  }

  // Nyhetsveto: blockerar bara NYA köp, tvingar aldrig fram en panik-sälj av befintliga innehav
  if (signal === 'BUY' && state.newsVetoEnabled) {
    const ns = state.newsStatus[assetId];
    if (ns && ns.blocked) return 'VETO';
  }
  return signal;
}

// ═══════════════════════════════════════════════════════
// NYHETSVETO — CryptoPanic + Alpha Vantage (gratis råmaterial) + Claude (tolkning)
// Roterar en tillgång i taget, med hård utgiftsspärr för Claude-anrop
// ═══════════════════════════════════════════════════════
async function fetchCryptoPanicHeadlines(asset) {
  if (!CRYPTOPANIC_KEY) return [];
  try {
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_KEY}&currencies=${asset.id}&public=true`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0,5).map(p => p.title);
  } catch (e) {
    log(`⚠ CryptoPanic fel för ${asset.id}: ${e.message}`, 'error');
    return [];
  }
}

async function fetchAlphaVantageSentiment(asset) {
  if (!ALPHAVANTAGE_KEY) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=CRYPTO:${asset.id}&apikey=${ALPHAVANTAGE_KEY}&limit=5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.feed || [];
    if (!items.length) return null;
    const avgScore = items.reduce((s,i) => s + parseFloat(i.overall_sentiment_score||0), 0) / items.length;
    return { avgScore, headlines: items.slice(0,3).map(i => i.title) };
  } catch (e) {
    log(`⚠ Alpha Vantage fel för ${asset.id}: ${e.message}`, 'error');
    return null;
  }
}

function resetClaudeCounterIfNewDay() {
  const today = new Date().toISOString().slice(0,10);
  if (state.claudeCallsDate !== today) {
    state.claudeCallsDate = today;
    state.claudeCallsToday = 0;
  }
}

async function interpretNewsWithClaude(asset, headlines, avScore) {
  resetClaudeCounterIfNewDay();
  if (state.claudeCallsToday >= state.maxClaudeCallsPerDay) {
    log(`💰 Claude-gräns nådd för idag (${state.maxClaudeCallsPerDay} anrop) — hoppar över AI-tolkning`, 'system');
    return null;
  }
  if (!CLAUDE_KEY) return null;
  if (!headlines.length) return null;

  try {
    state.claudeCallsToday++;
    const prompt = `Analysera dessa nyhetsrubriker om ${asset.name} (${asset.id}) och bedöm om det finns TYDLIGT NEGATIVA nyheter (skandal, hack, stämning, kraftig nedgradering) som motiverar att INTE köpa just nu.\n\nRubriker:\n${headlines.map(h=>'- '+h).join('\n')}\n${avScore!=null?`\nAlpha Vantage sentiment-poäng: ${avScore.toFixed(2)} (negativ under -0.15, positiv över 0.15)`:''}\n\nSvara ENDAST med giltig JSON, inget annat: {"blocked":true|false,"sentiment":"positive"|"neutral"|"negative","headline":"sammanfattning max 12 ord"}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    const txt = (data.content || []).filter(b=>b.type==='text').map(b=>b.text).join('');
    const m = txt.match(/\{[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) {
    log(`⚠ Claude-tolkning misslyckades: ${e.message}`, 'error');
  }
  return null;
}

async function checkNewsForAsset(assetId) {
  const asset = ASSETS.find(a => a.id === assetId);
  if (!asset) return;

  const [headlines, avSentiment] = await Promise.all([
    fetchCryptoPanicHeadlines(asset),
    fetchAlphaVantageSentiment(asset)
  ]);
  const allHeadlines = [...headlines, ...(avSentiment?.headlines || [])];

  if (!allHeadlines.length) {
    // Inga källor konfigurerade eller inga nyheter hittades — inget veto, teknisk analys styr själv
    if (!CRYPTOPANIC_KEY && !ALPHAVANTAGE_KEY) {
      state.newsStatus[assetId] = { sentiment:'neutral', blocked:false, headline:'Nyhetskällor ej konfigurerade (saknar API-nycklar)', ts:new Date().toLocaleTimeString('sv-SE') };
    }
    return;
  }

  const claudeResult = await interpretNewsWithClaude(asset, allHeadlines, avSentiment?.avgScore);

  let result;
  if (claudeResult) {
    result = claudeResult;
  } else {
    // Fallback: använd bara Alpha Vantage-poängen om Claude inte kunde tolka (gräns nådd eller fel)
    const score = avSentiment?.avgScore ?? 0;
    result = {
      blocked: score < -0.25,
      sentiment: score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral',
      headline: allHeadlines[0]?.slice(0,80) || 'Ingen tydlig signal'
    };
  }

  state.newsStatus[assetId] = { ...result, ts: new Date().toLocaleTimeString('sv-SE') };
  if (result.blocked) {
    log(`🛡️ VETO: ${asset.id} — nya köp blockerade — ${result.headline}`, 'veto');
  }
  saveState();
}

function newsCheckCycle() {
  if (!state.newsVetoEnabled) return;
  const asset = ASSETS[newsCheckIdx % ASSETS.length];
  newsCheckIdx++;
  checkNewsForAsset(asset.id).catch(e => log(`⚠ Nyhetscheck fel: ${e.message}`, 'error'));
}

// ═══════════════════════════════════════════════════════
// NÖDBROMS — stoppar boten helt om kontot faller för mycket från sin topp
// ═══════════════════════════════════════════════════════
function checkKillSwitch(totalVal) {
  if (totalVal > state.highWaterMark) state.highWaterMark = totalVal;
  const dropPct = ((state.highWaterMark - totalVal) / state.highWaterMark) * 100;

  if (!state.haltedByKillSwitch && dropPct >= state.cfg.killSwitchPct) {
    state.botOn = false;
    state.haltedByKillSwitch = true;
    log(`🛑 NÖDBROMS AKTIVERAD: kontot föll ${dropPct.toFixed(1)}% från högsta värde (${state.highWaterMark.toFixed(0)} kr). Boten är stoppad — starta manuellt när du granskat läget.`, 'error');
    saveState();
  }
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
    const cooldown = 60000; // 1 min cooldown per asset — allows fairly frequent scalping without spamming trades
    if (Date.now() - lastT < cooldown) return;

    const signal = getSignal(asset.id);

    if (signal === 'VETO') {
      return; // teknisk köpsignal men nyheter blockerar — gör ingenting, ingen loggning varje gång för att undvika spam
    }
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

  // Nödbroms-koll efter varje tick
  const portVal = Object.entries(state.holdings)
    .reduce((s,[id,h]) => s + (currentPrices[id] || h.avgCost) * h.qty, 0);
  checkKillSwitch(state.cash + portVal);

  saveState();
}

// ═══════════════════════════════════════════════════════
// DAILY SNAPSHOT — captures progress once per day for the overview chart
// ═══════════════════════════════════════════════════════
function checkDailySnapshot() {
  const today = new Date().toISOString().slice(0,10);
  const last = state.dailySnapshots[state.dailySnapshots.length - 1];
  if (last && last.date === today) return;

  const portVal = Object.entries(state.holdings)
    .reduce((s,[id,h]) => s + (currentPrices[id] || h.avgCost) * h.qty, 0);
  const totalVal = state.cash + portVal;

  state.dailySnapshots.push({ date: today, totalVal, trades: state.trades.length });
  if (state.dailySnapshots.length > 90) state.dailySnapshots.shift();
  saveState();
  log(`📅 Ny dag: ${today} — kontovärde ${totalVal.toFixed(0)} kr`, 'system');
}

// Plain-language verdict based on real results so far
function getVerdict() {
  const portVal = Object.entries(state.holdings)
    .reduce((s,[id,h]) => s + (currentPrices[id] || h.avgCost) * h.qty, 0);
  const totalVal = state.cash + portVal;
  const pnlPct = ((totalVal - state.startCash) / state.startCash) * 100;
  const sellTrades = state.trades.filter(t => t.pnl !== undefined);
  const wins = sellTrades.filter(t => t.pnl > 0).length;
  const winRate = sellTrades.length > 0 ? (wins/sellTrades.length*100) : null;
  const daysElapsed = state.dailySnapshots.length || 1;

  if (state.haltedByKillSwitch) {
    return {
      status: 'nödbroms',
      icon: '🛑',
      color: 'red',
      title: 'NÖDBROMS AKTIVERAD',
      text: `Kontot föll ${state.cfg.killSwitchPct}% eller mer från sitt högsta värde. Boten är stoppad tills du granskat läget och startar den manuellt igen.`
    };
  }
  if (sellTrades.length < 5 || daysElapsed < 2) {
    return {
      status: 'samlar-data',
      icon: '🔬',
      color: 'cyan',
      title: 'Samlar data',
      text: `Boten behöver fler trades och dagar innan vi kan säga något säkert. ${sellTrades.length} avslutade trades hittills.`
    };
  }
  if (pnlPct > 0 && winRate >= 55) {
    return {
      status: 'bra',
      icon: '✅',
      color: 'green',
      title: 'Går bra',
      text: `Kontot är upp ${pnlPct.toFixed(1)}% med ${winRate.toFixed(0)}% träffsäkerhet. Fortsätt låta den köra.`
    };
  }
  if (pnlPct >= -3 && winRate >= 40) {
    return {
      status: 'osäkert',
      icon: '⚠️',
      color: 'amber',
      title: 'Osäkert läge',
      text: `Kontot är ${pnlPct>=0?'upp':'ner'} ${Math.abs(pnlPct).toFixed(1)}% med ${winRate.toFixed(0)}% träffsäkerhet. För tidigt att dra slutsatser — låt den fortsätta.`
    };
  }
  return {
    status: 'dåligt',
    icon: '❌',
    color: 'red',
    title: 'Går dåligt',
    text: `Kontot är ner ${Math.abs(pnlPct).toFixed(1)}% med bara ${winRate?.toFixed(0)}% träffsäkerhet. Om detta fortsätter bör strategin justeras.`
  };
}

// ═══════════════════════════════════════════════════════
// INTERVALS
// ═══════════════════════════════════════════════════════
setInterval(fetchPrices, 30000);              // every 30 sec
setInterval(botTick, 30000);                  // check for trades every 30 sec
setInterval(checkDailySnapshot, 60000 * 10);  // check every 10 min if a new day has started
setInterval(newsCheckCycle, 60000 * 20);      // nyhetscheck: en tillgång var 20:e minut (håller oss inom gratis-gränser + Claude-budget)

fetchPrices().then(() => {
  log('✓ NEXUS bot startad — hämtar riktiga priser från CoinGecko', 'system');
  checkDailySnapshot();
  if (CRYPTOPANIC_KEY || ALPHAVANTAGE_KEY) {
    log('🛡️ Nyhetsveto aktivt — CryptoPanic/Alpha Vantage konfigurerat', 'system');
    newsCheckCycle();
  } else {
    log('⚠️ Nyhetsveto: inga API-nycklar konfigurerade i Railway Variables ännu', 'system');
  }
});

// ═══════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════
app.get('/api/status', (req, res) => {
  const portVal = Object.entries(state.holdings)
    .reduce((s,[id,h]) => s + (currentPrices[id] || h.avgCost) * h.qty, 0);
  const totalVal = state.cash + portVal;
  const daysElapsed = state.dailySnapshots.length || 1;
  const daysRemaining = Math.max(0, state.testDurationDays - daysElapsed);

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
    cfg: state.cfg,
    logs: logLines.slice(0, 60),
    bestTrade: state.bestTrade,
    worstTrade: state.worstTrade,
    winStreak: state.winStreak,
    startedAt: state.startedAt,
    lastPriceUpdate,
    assets: ASSETS,
    signals: Object.fromEntries(ASSETS.map(a => [a.id, getSignal(a.id)])),
    testDurationDays: state.testDurationDays,
    testStartDate: state.testStartDate,
    daysElapsed,
    daysRemaining,
    dailySnapshots: state.dailySnapshots,
    verdict: getVerdict(),
    highWaterMark: state.highWaterMark,
    haltedByKillSwitch: state.haltedByKillSwitch,
    newsVetoEnabled: state.newsVetoEnabled,
    newsStatus: state.newsStatus,
    claudeCallsToday: state.claudeCallsToday,
    maxClaudeCallsPerDay: state.maxClaudeCallsPerDay,
    newsConfigured: !!(CRYPTOPANIC_KEY || ALPHAVANTAGE_KEY)
  });
});

app.post('/api/toggle', express.json(), (req, res) => {
  state.botOn = !state.botOn;
  if (state.botOn) state.haltedByKillSwitch = false; // manuell omstart återställer nödbromsen
  log(state.botOn ? 'Bot startad (manuellt)' : 'Bot stoppad (manuellt)', 'system');
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
  state.testStartDate = new Date().toISOString().slice(0,10);
  state.dailySnapshots = [];
  state.highWaterMark = 1000;
  state.haltedByKillSwitch = false;
  log('Bot återställd — ny testperiod startad', 'system');
  saveState();
  res.json({ ok: true });
});

// Uppdatera reglagen: kapital/trade, vinstmål, nödbroms-gräns
app.post('/api/config', express.json(), (req, res) => {
  const { tradeSize, takeProfit, killSwitchPct } = req.body;
  if (tradeSize != null) state.cfg.tradeSize = Math.max(1, Math.min(50, parseFloat(tradeSize)));
  if (takeProfit != null) state.cfg.takeProfit = Math.max(0.1, Math.min(10, parseFloat(takeProfit)));
  if (killSwitchPct != null) state.cfg.killSwitchPct = Math.max(5, Math.min(50, parseFloat(killSwitchPct)));
  log(`⚙ Inställningar uppdaterade: kapital/trade ${state.cfg.tradeSize}%, vinstmål ${state.cfg.takeProfit}%, nödbroms ${state.cfg.killSwitchPct}%`, 'system');
  saveState();
  res.json({ cfg: state.cfg });
});

app.post('/api/toggle-news', express.json(), (req, res) => {
  state.newsVetoEnabled = !state.newsVetoEnabled;
  log(state.newsVetoEnabled ? 'Nyhetsveto aktiverat' : 'Nyhetsveto avaktiverat', 'system');
  saveState();
  res.json({ newsVetoEnabled: state.newsVetoEnabled });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  log(`✓ NEXUS server körs på port ${PORT}`, 'system');
});
