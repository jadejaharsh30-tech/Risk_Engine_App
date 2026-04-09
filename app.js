// app.js — Bundled Risk Engine (Universal Compatibility)

const Auth = {
  async signup(username, password) {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Signup failed');
    }
    return true;
  },
  async login(username, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) throw new Error('Invalid credentials');
    const data = await res.json();
    this.updateUI(data.username);
    return true;
  },
  async logout() {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  },
  async deleteAccount() {
    const res = await fetch('/api/delete_account', { method: 'POST' });
    if (!res.ok) throw new Error('Account deletion failed');
    location.reload();
  },
  updateUI(username) {
    const modal = document.getElementById('modal-auth');
    const profile = document.getElementById('user-profile');
    if (username) {
      if (modal) modal.classList.add('hidden');
      if (profile) {
        profile.classList.remove('hidden');
        document.getElementById('user-display-name').textContent = username;
        document.getElementById('user-initials').textContent = username[0].toUpperCase();
      }
    } else {
      if (modal) modal.classList.remove('hidden');
      if (profile) profile.classList.add('hidden');
    }
  }
};

// ==========================================
// 1. CALC MODULE
// ==========================================
const Calc = {
  money: (n) => "₹" + Number(n || 0).toLocaleString(),
  nowDate: () => new Date().toISOString().slice(0, 10),

  calculateRiskQty(R, entry, exit) {
    const riskPerShare = Math.abs(entry - exit);
    if (!riskPerShare) return { riskPerShare: 0, qty: 0 };
    const qty = Math.floor(R / riskPerShare);
    return { riskPerShare, qty };
  },

  enforceLotSize(qty, lot, mode = 'down') {
    if (qty <= 0 || lot <= 0) return 0;
    if (qty < lot) {
      if (mode === 'up') return lot;
      return 0; // if round down and < lot, then 0? Or min 1 lot? User constraint says "if qty rounded down, i need option to round up"
      // Let's stick to safe defaults.
    }

    const raw = qty / lot;
    if (mode === 'up') return Math.ceil(raw) * lot;
    return Math.floor(raw) * lot;
  },

  computeWinRate(trades) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    const wins = closed.filter(t => Number(t.realized_pnl || 0) >= 0).length;
    return (wins / closed.length) * 100;
  },

  computeProfitFactor(trades) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    const grossProfit = closed.filter(t => t.realized_pnl > 0).reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const grossLoss = Math.abs(closed.filter(t => t.realized_pnl < 0).reduce((a, b) => a + Number(b.realized_pnl || 0), 0));
    if (grossLoss === 0) return grossProfit ? Infinity : null;
    return grossProfit / grossLoss;
  },

  computeAvgTrade(trades) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    return closed.reduce((a, b) => a + Number(b.realized_pnl || 0), 0) / closed.length;
  },

  computeAvgRMultiple(trades, systems) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    let sum = 0, count = 0;
    closed.forEach(t => {
      const sys = systems.find(s => s.name === t.system);
      const R = t.R_at_entry || (sys ? (sys.R || 0) : 0);
      if (R && t.realized_pnl != null) {
        sum += (t.realized_pnl / R);
        count++;
      }
    });
    return count ? (sum / count) : null;
  },

  estimateMaxDrawdown(trades) {
    const closed = [...trades].filter(t => t.status === 'Closed').sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!closed.length) return null;
    let cum = 0, peak = 0, maxdd = 0;
    closed.forEach(t => {
      cum += Number(t.realized_pnl || 0);
      if (cum > peak) peak = cum;
      const dd = (peak - cum);
      if (dd > maxdd) maxdd = dd;
    });
    if (peak <= 0) return null; // No profitable peak — can't compute meaningful %
    return (maxdd / peak) * 100;
  },

  computeSystemMetrics(sys, trades) {
    const openTrades = trades.filter(t => t.system === sys.name && t.status === 'Open');
    const closedTrades = trades.filter(t => t.system === sys.name && t.status === 'Closed');
    const riskInPlay = openTrades.reduce((a, b) => a + Number(b.total_risk || b.actual_risk || 0), 0);
    const unrealized = openTrades.reduce((a, b) => {
      const dir = (b.direction === 'Short') ? -1 : 1;
      return a + (dir * (Number(b.mark_price || 0) - Number(b.entry || 0)) * Number(b.final_qty || 0));
    }, 0);
    const realized = closedTrades.reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const maxTrades = sys.capital && sys.R ? Math.floor(sys.capital / sys.R) : 0;
    const openCount = openTrades.length;
    const capacityLeft = sys.capital ? Math.max(0, sys.capital - riskInPlay) : 0;
    return { openTrades, closedTrades, riskInPlay, unrealized, realized, maxTrades, openCount, capacityLeft };
  },

  computeExposure(trades) {
    const open = trades.filter(t => t.status === 'Open');
    const totalRisk = open.reduce((a, b) => a + Number(b.total_risk || b.actual_risk || 0), 0);
    const bySystem = {};
    open.forEach(t => {
      if (!bySystem[t.system]) bySystem[t.system] = 0;
      bySystem[t.system] += Number(t.total_risk || t.actual_risk || 0);
    });
    const byType = { Futures: 0, Options: 0 };
    open.forEach(t => {
      const type = t.optionType ? 'Options' : 'Futures';
      byType[type] += Number(t.total_risk || t.actual_risk || 0);
    });
    return { totalRisk, bySystem, byType };
  },

  getDailyRealizedPnL(trades) {
    const today = this.nowDate();
    return trades
      .filter(t => t.status === 'Closed' && t.close_date === today)
      .reduce((sum, t) => sum + Number(t.realized_pnl || 0), 0);
  },

  computeTagAnalytics(trades) {
    const stats = {};
    const closed = trades.filter(t => t.status === 'Closed');
    closed.forEach(t => {
      const tags = (t.tags || []);
      const tagList = tags.length ? tags : ['(no tag)'];
      tagList.forEach(tag => {
        if (!stats[tag]) stats[tag] = { count: 0, wins: 0, grossProfit: 0, grossLoss: 0, totalPnL: 0 };
        const s = stats[tag];
        s.count++;
        const pnl = Number(t.realized_pnl || 0);
        s.totalPnL += pnl;
        if (pnl > 0) { s.wins++; s.grossProfit += pnl; }
        else { s.grossLoss += Math.abs(pnl); }
      });
    });
    return Object.keys(stats).map(tag => {
      const s = stats[tag];
      const winRate = (s.wins / s.count) * 100;
      const pf = s.grossLoss === 0 ? (s.grossProfit ? 100 : 0) : s.grossProfit / s.grossLoss;
      return { tag, ...s, winRate, pf };
    }).sort((a, b) => b.totalPnL - a.totalPnL);
  }
};

// ==========================================
// 1B. BUNDLED NSE F&O INSTRUMENT MASTER
// ==========================================
const DEFAULT_NSE_MASTER = [
  // === INDICES ===
  { symbol: "NIFTY", lot: 75, type: "Futures" },
  { symbol: "BANKNIFTY", lot: 30, type: "Futures" },
  { symbol: "FINNIFTY", lot: 60, type: "Futures" },
  { symbol: "MIDCPNIFTY", lot: 120, type: "Futures" },
  { symbol: "NIFTYNXT50", lot: 25, type: "Futures" },
  // === STOCKS ===
  { symbol: "RELIANCE", lot: 250, type: "Futures" },
  { symbol: "TCS", lot: 150, type: "Futures" },
  { symbol: "HDFCBANK", lot: 550, type: "Futures" },
  { symbol: "INFY", lot: 300, type: "Futures" },
  { symbol: "ICICIBANK", lot: 700, type: "Futures" },
  { symbol: "SBIN", lot: 1500, type: "Futures" },
  { symbol: "BHARTIARTL", lot: 475, type: "Futures" },
  { symbol: "ITC", lot: 1600, type: "Futures" },
  { symbol: "KOTAKBANK", lot: 400, type: "Futures" },
  { symbol: "LT", lot: 150, type: "Futures" },
  { symbol: "AXISBANK", lot: 625, type: "Futures" },
  { symbol: "HINDUNILVR", lot: 300, type: "Futures" },
  { symbol: "BAJFINANCE", lot: 125, type: "Futures" },
  { symbol: "MARUTI", lot: 100, type: "Futures" },
  { symbol: "SUNPHARMA", lot: 350, type: "Futures" },
  { symbol: "TATAMOTORS", lot: 1400, type: "Futures" },
  { symbol: "TATASTEEL", lot: 5500, type: "Futures" },
  { symbol: "WIPRO", lot: 1500, type: "Futures" },
  { symbol: "HCLTECH", lot: 350, type: "Futures" },
  { symbol: "ADANIENT", lot: 250, type: "Futures" },
  { symbol: "ADANIPORTS", lot: 625, type: "Futures" },
  { symbol: "POWERGRID", lot: 2700, type: "Futures" },
  { symbol: "NTPC", lot: 2250, type: "Futures" },
  { symbol: "ASIANPAINT", lot: 300, type: "Futures" },
  { symbol: "NESTLEIND", lot: 200, type: "Futures" },
  { symbol: "ULTRACEMCO", lot: 100, type: "Futures" },
  { symbol: "TITAN", lot: 175, type: "Futures" },
  { symbol: "BAJAJFINSV", lot: 500, type: "Futures" },
  { symbol: "TECHM", lot: 600, type: "Futures" },
  { symbol: "ONGC", lot: 3850, type: "Futures" },
  { symbol: "COALINDIA", lot: 1400, type: "Futures" },
  { symbol: "JSWSTEEL", lot: 675, type: "Futures" },
  { symbol: "M&M", lot: 350, type: "Futures" },
  { symbol: "CIPLA", lot: 650, type: "Futures" },
  { symbol: "DRREDDY", lot: 125, type: "Futures" },
  { symbol: "EICHERMOT", lot: 150, type: "Futures" },
  { symbol: "GRASIM", lot: 250, type: "Futures" },
  { symbol: "HEROMOTOCO", lot: 150, type: "Futures" },
  { symbol: "HINDALCO", lot: 1075, type: "Futures" },
  { symbol: "INDUSINDBK", lot: 500, type: "Futures" },
  { symbol: "DIVISLAB", lot: 175, type: "Futures" },
  { symbol: "APOLLOHOSP", lot: 125, type: "Futures" },
  { symbol: "BPCL", lot: 1800, type: "Futures" },
  { symbol: "BRITANNIA", lot: 200, type: "Futures" },
  { symbol: "SBILIFE", lot: 375, type: "Futures" },
  { symbol: "HDFCLIFE", lot: 1100, type: "Futures" },
  { symbol: "TATACONSUM", lot: 500, type: "Futures" },
  { symbol: "PIDILITIND", lot: 250, type: "Futures" },
  { symbol: "VEDL", lot: 1550, type: "Futures" },
  { symbol: "HAL", lot: 150, type: "Futures" },
  { symbol: "DLF", lot: 825, type: "Futures" },
  { symbol: "IOC", lot: 4850, type: "Futures" },
  { symbol: "BANKBARODA", lot: 2925, type: "Futures" },
  { symbol: "PNB", lot: 8000, type: "Futures" },
  { symbol: "TRENT", lot: 100, type: "Futures" },
  { symbol: "ZOMATO", lot: 2600, type: "Futures" },
  { symbol: "JIOFIN", lot: 2500, type: "Futures" },
  { symbol: "IRCTC", lot: 575, type: "Futures" },
  { symbol: "SIEMENS", lot: 75, type: "Futures" },
  { symbol: "ABB", lot: 125, type: "Futures" },
  { symbol: "GODREJCP", lot: 500, type: "Futures" },
  { symbol: "AMBUJACEM", lot: 750, type: "Futures" },
  { symbol: "SHREECEM", lot: 25, type: "Futures" },
  { symbol: "INDIGO", lot: 175, type: "Futures" },
  { symbol: "BEL", lot: 2450, type: "Futures" },
  { symbol: "TATAPOWER", lot: 1350, type: "Futures" },
  { symbol: "PEL", lot: 550, type: "Futures" },
  { symbol: "SAIL", lot: 5700, type: "Futures" },
  { symbol: "MRF", lot: 5, type: "Futures" },
  { symbol: "BAJAJ-AUTO", lot: 125, type: "Futures" },
  { symbol: "DABUR", lot: 1050, type: "Futures" },
  { symbol: "MFSL", lot: 500, type: "Futures" },
  { symbol: "LICHSGFIN", lot: 850, type: "Futures" },
  { symbol: "CANBK", lot: 5600, type: "Futures" },
  { symbol: "RECLTD", lot: 1400, type: "Futures" },
  { symbol: "PFC", lot: 1600, type: "Futures" },
  { symbol: "BHEL", lot: 2625, type: "Futures" },
  { symbol: "NMDC", lot: 3350, type: "Futures" },
  { symbol: "IDFCFIRSTB", lot: 7500, type: "Futures" },
  { symbol: "MUTHOOTFIN", lot: 275, type: "Futures" },
  { symbol: "MANAPPURAM", lot: 4000, type: "Futures" },
  { symbol: "PAGEIND", lot: 15, type: "Futures" },
  { symbol: "LALPATHLAB", lot: 175, type: "Futures" },
  { symbol: "COLPAL", lot: 200, type: "Futures" },
  { symbol: "BERGEPAINT", lot: 1100, type: "Futures" },
  { symbol: "IDEA", lot: 50000, type: "Futures" },
  { symbol: "FEDERALBNK", lot: 5000, type: "Futures" },
  { symbol: "NATIONALUM", lot: 4000, type: "Futures" },
  { symbol: "BANDHANBNK", lot: 2700, type: "Futures" },
  { symbol: "EXIDEIND", lot: 1200, type: "Futures" },
  { symbol: "BALKRISIND", lot: 200, type: "Futures" },
  { symbol: "PERSISTENT", lot: 150, type: "Futures" },
  { symbol: "POLYCAB", lot: 100, type: "Futures" },
  { symbol: "COFORGE", lot: 75, type: "Futures" },
  { symbol: "LTTS", lot: 100, type: "Futures" },
  { symbol: "NAUKRI", lot: 75, type: "Futures" },
  { symbol: "MPHASIS", lot: 175, type: "Futures" },
  { symbol: "POWERINDIA", lot: 50, type: "Futures" },
  { symbol: "JINDALSTEL", lot: 500, type: "Futures" },
  { symbol: "OFSS", lot: 75, type: "Futures" },
];

/**
 * Returns the effective instrument master list.
 * Priority: user-uploaded list (localStorage) > user-added instruments > bundled default.
 */
function getInstrumentMaster() {
  // Check for user-uploaded master
  const uploaded = localStorage.getItem('nse_fo_master_uploaded');
  const base = uploaded ? JSON.parse(uploaded) : DEFAULT_NSE_MASTER;
  // Merge with any user-added instruments (avoiding dups by symbol)
  const symbols = new Set(base.map(i => i.symbol.toUpperCase()));
  const extras = (store.state.instruments || []).filter(i => !symbols.has(i.symbol.toUpperCase()));
  return [...base, ...extras];
}

// ==========================================
// 2. STORE MODULE
// ==========================================
const LS_KEY = "risk_engine_pro_v1";
const initialState = { systems: [], instruments: [], trades: [] };

const store = {
  state: { ...initialState },

  async load() {
    this.state = { ...initialState };
    try {
      const res = await fetch('/api/load_state');
      if (res.status === 401) {
        Auth.updateUI(null);
        return;
      }
      if (res.ok) {
        const remoteState = await res.json();
        this.state = remoteState;
        if (!this.state.systems) this.state.systems = [];
        if (!this.state.instruments) this.state.instruments = [];
        if (!this.state.trades) this.state.trades = [];

        Auth.updateUI(remoteState.username || 'User');

        const adminTab = document.getElementById('nav-tab-admin');
        if (adminTab) {
          if (remoteState.is_admin) {
            adminTab.classList.remove('hidden');
          } else {
            adminTab.classList.add('hidden');
          }
        }

        return;
      }
    } catch (e) {
      console.error("Failed to load state", e);
    }
  },

  async save() {
    try {
      const res = await fetch('/api/save_state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: this.state })
      });
      if (res.status === 401) {
        Auth.updateUI(null);
        return;
      }

      const ind = document.getElementById('save-indicator');
      if (ind) {
        ind.textContent = 'Saved ✓';
        ind.style.opacity = '1';
        clearTimeout(ind._timer);
        ind._timer = setTimeout(() => { ind.style.opacity = '0'; }, 1500);
      }
    } catch (e) {
      console.error("Failed to save state", e);
    }
  },

  addSystem(sys) { this.state.systems.push(sys); this.save(); },
  removeSystem(idx) { this.state.systems.splice(idx, 1); this.save(); },
  addInstrument(inst) { this.state.instruments.push(inst); this.save(); },
  removeInstrument(idx) { this.state.instruments.splice(idx, 1); this.save(); },
  addTrade(trade) { this.state.trades.push(trade); this.save(); },
  updateTrade(trade) {
    const idx = this.state.trades.findIndex(t => t.id === trade.id);
    if (idx > -1) this.state.trades[idx] = trade;
    this.save();
  },
  removeTrade(id) {
    // Delete trade AND its children
    this.state.trades = this.state.trades.filter(t => t.id !== id && t.parent_id !== id);
    this.save();
  },
  replaceState(newState) {
    this.state = newState;
    this.save();
  }
};

// ==========================================
// 3. CHARTS MODULE
// ==========================================
const Charts = (function () {
  let equityChart = null;
  let allocChart = null;
  let equityChart2 = null;

  return {
    renderEquityChart(canvasId, points) {
      const el = document.getElementById(canvasId);
      if (!el) return;
      const ctx = el.getContext('2d');
      if (equityChart) equityChart.destroy();
      equityChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: points.map(p => p.x),
          datasets: [{
            label: 'Portfolio (Lakhs)',
            data: points.map(p => p.y),
            borderColor: '#1E3A8A',
            backgroundColor: 'rgba(30,58,138,0.08)',
            fill: true,
            tension: 0.2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true } }
        }
      });
    },

    renderAllocChart(canvasId, systems) {
      const el = document.getElementById(canvasId);
      if (!el) return;
      const ctx = el.getContext('2d');
      const labels = systems.map(s => s.name || 'SYS');
      const data = systems.map(s => Number(s.capital || 0));
      if (allocChart) allocChart.destroy();
      allocChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data,
            backgroundColor: ['#1E3A8A', '#06B6D4', '#F59E0B', '#10B981', '#8B5CF6']
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } }
        }
      });
    },

    renderDetailedEquityChart(canvasId, dataPoints, labels) {
      const el = document.getElementById(canvasId);
      if (!el) return;
      const ctx = el.getContext('2d');
      if (equityChart2) equityChart2.destroy();
      equityChart2 = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Portfolio (Lakhs)',
            data: dataPoints,
            borderColor: '#06B6D4',
            backgroundColor: 'rgba(6,182,212,0.08)',
            fill: true,
            tension: 0.25
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }
  };
})();

// ==========================================
// 4. UI MODULE
// ==========================================
const $ = (s) => document.querySelector(s);

function formatPF(pf) {
  if (pf === null) return '—';
  if (!isFinite(pf)) return '∞';
  return pf.toFixed(2);
}

const UI = {
  renderDashboard() {
    const { systems, trades } = store.state;
    // Aggregates
    const totalCapital = systems.reduce((a, b) => a + Number(b.capital || 0), 0);
    const totalRisk = trades.filter(t => t.status === 'Open').reduce((a, b) => a + Number(b.total_risk || b.actual_risk || 0), 0);
    const realized = trades.filter(t => t.status === 'Closed').reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const unreal = trades.filter(t => t.status === 'Open').reduce((a, b) => {
      const dir = (b.direction === 'Short') ? -1 : 1;
      let pnl = 0;
      if (b.mark_price != null) {
        pnl += (dir * (Number(b.mark_price || 0) - Number(b.entry || 0)) * Number(b.final_qty || 0));
      }
      if (b.hedge && b.hedge.mark_price != null) {
        pnl += (Number(b.hedge.mark_price) - Number(b.hedge.entry || 0)) * Number(b.hedge.qty || 0);
      }
      return a + pnl;
    }, 0);

    if ($('#sum-capital')) $('#sum-capital').textContent = Calc.money(totalCapital);
    if ($('#sum-risk')) $('#sum-risk').textContent = Calc.money(totalRisk);
    if ($('#sum-real')) $('#sum-real').textContent = Calc.money(realized);
    if ($('#sum-unreal')) $('#sum-unreal').textContent = Calc.money(unreal);

    this.renderRiskMonitor(trades);

    Charts.renderAllocChart('allocChart', systems);
    const points = []; let cum = 0;
    const tradesSorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));
    tradesSorted.forEach(t => {
      const dir = (t.direction === 'Short') ? -1 : 1;
      let pnl = 0;
      if (t.status === 'Closed') {
        pnl = Number(t.realized_pnl || 0);
      } else if (t.mark_price != null) {
        pnl = dir * (Number(t.mark_price) - Number(t.entry || 0)) * Number(t.final_qty || 0);
      }
      cum += pnl;
      points.push({ x: t.date, y: Number((cum / 100000).toFixed(2)) });
    });
    if (points.length === 0) points.push({ x: Calc.nowDate(), y: 0 });
    Charts.renderEquityChart('equityChart', points);

    const win = Calc.computeWinRate(trades);
    const pf = Calc.computeProfitFactor(trades);
    const avg = Calc.computeAvgTrade(trades);
    if ($('#stat-win')) $('#stat-win').textContent = win === null ? '—' : win.toFixed(1) + '%';
    if ($('#stat-pf')) $('#stat-pf').textContent = formatPF(pf);
    if ($('#stat-avg')) $('#stat-avg').textContent = avg === null ? '—' : Calc.money(avg);

    const tbody = $('#dashboard-table-body');
    if (tbody) {
      tbody.innerHTML = '';
      systems.forEach(s => {
        const m = Calc.computeSystemMetrics(s, trades);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="p-2">${s.name}</td><td>${m.openCount}</td><td>${Calc.money(m.riskInPlay)}</td><td>${Calc.money(m.unrealized)}</td><td>${Calc.money(m.realized)}</td><td>${Calc.money(m.capacityLeft)}</td>`;
        tbody.appendChild(tr);
      });
    }
  },

  renderRiskMonitor(trades) {
    const exposure = Calc.computeExposure(trades);
    const dailyPnL = Calc.getDailyRealizedPnL(trades);
    if ($('#risk-daily-pnl')) {
      $('#risk-daily-pnl').textContent = Calc.money(dailyPnL);
      const portfolioLimit = store.state.systems.reduce((sum, s) => sum + Number(s.daily_loss_limit || 20000), 0);
      const breached = dailyPnL < -portfolioLimit;

      if ($('#risk-daily-pnl')) {
        $('#risk-daily-pnl').textContent = Calc.money(dailyPnL);
        $('#risk-daily-pnl').className = 'font-bold text-lg ' + (breached ? 'text-red-600' : '');
        if ($('#risk-daily-warning')) {
          $('#risk-daily-limit-val').textContent = Calc.money(portfolioLimit);
          breached ? $('#risk-daily-warning').classList.remove('hidden') : $('#risk-daily-warning').classList.add('hidden');
        }
      }

      const saveBtn = document.getElementById('save-trade');
      if (saveBtn) {
        saveBtn.disabled = breached;
        saveBtn.title = breached ? 'Daily loss limit reached — trading halted' : '';
        saveBtn.className = breached
          ? 'px-4 py-2 bg-gray-400 text-white rounded-md cursor-not-allowed opacity-60 mt-4'
          : 'px-4 py-2 bg-green-600 text-white rounded-md mt-4';
      }

      let banner = document.getElementById('cb-banner');
      if (breached) {
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'cb-banner';
          banner.className = 'mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm font-semibold flex items-center gap-2';
          banner.innerHTML = '⛔ Circuit Breaker Active — Daily loss limit reached. New trades are blocked.';
          const form = document.getElementById('view-newtrade');
          if (form) form.prepend(banner);
        }
      } else if (banner) {
        banner.remove();
      }
    }
    if ($('#risk-total-exposure')) $('#risk-total-exposure').textContent = Calc.money(exposure.totalRisk);
    let maxSector = { name: 'None', val: 0 };
    for (const [sys, val] of Object.entries(exposure.bySystem)) {
      if (val > maxSector.val) maxSector = { name: sys, val };
    }
    if ($('#risk-max-sector')) $('#risk-max-sector').textContent = `${maxSector.name} (${Calc.money(maxSector.val)})`;
  },

  renderSystems() {
    const tbody = $('#systems-tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    store.state.systems.forEach((s, idx) => {
      const tr = document.createElement('tr');
      const max = s.capital && s.R ? Math.floor(s.capital / s.R) : 0;
      tr.innerHTML = `<td class="p-2"><input data-idx="${idx}" data-field="name" class="w-full border p-1 rounded text-sm" value="${s.name}"></td>
        <td><input data-idx="${idx}" data-field="capital" class="w-full border p-1 rounded text-sm" value="${s.capital}"></td>
        <td><input data-idx="${idx}" data-field="R" class="w-full border p-1 rounded text-sm" value="${s.R}"></td>
        <td><input data-idx="${idx}" data-field="daily_loss_limit" class="w-full border p-1 rounded text-sm" value="${s.daily_loss_limit || 20000}" title="Daily max loss (₹)"></td>
        <td class="p-2 max-trades-cell">${max}</td>
        <td class="p-2"><button data-idx="${idx}" class="del-system text-red-600">Delete</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const i = Number(e.target.dataset.idx);
        const f = e.target.dataset.field;
        const v = e.target.value;
        if (f === 'name') store.state.systems[i][f] = v;
        else store.state.systems[i][f] = Number(v || 0);
        store.save();
        const tr = e.target.closest('tr');
        const maxCell = tr.querySelector('.max-trades-cell');
        const sys = store.state.systems[i];
        const max = sys.capital && sys.R ? Math.floor(sys.capital / sys.R) : 0;
        if (maxCell) maxCell.textContent = max;
      });
    });
    tbody.querySelectorAll('.del-system').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Delete system?')) return;
        store.removeSystem(btn.dataset.idx);
        UI.renderSystems();
      });
    });

    const sysList = $('#sys-list');
    if (sysList) {
      sysList.innerHTML = '';
      store.state.systems.forEach(s => {
        const o = document.createElement('option');
        o.value = s.name;
        sysList.appendChild(o);
      });
    }
  },

  renderInstruments() {
    const tbody = $('#instruments-tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    store.state.instruments.forEach((it, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="p-2"><input data-idx="${idx}" data-field="symbol" class="w-full border p-1 rounded text-sm" value="${it.symbol}"></td>
        <td><input data-idx="${idx}" data-field="lot" class="w-full border p-1 rounded text-sm" value="${it.lot}"></td>
        <td><select data-idx="${idx}" data-field="type" class="w-full border p-1 rounded text-sm"><option ${it.type === 'Futures' ? 'selected' : ''}>Futures</option><option ${it.type === 'Options' ? 'selected' : ''}>Options</option><option ${it.type === 'Stock' ? 'selected' : ''}>Stock</option></select></td>
        <td class="p-2"><button data-idx="${idx}" class="del-instrument text-red-600">Delete</button></td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('input,select').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const i = Number(e.target.dataset.idx);
        const f = e.target.dataset.field;
        const v = e.target.value;
        if (f === 'symbol' || f === 'type') store.state.instruments[i][f] = v;
        else store.state.instruments[i][f] = Number(v || 0);
        store.save();
      });
    });
    tbody.querySelectorAll('.del-instrument').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Delete instrument?')) return;
        store.removeInstrument(btn.dataset.idx);
        UI.renderInstruments();
      });
    });
  },

  // Sort state for trades table
  _tradeSortKey: 'date',
  _tradeSortDir: 'desc',

  showTradeInfoModal(t) {
    const modal = document.querySelector('#modal-trade-info');
    if (!modal) return;
    const body = document.querySelector('#modal-trade-info-body');
    const dirTxt = t.direction === 'Short' ? '<span class="text-red-500 font-bold">SHORT</span>' : '<span class="text-green-600 font-bold">LONG</span>';
    let statusPill = '<span class="pill pill-open">OPEN</span>';
    if (t.status === 'Closed') {
      statusPill = Number(t.realized_pnl) >= 0 ? '<span class="pill pill-win">WIN</span>' : '<span class="pill pill-loss">LOSS</span>';
    }

    let pnlDisplay = '';
    if (t.status === 'Closed') {
      pnlDisplay = `<div><span class="muted text-xs block">Realized PnL</span><b class="${Number(t.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600'}">${Calc.money(t.realized_pnl)}</b></div>`;
    }

    body.innerHTML = `
      <div class="grid grid-cols-2 gap-y-3 gap-x-6 text-sm">
        <div><span class="muted text-xs block">Date</span><b>${t.date}</b></div>
        <div><span class="muted text-xs block">Instrument</span><b>${t.instrument}</b></div>
        <div><span class="muted text-xs block">System</span><b>${t.system}</b></div>
        <div><span class="muted text-xs block">Direction</span><b>${dirTxt}</b></div>
        <div><span class="muted text-xs block">Entry</span><b>${t.entry}</b></div>
        <div><span class="muted text-xs block">Exit</span><b>${t.exit || '-'}</b></div>
        <div><span class="muted text-xs block">Final Qty</span><b>${t.final_qty}</b></div>
        <div><span class="muted text-xs block">Risk</span><b>${Calc.money(t.total_risk || t.actual_risk)}</b></div>
        <div><span class="muted text-xs block">Tags</span><b>${(t.tags || []).join(', ') || '-'}</b></div>
        <div><span class="muted text-xs block">Status</span><b>${statusPill}</b></div>
        ${pnlDisplay}
        ${t.hedge ? `<div class="col-span-2 pt-2 border-t mt-1"><span class="muted text-xs block">Hedge</span><b>${t.hedge.strike} ${t.hedge.type} at Entry: ${t.hedge.entry} (Qty: ${t.hedge.qty})</b></div>` : ''}
        ${t.notes ? `<div class="col-span-2 pt-2 border-t mt-1"><span class="muted text-xs block">Notes</span><p class="whitespace-pre-wrap">${t.notes}</p></div>` : ''}
      </div>
    `;
    modal.classList.remove('hidden');
    document.querySelector('#btn-modal-trade-info-close').onclick = () => modal.classList.add('hidden');
  },

  renderTrades(editCallback, highlightId = null) {
    const tbody = $('#trades-tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    const filtSys = $('#filter-system') ? $('#filter-system').value.trim() : '';
    const filtInst = $('#filter-instrument') ? $('#filter-instrument').value.trim().toUpperCase() : '';
    const filtPeriod = $('#filter-period') ? $('#filter-period').value : 'all';
    const filtStatus = $('#filter-status') ? $('#filter-status').value : '';
    const filtDir = $('#filter-direction') ? $('#filter-direction').value : '';
    const filtDateFrom = $('#filter-date-from') ? $('#filter-date-from').value : '';
    const filtDateTo = $('#filter-date-to') ? $('#filter-date-to').value : '';

    // Populate Systems dropdown if empty
    // Populate Systems dropdown
    const sysSelect = $('#filter-system');
    if (sysSelect && sysSelect.tagName === 'SELECT') {
      const currentVal = sysSelect.value;
      sysSelect.innerHTML = '<option value="">All Systems</option>';
      store.state.systems.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name; opt.textContent = s.name;
        sysSelect.appendChild(opt);
      });
      sysSelect.value = currentVal;
    }

    // Show/hide custom date inputs
    if ($('#filter-date-from')) $('#filter-date-from').classList.toggle('hidden', filtPeriod !== 'custom');
    if ($('#filter-date-to')) $('#filter-date-to').classList.toggle('hidden', filtPeriod !== 'custom');

    // Setup sortable headers
    document.querySelectorAll('#view-trades th.sortable').forEach(th => {
      th.onclick = () => {
        const key = th.dataset.key;
        if (UI._tradeSortKey === key) {
          UI._tradeSortDir = UI._tradeSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          UI._tradeSortKey = key;
          UI._tradeSortDir = 'asc';
        }
        document.querySelectorAll('#view-trades th.sortable').forEach(h => h.classList.remove('asc', 'desc'));
        th.classList.add(UI._tradeSortDir);
        UI.renderTrades(editCallback);
      };
    });

    // Get parent trades only
    let parents = store.state.trades.filter(t => !t.parent_id);
    if (filtSys) parents = parents.filter(t => t.system === filtSys);
    if (filtInst) parents = parents.filter(t => t.instrument.toUpperCase().includes(filtInst) || (t.tags || []).some(tt => tt.toUpperCase().includes(filtInst)));
    if (filtStatus) parents = parents.filter(t => t.status === filtStatus);
    if (filtDir) parents = parents.filter(t => t.direction === filtDir);

    // Time filter — strictly on ENTRY DATE
    if (filtPeriod !== 'all') {
      const now = new Date();
      parents = parents.filter(t => {
        const d = new Date(t.date);
        if (filtPeriod === 'today') return d.toDateString() === now.toDateString();
        if (filtPeriod === 'week') { const w = new Date(now); w.setDate(w.getDate() - 7); return d >= w; }
        if (filtPeriod === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        if (filtPeriod === 'custom') {
          if (filtDateFrom && d < new Date(filtDateFrom)) return false;
          if (filtDateTo && d > new Date(filtDateTo + 'T23:59:59')) return false;
          return true;
        }
        return true;
      });
    }

    // Sort
    const key = UI._tradeSortKey;
    const dir = UI._tradeSortDir === 'asc' ? 1 : -1;
    parents.sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'date') { va = new Date(va); vb = new Date(vb); }
      else if (['entry', 'exit', 'final_qty', 'actual_risk', 'total_risk'].includes(key)) {
        va = Number(a.total_risk || a.actual_risk || 0);
        vb = Number(b.total_risk || b.actual_risk || 0);
      }
      else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
      return va > vb ? dir : va < vb ? -dir : 0;
    });

    parents.forEach(t => {
      const tr = document.createElement('tr');
      tr.className = 'border-b hover:bg-gray-50 transition-colors';
      if (highlightId && t.id === highlightId) {
        tr.classList.add('bg-blue-100');
        setTimeout(() => tr.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
      }

      // Status pill
      let statusPill = '<span class="pill pill-open">OPEN</span>';
      if (t.status === 'Closed') {
        statusPill = Number(t.realized_pnl) >= 0 ? '<span class="pill pill-win">WIN</span>' : '<span class="pill pill-loss">LOSS</span>';
      }

      const dirBadge = t.direction === 'Short' ? '<span class="text-xs font-bold text-red-500 bg-red-50 px-1 rounded">SHORT</span>' : '<span class="text-xs font-bold text-green-600 bg-green-50 px-1 rounded">LONG</span>';
      const hedgeChip = t.hedge && t.hedge.strike ? `<span class="ml-1 text-xs bg-blue-100 text-blue-700 px-1 rounded">\ud83d\udee1\ufe0f ${t.hedge.strike} ${t.hedge.type}</span>` : '';

      // Check for children (partial exits)
      const children = store.state.trades.filter(c => c.parent_id === t.id);
      const expandBtn = children.length > 0 ? `<span class="expand-btn text-gray-400 text-xs mr-1" data-parent="${t.id}">\u25b6</span>` : '<span class="w-3 inline-block mr-1"></span>';

      tr.innerHTML = `<td class="p-2">${expandBtn}${t.date}</td><td class="text-xs text-gray-400">#${t.id.replace('trade_', '')}</td><td>${t.system}</td><td><a href="#" class="view-trade-info font-medium text-blue-600 hover:text-blue-800" data-id="${t.id}">${t.instrument}</a> ${hedgeChip}</td><td>${dirBadge}</td>
        <td>${t.entry}</td><td>${t.exit}</td><td>${t.final_qty}</td><td>${Calc.money(t.total_risk || t.actual_risk)}</td>
        <td>${t.flag}</td><td>${(t.tags || []).join(', ')}</td><td>${statusPill}</td>
        <td class="row-actions">${t.status === 'Closed' && children.length === 0 ? `<button class="btn-edit-close mr-1 text-xs text-orange-500 hover:text-orange-700" data-id="${t.id}" title="Edit Exit Price">\u270f\ufe0f</button>` : ''}<button class="edit-trade text-blue-600 hover:text-blue-800 mr-1" title="Edit">\u270f\ufe0f</button><button class="del-trade text-red-500 hover:text-red-700" title="Delete">\ud83d\uddd1\ufe0f</button></td>`;
      tbody.appendChild(tr);

      tr.querySelector('.view-trade-info').addEventListener('click', (e) => {
        e.preventDefault();
        UI.showTradeInfoModal(t);
      });

      tr.querySelector('.del-trade').addEventListener('click', async () => {
        if (!await showConfirm('Delete this trade and all its partial exits?')) return;
        store.removeTrade(t.id);
        UI.renderTrades(editCallback);
      });
      tr.querySelector('.edit-trade').addEventListener('click', () => {
        if (editCallback) editCallback(t);
      });

      // Expandable child rows
      const expBtn = tr.querySelector('.expand-btn');
      if (expBtn && children.length > 0) {
        const childRows = [];
        children.forEach(child => {
          const cr = document.createElement('tr');
          cr.className = 'child-row hidden border-b text-xs text-gray-500';
          const childPill = Number(child.realized_pnl) >= 0 ? '<span class="pill pill-win">WIN</span>' : '<span class="pill pill-loss">LOSS</span>';
          cr.innerHTML = `<td class="p-2 pl-7">${child.close_date || child.date}</td><td class="text-gray-300">#${child.id.replace('trade_', '')}</td><td></td><td>Partial Exit</td><td></td>
            <td>${child.entry}</td><td>${child.close_price || '\u2014'} <button class="btn-edit-close ml-1 text-xs text-orange-500 hover:text-orange-700" data-id="${child.id}" title="Edit Exit Price">\u270f\ufe0f</button></td><td>${child.final_qty}</td><td></td>
            <td></td><td></td><td>${childPill}</td><td class="font-semibold ${Number(child.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600'}">${Calc.money(child.realized_pnl)}</td>`;
          childRows.push(cr);
          tbody.appendChild(cr);
        });
        expBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          expBtn.classList.toggle('open');
          childRows.forEach(cr => cr.classList.toggle('hidden'));
        });
      }
    });

    tbody.querySelectorAll('.btn-edit-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = store.state.trades.find(x => x.id === btn.dataset.id);
        if (t) UI.handleEditClosePrice(t);
      });
    });
  },

  renderKanban() {
    let { trades } = store.state;

    // Quick Filter Logic
    const period = $('#kanban-filter-period') ? $('#kanban-filter-period').value : 'all';
    if (period !== 'all') {
      const now = new Date();
      trades = trades.filter(t => {
        // Use close_date for closed trades if available, else date
        const dateStr = t.status === 'Closed' ? (t.close_date || t.date) : t.date;
        if (!dateStr) return false;
        const d = new Date(dateStr);
        if (period === 'today') return d.toDateString() === now.toDateString();
        if (period === 'week') {
          const w = new Date(now); w.setDate(w.getDate() - 7); return d >= w;
        }
        if (period === 'month') {
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }
        return true;
      });
    }

    const cols = { watchlist: $('#kanban-watchlist'), open: $('#kanban-open'), wins: $('#kanban-wins'), losses: $('#kanban-losses') };
    if (!cols.watchlist) return;
    Object.values(cols).forEach(c => c.innerHTML = '');

    // Setup drag & drop on columns
    document.querySelectorAll('.kanban-col').forEach(colEl => {
      colEl.ondragover = (e) => { e.preventDefault(); colEl.classList.add('drag-over'); };
      colEl.ondragleave = () => colEl.classList.remove('drag-over');
      colEl.ondrop = (e) => {
        e.preventDefault();
        colEl.classList.remove('drag-over');
        const tradeId = e.dataTransfer.getData('text/plain');
        const targetStatus = colEl.dataset.status;
        const trade = store.state.trades.find(x => x.id === tradeId);
        if (!trade) return;
        if (targetStatus === 'Open' && trade.status !== 'Open') {
          trade.status = 'Open';
          trade.realized_pnl = null;
          trade.close_price = null;
          trade.close_date = null;
          store.save();
        }
        UI.renderKanban();
      };
    });

    trades.forEach(t => {
      if (t.parent_id) return;
      let col = null;
      if (t.status === 'Open') col = cols.open;
      else if (t.status === 'Closed') {
        if (Number(t.realized_pnl) >= 0) col = cols.wins;
        else col = cols.losses;
      } else { col = cols.watchlist; }
      if (!col) return;

      const card = document.createElement('div');
      const borderColor = (Number(t.realized_pnl) > 0) ? 'border-l-green-500' : (Number(t.realized_pnl) < 0 ? 'border-l-red-500' : 'border-l-blue-500');
      card.className = "kanban-card p-3 bg-white rounded shadow text-sm border-l-4 mb-2 cursor-pointer " + borderColor;
      card.draggable = true;
      card.dataset.tradeId = t.id;

      const dirLabel = t.direction === 'Short' ? '<span class="text-xs text-red-500 font-bold">\u25bc SHORT</span>' : '<span class="text-xs text-green-600 font-bold">\u25b2 LONG</span>';
      const hedgeLabel = t.hedge && t.hedge.strike ? '<div class="text-xs text-blue-600">\ud83d\udee1\ufe0f Hedge: ' + t.hedge.strike + ' ' + t.hedge.type + '</div>' : '';
      const centerContent = t.status === 'Closed' ? '<div class="mt-1 font-bold ' + (Number(t.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600') + '">' + Calc.money(t.realized_pnl) + '</div>' : '<div class="mt-1 text-blue-600">Risk: ' + Calc.money(t.total_risk || t.actual_risk) + '</div>';
      card.innerHTML = '<div class="font-bold flex justify-between"><span>' + t.instrument + '</span> <span class="text-xs text-gray-500 bg-gray-100 px-1 rounded">' + t.system + '</span></div><div class="mt-1 text-xs text-gray-500">' + dirLabel + ' \u2022 Qty: ' + t.final_qty + ' \u2022 ' + t.date + '</div>' + hedgeLabel + centerContent;

      // Drag events
      card.ondragstart = (e) => { e.dataTransfer.setData('text/plain', t.id); card.classList.add('dragging'); };
      card.ondragend = () => card.classList.remove('dragging');

      // Smart routing on click
      card.onclick = () => {
        if (t.status === 'Closed' || t.status === 'Open') {
          $('.tab-btn[data-tab="pnl"]').click();
        } else {
          $('.tab-btn[data-tab="trades"]').click();
          setTimeout(() => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }, t.parent_id || t.id), 50);
        }
      };

      col.appendChild(card);
    });

    ['watchlist', 'open', 'wins', 'losses'].forEach(k => {
      const badge = $('#badge-kanban-' + k);
      if (badge && cols[k]) badge.textContent = cols[k].children.length;
    });
  },

  renderPNL() {
    const openT = $('#pnl-open'); const closedT = $('#pnl-closed');
    if (!openT || !closedT) return;
    openT.innerHTML = ''; closedT.innerHTML = '';

    // Get filters
    const txtFilt = $('#pnl-filter-inst') ? $('#pnl-filter-inst').value.trim().toUpperCase() : '';
    const sysFilt = $('#pnl-filter-sys') ? $('#pnl-filter-sys').value : '';
    const periodFilt = $('#pnl-filter-period') ? $('#pnl-filter-period').value : 'all';

    const isDateMatch = (dStr) => {
      if (periodFilt === 'all') return true;
      if (!dStr) return false;
      const d = new Date(dStr);
      const now = new Date();
      if (periodFilt === 'today') return d.toDateString() === now.toDateString();
      if (periodFilt === 'week') {
        const firstDay = new Date(now.setDate(now.getDate() - now.getDay()));
        return d >= firstDay;
      }
      if (periodFilt === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      if (periodFilt === 'ytd') return d.getFullYear() === now.getFullYear();
      return true;
    };

    const sysSel = $('#pnl-filter-sys');
    if (sysSel && sysSel.tagName === 'SELECT') {
      const currentVal = sysSel.value;
      sysSel.innerHTML = '<option value="">All Systems</option>';
      store.state.systems.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name; opt.textContent = s.name;
        sysSel.appendChild(opt);
      });
      sysSel.value = currentVal;
    }

    const filteredTrades = store.state.trades.filter(t => {
      if (txtFilt && !(t.instrument.toUpperCase().includes(txtFilt) || (t.tags || []).some(tt => tt.toUpperCase().includes(txtFilt)))) return false;
      if (sysFilt && t.system !== sysFilt) return false;
      if (!isDateMatch(t.date)) return false;
      return true;
    });

    const recalcOpenTotal = () => {
      let sum = 0, hasOpen = false;
      openT.querySelectorAll('.unreal').forEach(cell => {
        const text = cell.textContent.replace(/[^0-9.-]+/g, "");
        if (text && text !== '-' && cell.textContent.trim() !== '—') {
          sum += Number(text);
          hasOpen = true;
        }
      });
      const totCell = $('#pnl-total-unrealized');
      if (totCell) {
        if (!hasOpen) { totCell.textContent = '—'; totCell.className = 'font-bold p-2 text-gray-500'; }
        else {
          totCell.textContent = Calc.money(sum);
          totCell.className = 'font-bold p-2 ' + (sum >= 0 ? 'text-green-600' : 'text-red-600');
        }
      }
    };

    filteredTrades.forEach(t => {
      if (t.status === 'Open') {
        const tr = document.createElement('tr');
        const linkBtn = '<button class="jump-btn ml-2 text-xs text-blue-500 hover:text-blue-700" title="View in Trades">\u2197</button>';
        const dirBadge = t.direction === 'Short' ? '<span class="text-xs font-bold text-red-500">SHORT</span>' : '<span class="text-xs font-bold text-green-600">LONG</span>';

        tr.innerHTML = '<td class="p-2">' + t.date + '</td>' +
          '<td>' + t.instrument + (t.strike ? ' ' + t.strike + ' ' + t.optionType : '') + ' ' + linkBtn +
          (t.hedge ? ' <span class="ml-1 text-xs bg-blue-100 text-blue-700 px-1 rounded text-nowrap">🛡️ ' + t.hedge.strike + ' ' + t.hedge.type + '</span>' : '') + '</td>' +
          '<td>' + dirBadge + '</td>' +
          '<td>' + t.entry + '</td><td class="qty-cell">' + t.final_qty + '</td>' +
          '<td><div class="flex items-center gap-2"><input data-id="' + t.id + '" class="mark-input border p-1 rounded text-sm w-20" value="' + (t.mark_price || '') + '" placeholder="Main">' +
          (t.hedge ? '<input data-id="' + t.id + '" class="mark-input-hedge border p-1 rounded text-sm w-20 border-blue-300 bg-blue-50" value="' + (t.hedge.mark_price || '') + '" title="Hedge: ' + t.hedge.strike + ' ' + t.hedge.type + '" placeholder="Hedge">' : '') + '</div></td>' +
          '<td class="unreal text-gray-400 font-semibold">\u2014</td>' +
          '<td class="risk-bar-cell w-32">\u2014</td>' +
          '<td><button data-id="' + t.id + '" class="close-btn px-2 py-1 rounded text-sm bg-indigo-600 text-white hover:bg-indigo-700">Close</button></td>';

        openT.appendChild(tr);

        tr.querySelector('.jump-btn').addEventListener('click', () => {
          $('.tab-btn[data-tab="trades"]').click();
          setTimeout(() => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }, t.parent_id || t.id), 50);
        });

        const updateLiveMath = () => {
          const mainInput = tr.querySelector('.mark-input');
          const hedgeInput = tr.querySelector('.mark-input-hedge');

          const rawMain = mainInput.value;
          const rawHedge = hedgeInput ? hedgeInput.value : '';

          const unrealCell = tr.querySelector('.unreal');
          const barCell = tr.querySelector('.risk-bar-cell');

          if (rawMain.trim() === '' && (!t.hedge || rawHedge.trim() === '')) {
            unrealCell.textContent = '\u2014'; unrealCell.className = 'unreal text-gray-400 font-semibold';
            barCell.innerHTML = '\u2014';
            return;
          }
          const parsedMain = Number(rawMain || 0);
          const parsedHedge = Number(rawHedge || 0);

          const dir = (t.direction === 'Short') ? -1 : 1;
          const mainPnl = rawMain.trim() !== '' ? dir * (parsedMain - Number(t.entry || 0)) * Number(t.final_qty || 0) : 0;
          const hedgePnl = (t.hedge && rawHedge.trim() !== '') ? (parsedHedge - Number(t.hedge.entry || 0)) * Number(t.hedge.qty || 0) : 0;
          const pnl = mainPnl + hedgePnl;

          unrealCell.innerHTML = `${Calc.money(pnl)}`;
          unrealCell.className = 'unreal font-semibold ' + (pnl >= 0 ? 'text-green-600' : 'text-red-600');

          const riskAmt = Number(t.actual_risk) || 0.01;
          const pct = Math.min(100, (Math.abs(pnl) / riskAmt) * 100);
          const color = pnl >= 0 ? 'green' : 'red';
          let mText = pnl >= 0 ? '+' + (pct / 100).toFixed(1) + 'R' : '-' + (pct / 100).toFixed(1) + 'R';
          if (pnl === 0) mText = '0R';
          barCell.innerHTML = '<div class="flex items-center gap-2"><div class="progress-bg w-16"><div class="progress-bar ' + color + '" style="width:' + pct + '%"></div></div><span class="text-xs text-gray-500">' + mText + '</span></div>';
          recalcOpenTotal();
        };

        if (t.mark_price || (t.hedge && t.hedge.mark_price)) updateLiveMath();

        tr.querySelector('.mark-input').addEventListener('input', (e) => {
          const raw = e.target.value;
          t.mark_price = raw.trim() === '' ? null : Number(raw);
          updateLiveMath();
          store.save();
        });

        const hInput = tr.querySelector('.mark-input-hedge');
        if (hInput) {
          hInput.addEventListener('input', (e) => {
            const raw = e.target.value;
            t.hedge.mark_price = raw.trim() === '' ? null : Number(raw);
            updateLiveMath();
            store.save();
          });
        }
        tr.querySelector('.close-btn').addEventListener('click', () => UI.handleCloseTrade(t));
      }
    });

    recalcOpenTotal();
    this.renderClosedTradesGrouped(closedT, filteredTrades.filter(x => x.status === 'Closed'));
  },

  handleCloseTrade(trade) {
    const modal = $('#modal-close');
    if (!modal) return;

    // Reset modal fields: Default to Mark Price if available, else Entry
    $('#modal-close-price').value = trade.mark_price !== null ? trade.mark_price : trade.entry;
    $('#modal-close-date').value = Calc.nowDate();

    // Set Qty slider
    const slider = $('#modal-close-qty-slider');
    const disp = $('#modal-close-qty-display');
    const maxdisp = $('#modal-close-qty-max');
    const maxQty = trade.final_qty;

    const instObj = store.state.instruments.find(x => x.symbol === trade.instrument);
    const lotSize = instObj ? Number(instObj.lot || 1) : 1;

    slider.min = lotSize;
    slider.step = lotSize;
    slider.max = maxQty;
    slider.value = maxQty;
    disp.textContent = maxQty;
    maxdisp.textContent = maxQty;

    // Show info
    const dirTxt = trade.direction === 'Short' ? '\u25bc SHORT' : '\u25b2 LONG';
    $('#modal-close-info').innerHTML = `<b>${trade.instrument}</b> (${dirTxt})<br>Entry: ${trade.entry} &middot; Max Qty: ${maxQty}`;

    // Update display on slide
    slider.oninput = () => disp.textContent = slider.value;

    const hedgeGrp = $('#modal-hedge-close-group');
    if (hedgeGrp) {
      if (trade.hedge) {
        hedgeGrp.classList.remove('hidden');
        $('#modal-close-hedge-inst').textContent = trade.hedge.strike + ' ' + trade.hedge.type;
        $('#modal-close-price-hedge').value = trade.hedge.mark_price !== null ? trade.hedge.mark_price : (trade.hedge.entry || '');
      } else {
        hedgeGrp.classList.add('hidden');
        $('#modal-close-price-hedge').value = '';
      }
    }

    modal.classList.remove('hidden');

    // Close X button
    $('#btn-modal-close-x').onclick = () => modal.classList.add('hidden');

    // Submit handler
    const btnSubmit = $('#btn-modal-submit-close');
    btnSubmit.onclick = async () => {
      const closePrice = Number($('#modal-close-price').value);
      if (isNaN(closePrice) || closePrice <= 0) return showToast('Invalid close price', 'error');
      let qtyClose = Number(slider.value);

      const instObj = store.state.instruments.find(x => x.symbol === trade.instrument);
      const lotSize = instObj ? Number(instObj.lot || 1) : 1;
      const adjusted = Calc.enforceLotSize(qtyClose, lotSize, 'down');

      if (qtyClose !== adjusted && qtyClose < maxQty) {
        if (!await showConfirm(`Adjust qty ${qtyClose} to valid lot multiple ${adjusted}?`)) return;
        qtyClose = adjusted;
      }
      if (qtyClose <= 0 || qtyClose > maxQty) return showToast('Invalid qty', 'error');

      const dir = (trade.direction === 'Short') ? -1 : 1;
      const mainRealized = dir * (closePrice - trade.entry) * qtyClose;

      let hedgeRealized = 0;
      let closePriceHedge = null;
      let hedgeQtyClose = 0;

      if (trade.hedge) {
        closePriceHedge = Number($('#modal-close-price-hedge').value);
        if (isNaN(closePriceHedge) || closePriceHedge <= 0) return showToast('Invalid hedge close price', 'error');
        hedgeQtyClose = Math.round(trade.hedge.qty * (qtyClose / maxQty));
        hedgeRealized = (closePriceHedge - trade.hedge.entry) * hedgeQtyClose;
      }

      const realized = mainRealized + hedgeRealized;
      const cDate = $('#modal-close-date').value || Calc.nowDate();

      if (qtyClose < maxQty) {
        // PARTIAL CLOSE
        trade.final_qty -= qtyClose;
        trade.qty_rounded = trade.final_qty;

        const remainPct = trade.final_qty / (trade.final_qty + qtyClose);
        trade.actual_risk = trade.actual_risk * remainPct;

        const siblings = store.state.trades.filter(x => x.parent_id === trade.id);
        const childId = trade.id + '.' + (siblings.length + 1);

        const closedObj = {
          ...trade, id: childId, parent_id: trade.id,
          final_qty: qtyClose, qty_rounded: qtyClose,
          actual_risk: trade.actual_risk / remainPct * (1 - remainPct),
          status: 'Closed', close_price: closePrice, close_date: cDate,
          realized_pnl: realized, notes: (trade.notes || '') + ' (partial close)',
          mark_price: null
        };

        if (trade.hedge) {
          trade.hedge.qty -= hedgeQtyClose;
          closedObj.hedge = { ...trade.hedge, qty: hedgeQtyClose, close_price: closePriceHedge, mark_price: null };
        }

        store.addTrade(closedObj);
      } else {
        // FULL CLOSE
        trade.status = 'Closed';
        trade.close_price = closePrice;
        trade.close_date = cDate;
        trade.realized_pnl = realized;
        trade.mark_price = null;
        if (trade.hedge) {
          trade.hedge.close_price = closePriceHedge;
          trade.hedge.mark_price = null;
        }
        store.save();
      }

      modal.classList.add('hidden');
      UI.renderPNL();
      UI.renderKanban();
      UI.renderDashboard();
    };
  },

  handleEditClosePrice(trade) {
    const modal = $('#modal-edit-close');
    if (!modal) return;

    $('#modal-edit-close-price').value = trade.close_price;
    const hedgeGrp = $('#modal-edit-hedge-close-group');
    if (hedgeGrp) {
      if (trade.hedge) {
        hedgeGrp.classList.remove('hidden');
        $('#modal-edit-close-price-hedge').value = trade.hedge.close_price || '';
      } else {
        hedgeGrp.classList.add('hidden');
        $('#modal-edit-close-price-hedge').value = '';
      }
    }

    modal.classList.remove('hidden');

    $('#btn-modal-edit-close-x').onclick = () => modal.classList.add('hidden');

    const btnSubmit = $('#btn-modal-submit-edit-close');
    btnSubmit.onclick = () => {
      const cp = Number($('#modal-edit-close-price').value);
      if (isNaN(cp) || cp <= 0) return showToast('Invalid close price', 'error');

      let hp = null;
      if (trade.hedge) {
        hp = Number($('#modal-edit-close-price-hedge').value);
        if (isNaN(hp) || hp <= 0) return showToast('Invalid hedge close price', 'error');
      }

      trade.close_price = cp;
      if (trade.hedge) trade.hedge.close_price = hp;

      const dir = (trade.direction === 'Short') ? -1 : 1;
      const mainRealized = dir * (cp - trade.entry) * trade.final_qty;
      let hedgeRealized = 0;
      if (trade.hedge) {
        hedgeRealized = (hp - trade.hedge.entry) * trade.hedge.qty;
      }
      trade.realized_pnl = mainRealized + hedgeRealized;

      store.save();
      modal.classList.add('hidden');
      showToast('Exit price updated successfully', 'success');

      UI.renderPNL();
      UI.renderKanban();
      UI.renderDashboard();
    };
  },

  renderClosedTradesGrouped(container, closedTradesOverride = null) {
    const closed = closedTradesOverride || store.state.trades.filter(x => x.status === 'Closed');
    const groups = {};
    closed.forEach(c => {
      const key = c.parent_id || c.id;
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });
    Object.keys(groups).forEach(key => {
      const items = groups[key];
      items.sort((a, b) => new Date(a.close_date) - new Date(b.close_date));
      let parent = store.state.trades.find(t => t.id === key);
      if (!parent && items.length) parent = items[0];
      const totalQty = items.reduce((s, i) => s + i.final_qty, 0);
      const totalRealized = items.reduce((s, i) => s + i.realized_pnl, 0);
      const totalRisk = items.reduce((s, i) => s + (i.actual_risk || 0.01), 0);
      const weightedExit = totalQty ? (items.reduce((s, i) => s + (i.close_price * i.final_qty), 0) / totalQty) : 0;

      const tr = document.createElement('tr');
      tr.classList.add('bg-white', 'border-b', 'hover:bg-gray-50');
      const expandId = 'grp-' + key.replace(/[^a-zA-Z0-9]/g, '');
      const dirBadge = parent.direction === 'Short' ? '<span class="text-xs font-bold text-red-500">SHORT</span>' : '<span class="text-xs font-bold text-green-600">LONG</span>';

      // Progress bar for parent
      const pct = Math.min(100, (Math.abs(totalRealized) / (parent.actual_risk || totalRisk || 0.01)) * 100);
      const color = totalRealized >= 0 ? 'green' : 'red';
      const mText = totalRealized >= 0 ? `+${(pct / 100).toFixed(1)}R` : `-${(pct / 100).toFixed(1)}R`;
      const pBar = `<div class="flex items-center gap-2"><div class="progress-bg w-16"><div class="progress-bar ${color}" style="width:${pct}%"></div></div><span class="text-xs text-gray-500">${mText}</span></div>`;

      tr.innerHTML = `<td class="p-2">${items.length > 1 ? `<button data-target="${expandId}" class="toggle-grp text-xs text-gray-500 hover:text-gray-900 mr-1 transition-transform">\u25b6</button>` : '<span class="w-3 mr-1 inline-block"></span>'} ${items[items.length - 1].close_date}</td><td>${parent.instrument}</td><td>${dirBadge}</td><td>${parent.entry}</td><td>${weightedExit.toFixed(2)}${items.length === 1 ? ` <button class="btn-edit-close ml-2 text-xs text-orange-500 hover:text-orange-700" data-id="${parent.id}" title="Edit Exit Price">\u270f\ufe0f</button>` : ''}</td><td>${totalQty}</td><td class="${totalRealized >= 0 ? 'text-green-600' : 'text-red-600'} font-semibold">${Calc.money(totalRealized)}</td><td>${pBar}</td><td><button class="jump-btn ml-2 text-xs text-blue-500 hover:text-blue-700" title="View in Trades">\u2197</button></td>`;
      container.appendChild(tr);

      tr.querySelector('.jump-btn').addEventListener('click', () => {
        $('.tab-btn[data-tab="trades"]').click();
        setTimeout(() => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }, parent.id), 50);
      });

      if (items.length > 1) {
        items.forEach(it => {
          const sub = document.createElement('tr');
          sub.classList.add(expandId, 'hidden', 'text-xs', 'text-gray-500', 'bg-gray-50', 'border-b');

          const sPct = Math.min(100, (Math.abs(it.realized_pnl) / (it.actual_risk || 0.01)) * 100);
          const sColor = it.realized_pnl >= 0 ? 'green' : 'red';
          const sText = it.realized_pnl >= 0 ? `+${(sPct / 100).toFixed(1)}R` : `-${(sPct / 100).toFixed(1)}R`;
          const sBar = `<div class="flex items-center gap-2"><div class="progress-bg w-10"><div class="progress-bar ${sColor}" style="width:${sPct}%"></div></div><span class="text-xs text-gray-400">${sText}</span></div>`;

          sub.innerHTML = `<td class="pl-8">Part: ${it.close_date}</td><td></td><td></td><td>\u2014</td><td>${it.close_price} <button class="btn-edit-close ml-2 text-xs text-orange-500 hover:text-orange-700" data-id="${it.id}" title="Edit Exit Price">\u270f\ufe0f</button></td><td>${it.final_qty}</td><td class="${it.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}">${Calc.money(it.realized_pnl)}</td><td>${sBar}</td><td></td>`;
          container.appendChild(sub);
        });
      }
    });

    container.querySelectorAll('.toggle-grp').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        const subs = document.getElementsByClassName(target);
        for (let row of subs) { row.classList.toggle('hidden'); }
        btn.textContent = btn.textContent === '\u25b6' ? '\u25bc' : '\u25b6';
      });
    });

    container.querySelectorAll('.btn-edit-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = store.state.trades.find(x => x.id === btn.dataset.id);
        if (t) UI.handleEditClosePrice(t);
      });
    });
  },

  renderAnalytics() {
    const { trades, systems } = store.state;
    const win = Calc.computeWinRate(trades);
    const pf = Calc.computeProfitFactor(trades);
    const rm = Calc.computeAvgRMultiple(trades, systems);
    const avg = Calc.computeAvgTrade(trades);
    const draw = Calc.estimateMaxDrawdown(trades);

    if ($('#analytic-win')) $('#analytic-win').textContent = win === null ? '—' : win.toFixed(1) + '%';
    if ($('#analytic-pf')) $('#analytic-pf').textContent = formatPF(pf);
    if ($('#analytic-rmul')) $('#analytic-rmul').textContent = rm === null ? '—' : rm.toFixed(2);
    if ($('#analytic-avgp')) $('#analytic-avgp').textContent = avg === null ? '—' : Calc.money(avg);
    if ($('#analytic-draw')) $('#analytic-draw').textContent = draw === null ? '—' : (draw.toFixed(1) + '%');
    if ($('#analytic-total')) $('#analytic-total').textContent = trades.length;

    const pts = []; let cum = 0;
    const sorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));
    const labels = sorted.map((t, i) => 'T' + (i + 1) + ' (' + t.date + ')');
    sorted.forEach(t => {
      const dir = (t.direction === 'Short') ? -1 : 1;
      let pnl = 0;
      if (t.status === 'Closed') {
        pnl = Number(t.realized_pnl || 0);
      } else if (t.mark_price != null) {
        pnl = dir * (Number(t.mark_price) - Number(t.entry || 0)) * Number(t.final_qty || 0);
      }
      cum += pnl;
      pts.push(cum / 100000);
    });
    if (pts.length === 0) pts.push(0);
    Charts.renderDetailedEquityChart('equityChart2', pts, labels);
    this.renderTagAnalytics(trades);
  },

  renderTagAnalytics(trades) {
    const tbody = $('#analytics-tags-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const stats = Calc.computeTagAnalytics(trades);
    stats.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${s.tag}</td><td>${s.count}</td><td>${s.winRate.toFixed(1)}%</td><td>${s.pf.toFixed(2)}</td><td class="${s.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}">${Calc.money(s.totalPnL)}</td>`;
      tbody.appendChild(tr);
    });
  }
};



// ==========================================
// 6. SYNC MODULE (Google Sheets)
// ==========================================
const Sync = {
  // State
  config: { clientId: '', apiKey: '', sheetId: '' },
  tokenClient: null,
  accessToken: null,

  // Init
  init() {
    // Load config
    const save = localStorage.getItem('risk_engine_gconf');
    if (save) {
      this.config = JSON.parse(save);
      if ($('#g-client-id')) $('#g-client-id').value = this.config.clientId || '';
      if ($('#g-api-key')) $('#g-api-key').value = this.config.apiKey || '';
      if ($('#g-sheet-id')) $('#g-sheet-id').value = this.config.sheetId || '';
    }

    // Listeners
    if ($('#btn-save-gconf')) $('#btn-save-gconf').onclick = () => this.saveConfig();
    if ($('#btn-g-auth')) $('#btn-g-auth').onclick = () => this.handleAuth();
    if ($('#btn-g-push')) $('#btn-g-push').onclick = () => this.pushToSheet();
    if ($('#btn-g-pull')) $('#btn-g-pull').onclick = () => this.pullFromSheet();
  },

  log(msg) {
    const d = $('#g-logs');
    if (d) {
      d.innerHTML += `<div>> ${msg}</div>`;
      d.scrollTop = d.scrollHeight;
    }
  },

  saveConfig() {
    this.config.clientId = $('#g-client-id').value.trim();
    this.config.apiKey = $('#g-api-key').value.trim();
    this.config.sheetId = $('#g-sheet-id').value.trim();
    localStorage.setItem('risk_engine_gconf', JSON.stringify(this.config));
    this.log('Configuration Saved. Please Authenticate.');
    alert('Saved. Now click Connect.');
  },

  async handleAuth() {
    // 1. Check Protocol
    if (window.location.protocol === 'file:') {
      const msg = "SECURITY ERROR: Google Auth does not work on file:// protocol.\n\nPlease run a local server:\n1. Open CMD in this folder\n2. Run: python -m http.server 8000\n3. Open http://localhost:8000";
      this.log(msg);
      alert(msg);
      return;
    }

    if (!this.config.clientId || !this.config.apiKey) return alert('Enter Client ID and API Key first');

    this.log('Initializing GAPI...');

    try {
      // 2. Load GAPI Client
      await new Promise((resolve, reject) => {
        gapi.load('client', { callback: resolve, onerror: reject });
      });

      await gapi.client.init({
        apiKey: this.config.apiKey,
        discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
      });

      this.log('Initializing GIS...');

      // 3. Init GIS Token Client
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.config.clientId,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        callback: (resp) => {
          if (resp.error) {
            this.log('Auth Error: ' + resp.error);
            return;
          }
          this.accessToken = resp.access_token;
          this.updateStatus('Connected');
          this.log('Authentication Successful.');
        },
      });

      // 4. Request Token
      if (gapi.client.getToken() === null) {
        this.tokenClient.requestAccessToken({ prompt: 'consent' });
      } else {
        this.tokenClient.requestAccessToken({ prompt: '' });
      }
    } catch (e) {
      console.error(e);
      this.log('ERROR: ' + (e.message || JSON.stringify(e)));
      alert('Connection Failed. Check Logs.');
    }
  },

  updateStatus(status) {
    const el = $('#g-status');
    if (el) {
      el.textContent = 'Status: ' + status;
      el.className = "text-sm mb-2 p-2 rounded " + (status === 'Connected' ? 'bg-green-100 text-green-800' : 'bg-yellow-50 text-yellow-800');
    }
    if (status === 'Connected') {
      $('#btn-g-push').disabled = false; $('#btn-g-push').classList.remove('opacity-50', 'cursor-not-allowed');
      $('#btn-g-pull').disabled = false; $('#btn-g-pull').classList.remove('opacity-50', 'cursor-not-allowed');
    }
  },

  // --- EXPORT ---
  async pushToSheet() {
    if (!this.accessToken) return alert('Not connected');
    const sid = this.config.sheetId;
    if (!sid) return alert('No Sheet ID');

    this.log('Starting Export...');

    try {
      // Prepare Data
      const dataSystems = [['Name', 'Capital', 'R']];
      store.state.systems.forEach(s => dataSystems.push([s.name, s.capital, s.R]));

      const dataInstruments = [['Symbol', 'Lot', 'Type']];
      store.state.instruments.forEach(i => dataInstruments.push([i.symbol, i.lot, i.type]));

      const dataTrades = [['ID', 'Date', 'System', 'Symbol', 'Entry', 'Exit', 'Qty', 'PnL', 'Status', 'Risk', 'Tags', 'Notes', 'Mark']];
      store.state.trades.forEach(t => dataTrades.push([
        t.id, t.date, t.system, t.instrument, t.entry, t.exit, t.final_qty, t.realized_pnl, t.status, t.actual_risk,
        (t.tags || []).join(','), t.notes || '', t.mark_price || ''
      ]));

      // Write
      await this.writeSheet(sid, 'Systems!A1', dataSystems);
      await this.writeSheet(sid, 'Instruments!A1', dataInstruments);
      await this.writeSheet(sid, 'Trades!A1', dataTrades);

      this.log('Export Complete!');
      showToast('Synced to Google Sheet ✓', 'success');
    } catch (e) {
      this.log('Export Failed: ' + e.message);
      console.error(e);
    }
  },

  async writeSheet(spreadsheetId, range, values) {
    try {
      await gapi.client.sheets.spreadsheets.values.update({
        spreadsheetId, range, valueInputOption: 'RAW', resource: { values }
      });
    } catch (e) {
      if (e.result && e.result.error && e.result.error.message.includes('Unable to parse range')) {
        this.log(`Error: Tab for ${range} might be missing. Please ensure 'Systems', 'Instruments', and 'Trades' tabs exist.`);
        throw e;
      }
      throw e;
    }
  },

  // --- IMPORT ---
  async pullFromSheet() {
    if (!this.config.sheetId) return;
    if (!await showConfirm('This will OVERWRITE all local data with Sheet data. Continue?')) return;

    this.log('Starting Import...');
    try {
      const sid = this.config.sheetId;

      // Read Systems
      const respSys = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'Systems!A2:C100' });
      const rowsSys = respSys.result.values || [];

      // Read Instruments
      const respInst = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'Instruments!A2:C100' });
      const rowsInst = respInst.result.values || [];

      // Read Trades
      const respTrd = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'Trades!A2:M1000' });
      const rowsTrd = respTrd.result.values || [];

      // Rebuild State
      const newSystems = rowsSys.map(r => ({ name: r[0], capital: Number(r[1]), R: Number(r[2]) }));
      const newInstruments = rowsInst.map(r => ({ symbol: r[0], lot: Number(r[1]), type: r[2] }));

      const newTrades = rowsTrd.map(r => ({
        id: r[0], date: r[1], system: r[2], instrument: r[3],
        entry: Number(r[4]), exit: Number(r[5]), final_qty: Number(r[6]),
        realized_pnl: Number(r[7]), status: r[8], actual_risk: Number(r[9]),
        qty_rounded: Number(r[6]),
        tags: r[10] ? r[10].split(',').filter(Boolean) : [],
        notes: r[11] || '',
        mark_price: r[12] ? Number(r[12]) : null
      }));

      store.replaceState({ systems: newSystems, instruments: newInstruments, trades: newTrades });
      renderAll();
      this.log('Import Complete.');
      showToast('Data imported from Sheet ✓', 'success');

    } catch (e) {
      this.log('Import Failed: ' + e.message);
      console.error(e);
    }
  }
};

// ==========================================
// 7. APP CONTROLLER
// ==========================================
let editingTradeId = null;

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) { console.warn(message); return; }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-msg').textContent = message;
    modal.classList.remove('hidden');
    const cleanup = (result) => {
      modal.classList.add('hidden');
      resolve(result);
    };
    document.getElementById('modal-confirm-ok').onclick = () => cleanup(true);
    document.getElementById('modal-confirm-cancel').onclick = () => cleanup(false);
  });
}

function validateTradeForm() {
  let valid = true;
  const fields = [
    { id: 'nt-system', check: v => v !== '', msg: 'Select a system' },
    { id: 'nt-instrument', check: v => v.trim() !== '', msg: 'Enter instrument symbol' },
    { id: 'nt-entry', check: v => Number(v) > 0, msg: 'Entry price must be > 0' },
    { id: 'nt-exit', check: v => Number(v) > 0, msg: 'Exit/SL must be > 0' },
    { id: 'nt-lot', check: v => Number(v) > 0, msg: 'Lot size must be > 0' },
  ];
  // Clear previous errors
  fields.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    el.classList.remove('field-error');
    const prev = el.parentElement.querySelector('.field-error-msg');
    if (prev) prev.remove();
  });
  // Validate
  fields.forEach(f => {
    const el = document.getElementById(f.id);
    if (!el) return;
    if (!f.check(el.value)) {
      el.classList.add('field-error');
      const msg = document.createElement('span');
      msg.className = 'field-error-msg';
      msg.textContent = f.msg;
      el.parentElement.appendChild(msg);
      valid = false;
    }
  });
  // Entry ≠ Exit check
  const entry = Number(document.getElementById('nt-entry').value);
  const exit = Number(document.getElementById('nt-exit').value);
  if (entry > 0 && exit > 0 && entry === exit) {
    const el = document.getElementById('nt-exit');
    el.classList.add('field-error');
    const msg = document.createElement('span');
    msg.className = 'field-error-msg';
    msg.textContent = 'Entry and Exit/SL cannot be equal';
    el.parentElement.appendChild(msg);
    valid = false;
  }
  return valid;
}

async function init() {
  await store.load();
  Sync.init(); // Init Sync
  renderAll();
  setupTabs();
  setupNewTradeForm();
  setupGlobalListeners();
}

function renderAll() {
  UI.renderSystems();
  UI.renderInstruments();
  UI.renderTrades((trade) => {
    editingTradeId = trade.id;
    document.querySelector('.tab-btn[data-tab="newtrade"]').click();
    fillTradeForm(trade);
  });
  UI.renderPNL();
  UI.renderDashboard();
  UI.renderAnalytics();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-view').forEach(v => v.classList.add('hidden'));
      const view = document.getElementById('view-' + tab);
      if (view) view.classList.remove('hidden');

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('bg-gray-100'));
      btn.classList.add('bg-gray-100');

      if (tab === 'dashboard') UI.renderDashboard();
      if (tab === 'systems') UI.renderSystems();
      if (tab === 'instruments') UI.renderInstruments();
      if (tab === 'newtrade') setupNewTradeForm();
      if (tab === 'trades') UI.renderTrades((t) => { editingTradeId = t.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(t); });
      if (tab === 'kanban') UI.renderKanban();
      if (tab === 'analytics') UI.renderAnalytics();
      if (tab === 'pnl') UI.renderPNL();
      if (tab === 'admin') fetchAdminUsers();
      // cloud tab needs no render logic
    });
  });

  if ($('#refresh-kanban')) $('#refresh-kanban').onclick = () => UI.renderKanban();

  // Set default
  const def = $('.tab-btn[data-tab="dashboard"]');
  if (def) def.click();
}

function setupNewTradeForm() {
  const sel = $('#nt-system');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- pick system --</option>';
  store.state.systems.forEach(s => {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = s.name;
    sel.appendChild(o);
  });
  if (currentVal) sel.value = currentVal;
  // Custom search results will populate dynamically on input
  if ($('#nt-date') && !$('#nt-date').value) $('#nt-date').value = Calc.nowDate();
  const ids = ['nt-system', 'nt-entry', 'nt-exit', 'nt-instrument', 'nt-lot', 'nt-strike', 'nt-optiontype', 'nt-tags', 'nt-round-mode', 'hedge-premium', 'hedge-qty', 'hedge-instrument', 'hedge-strike'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.oninput = (e) => {
        el.classList.remove('field-error');
        if (e.target.id.startsWith('hedge-')) { delete e.target.dataset.autofilled; }
        const prev = el.parentElement.querySelector('.field-error-msg');
        if (prev) prev.remove();
        updateTradeCalc();
      };
    }
  });
  if ($('#prefill-lot')) $('#prefill-lot').onclick = () => {
    const sym = $('#nt-instrument').value.trim().toUpperCase();
    const it = getInstrumentMaster().find(x => x.symbol.toUpperCase() === sym);
    if (it) { $('#nt-lot').value = it.lot; updateTradeCalc(); }
    else showToast('Instrument not found in master list', 'warning');
  };
  const instInput = $('#nt-instrument');
  const instResults = $('#inst-results');
  if (instInput && instResults) {
    instInput.addEventListener('input', () => {
      const val = instInput.value.trim().toUpperCase();
      instResults.innerHTML = '';
      if (val.length < 1) {
        instResults.classList.add('hidden');
        return;
      }
      // Re-trigger the calc and error hiding
      instInput.classList.remove('field-error');
      const prevErr = instInput.parentElement.querySelector('.field-error-msg');
      if (prevErr) prevErr.remove();

      const matches = getInstrumentMaster().filter(i => i.symbol.toUpperCase().includes(val)).slice(0, 10);
      if (matches.length > 0) {
        matches.forEach(m => {
          const div = document.createElement('div');
          div.className = 'p-2 hover:bg-blue-50 cursor-pointer border-b text-sm last:border-0';
          div.innerHTML = `<span class="font-bold">${m.symbol}</span> <span class="text-xs text-gray-500">(Lot: ${m.lot}, ${m.type})</span>`;
          div.onclick = (e) => {
            e.stopPropagation();
            instInput.value = m.symbol;
            instResults.classList.add('hidden');
            // Trigger change logic
            const event = new Event('change');
            instInput.dispatchEvent(event);
          };
          instResults.appendChild(div);
        });
        instResults.classList.remove('hidden');
      } else {
        instResults.classList.add('hidden');
      }
      updateTradeCalc();
    });

    // Close results when clicking outside
    document.addEventListener('click', (e) => {
      if (!instInput.contains(e.target) && !instResults.contains(e.target)) {
        instResults.classList.add('hidden');
      }
    });

    instInput.addEventListener('change', () => {
      const sym = instInput.value.trim().toUpperCase();
      const it = getInstrumentMaster().find(x => x.symbol.toUpperCase() === sym);
      if (it) {
        $('#nt-lot').value = it.lot;
        if (it.type === 'Options') {
          $('#option-fields').classList.remove('hidden');
          $('#option-type-field').classList.remove('hidden');
        } else {
          $('#option-fields').classList.add('hidden');
          $('#option-type-field').classList.add('hidden');
        }
      } else {
        $('#nt-lot').value = '';
        $('#option-fields').classList.add('hidden');
        $('#option-type-field').classList.add('hidden');
      }
      updateTradeCalc();
    });
  }

  // Sizing mode toggle
  const sizingToggle = $('#nt-sizing-mode');
  const sizingLabel = $('#nt-sizing-label');
  const numLotsGroup = $('#nt-num-lots-group');
  const roundModeEl = $('#nt-round-mode');

  function applySizingMode() {
    const isRisk = sizingToggle && sizingToggle.checked;
    if (sizingLabel) sizingLabel.textContent = isRisk ? 'Risk Mode (R determines qty)' : 'Lot Mode (1 lot default)';
    if (numLotsGroup) numLotsGroup.style.display = isRisk ? 'none' : '';
    if (roundModeEl) roundModeEl.closest('div').style.display = isRisk ? '' : 'none';
    updateTradeCalc();
  }
  if (sizingToggle) {
    sizingToggle.addEventListener('change', applySizingMode);
    applySizingMode(); // Apply on init
  }

  // Num lots input
  const numLotsInput = $('#nt-num-lots');
  if (numLotsInput) {
    numLotsInput.oninput = () => updateTradeCalc();
  }

  const toggleHedgeBtn = $('#toggle-hedge');
  const hedgeFieldsContainer = $('#hedge-fields');
  if (toggleHedgeBtn && hedgeFieldsContainer) {
    toggleHedgeBtn.onclick = () => {
      const isHidden = hedgeFieldsContainer.classList.toggle('hidden');
      toggleHedgeBtn.querySelector('.chevron').classList.toggle('rotate-90');

      const hInst = $('#hedge-instrument');
      const hStrike = $('#hedge-strike');
      const hQty = $('#hedge-qty');

      if (!isHidden) {
        if (hInst && !hInst.value && instInput) { hInst.value = instInput.value; hInst.dataset.autofilled = 'true'; }
        if (hStrike && !hStrike.value && $('#nt-exit')) { hStrike.value = $('#nt-exit').value; hStrike.dataset.autofilled = 'true'; }
        const currentQtyText = $('#calc-finalqty') ? $('#calc-finalqty').textContent.trim() : '';
        if (hQty && !hQty.value && currentQtyText !== '—') { hQty.value = currentQtyText; hQty.dataset.autofilled = 'true'; }
      } else {
        if (hInst) { hInst.value = ''; delete hInst.dataset.autofilled; }
        if (hStrike) { hStrike.value = ''; delete hStrike.dataset.autofilled; }
        if (hQty) { hQty.value = ''; delete hQty.dataset.autofilled; }
        if ($('#hedge-premium')) $('#hedge-premium').value = '';
      }
      updateTradeCalc();
    };
  }

  $('#save-trade').onclick = saveTrade;
  $('#reset-trade').onclick = resetForm;
}

function updateTradeCalc() {
  const sysName = $('#nt-system').value;
  const sys = store.state.systems.find(s => s.name === sysName);
  const R = sys ? Number(sys.R || 0) : 0;
  $('#calc-R').textContent = R ? Calc.money(R) : '—';
  const entry = Number($('#nt-entry').value || 0);
  const exit = Number($('#nt-exit').value || 0);
  const lot = Number($('#nt-lot').value || 0);
  const roundMode = $('#nt-round-mode') ? $('#nt-round-mode').value : 'down';

  const isRiskMode = $('#nt-sizing-mode') && $('#nt-sizing-mode').checked;
  const riskPerShare = Math.abs(entry - exit);

  let finalqty = '—';
  let qtyrounded = '—';
  let qty = 0;

  if (isRiskMode) {
    // RISK MODE: R determines qty
    const calc = Calc.calculateRiskQty(R, entry, exit);
    qty = calc.qty;
    $('#calc-riskqty').textContent = calc.riskPerShare || '—';
    $('#calc-qtyrisk').textContent = qty || '—';
    if (qty > 0 && lot > 0) {
      qtyrounded = Calc.enforceLotSize(qty, lot, roundMode);
      finalqty = qtyrounded;
    }
  } else {
    // LOT MODE: lots × lotSize = qty
    const numLots = Number($('#nt-num-lots') ? $('#nt-num-lots').value || 1 : 1);
    qty = numLots * lot;
    finalqty = qty > 0 ? qty : '—';
    qtyrounded = finalqty;
    $('#calc-riskqty').textContent = riskPerShare || '—';
    $('#calc-qtyrisk').textContent = qty || '—';
  }

  $('#calc-qtyrounded').textContent = qtyrounded;
  $('#calc-finalqty').textContent = finalqty;

  const hedgeFieldsContainer = $('#hedge-fields');
  if (hedgeFieldsContainer && !hedgeFieldsContainer.classList.contains('hidden')) {
    const hInst = $('#hedge-instrument');
    const hStrike = $('#hedge-strike');
    const hQty = $('#hedge-qty');

    if (hInst && hInst.dataset.autofilled === 'true') hInst.value = $('#nt-instrument').value;
    if (hStrike && hStrike.dataset.autofilled === 'true') hStrike.value = $('#nt-exit').value;
    if (hQty && hQty.dataset.autofilled === 'true') hQty.value = finalqty !== '—' ? finalqty : '';
  }
  const actualRisk = (finalqty !== '—' && riskPerShare) ? (finalqty * riskPerShare) : '—';
  $('#calc-actual').textContent = actualRisk === '—' ? '—' : Calc.money(actualRisk);
  const totalBuy = (finalqty !== '—' && entry) ? (finalqty * entry) : '—';
  $('#calc-totalbuy').textContent = totalBuy === '—' ? '—' : Calc.money(totalBuy);

  // Hedge Risk Calc
  const hedgePremium = Number($('#hedge-premium') ? $('#hedge-premium').value || 0 : 0);
  const hedgeQty = Number($('#hedge-qty') ? $('#hedge-qty').value || 0 : 0);
  const hedgeRisk = hedgePremium * hedgeQty;
  if ($('#calc-hedge-risk')) $('#calc-hedge-risk').textContent = hedgeRisk > 0 ? Calc.money(hedgeRisk) : '—';

  // Total Risk (Main + Hedge)
  const mainRiskNum = (actualRisk !== '—') ? actualRisk : 0;
  const totalRisk = mainRiskNum + hedgeRisk;
  if ($('#calc-total-risk')) $('#calc-total-risk').textContent = totalRisk > 0 ? Calc.money(totalRisk) : '—';
}

async function saveTrade() {
  if (!validateTradeForm()) return;
  const sysName = $('#nt-system').value;
  if (!sysName) return showToast('Select a system', 'warning');
  const inst = $('#nt-instrument').value.trim();
  const entry = Number($('#nt-entry').value);
  const exit = Number($('#nt-exit').value);
  const lot = Number($('#nt-lot').value || 1);
  const roundMode = $('#nt-round-mode') ? $('#nt-round-mode').value : 'down';
  const isRiskMode = $('#nt-sizing-mode') && $('#nt-sizing-mode').checked;

  const sys = store.state.systems.find(s => s.name === sysName);
  const R = sys ? Number(sys.R) : 0;
  const riskPerShare = Math.abs(entry - exit);
  let final_qty = 0;
  let qty = 0;

  if (isRiskMode) {
    // RISK MODE
    const calc = Calc.calculateRiskQty(R, entry, exit);
    qty = calc.qty;
    if (qty > 0 && lot > 0) {
      final_qty = Calc.enforceLotSize(qty, lot, roundMode);
      if (final_qty === 0) {
        showToast(
          `Position size is 0 lots at current R (₹${R.toLocaleString()}). ` +
          `Your R must be ≥ ₹${(riskPerShare * lot).toLocaleString()} for 1 lot. ` +
          `Try Round Up mode or increase R.`,
          'error'
        );
        return;
      }
    } else {
      showToast('Entry and Exit/SL cannot be the same price.', 'error');
      return;
    }
  } else {
    // LOT MODE
    const numLots = Number($('#nt-num-lots') ? $('#nt-num-lots').value || 1 : 1);
    if (!riskPerShare) {
      showToast('Entry and Exit/SL cannot be the same price.', 'error');
      return;
    }
    final_qty = numLots * lot;
    qty = final_qty; // In Lot Mode, qty and final_qty are the same
    if (final_qty <= 0) {
      showToast('Invalid lot size or number of lots.', 'error');
      return;
    }
  }

  const actual_risk = final_qty * riskPerShare;
  const leverage = R ? (actual_risk / R) : 1;

  // GENERATE ID: trade_1, trade_2...
  let newId = editingTradeId;
  if (!newId) {
    const existingIds = store.state.trades.map(t => t.id);
    // filtered top level ints
    let maxId = 0;
    existingIds.forEach(id => {
      if (id.startsWith('trade_')) {
        const parts = id.split('_');
        // handle 1.1 etc
        const mainNum = parseInt(parts[1].split('.')[0]);
        if (mainNum > maxId) maxId = mainNum;
      }
    });
    newId = 'trade_' + (maxId + 1);
  }

  // Direction
  const direction = $('#nt-direction') ? $('#nt-direction').value : 'Long';

  // Hedge
  let hedge = null;
  const hedgePremium = Number($('#hedge-premium') ? $('#hedge-premium').value || 0 : 0);
  const hedgeQty = Number($('#hedge-qty') ? $('#hedge-qty').value || 0 : 0);
  if (hedgePremium > 0 && hedgeQty > 0) {
    hedge = {
      instrument: $('#hedge-instrument') ? $('#hedge-instrument').value.trim() : inst,
      strike: Number($('#hedge-strike') ? $('#hedge-strike').value || 0 : 0),
      type: $('#hedge-type') ? $('#hedge-type').value : 'PE',
      entry: hedgePremium,
      qty: hedgeQty,
      mark_price: null,
      exit_price: null
    };
  }
  const hedgeRisk = hedge ? hedge.entry * hedge.qty : 0;
  const total_risk = actual_risk + hedgeRisk;

  const tradeObj = {
    id: newId,
    date: $('#nt-date').value || Calc.nowDate(),
    R_at_entry: R,
    system: sysName,
    instrument: inst,
    direction,
    strike: $('#nt-strike').value ? Number($('#nt-strike').value) : null,
    optionType: $('#nt-optiontype').value || null,
    entry, exit, lot,
    qty_risk: qty, final_qty, qty_rounded: final_qty, actual_risk, total_risk, leverage,
    hedge,
    flag: leverage > 1 ? 'Over risk' : 'OK',
    tags: $('#nt-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    notes: '', status: 'Open', close_price: null, close_date: null, realized_pnl: null, mark_price: null
  };
  if (editingTradeId) store.updateTrade(tradeObj);
  else store.addTrade(tradeObj);
  if (!store.state.instruments.find(x => x.symbol === inst)) {
    if (await showConfirm('Add new instrument to master?')) {
      store.addInstrument({ symbol: inst, lot, type: tradeObj.optionType ? 'Options' : 'Futures' });
    }
  }
  showToast('Trade saved ✓', 'success');
  resetForm();
  editingTradeId = null;
  UI.renderDashboard();
}

function resetForm() {
  editingTradeId = null;
  ['nt-entry', 'nt-exit', 'nt-instrument', 'nt-lot', 'nt-strike', 'nt-optiontype', 'nt-tags',
    'hedge-instrument', 'hedge-strike', 'hedge-premium', 'hedge-qty'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  $('#nt-system').value = '';
  if ($('#nt-direction')) $('#nt-direction').value = 'Long';
  setDirection('Long');
  if ($('#hedge-fields')) $('#hedge-fields').classList.add('hidden');
  updateTradeCalc();
}

function setupGlobalListeners() {
  // Configurable Mobile Sidebar Drawer
  const sidebar = $('#sidebar');
  const overlay = $('#mobile-overlay');
  const toggleBtn = $('#toggle-sidebar');
  const toggleMenu = () => {
    if (sidebar) sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open');
  };
  if (toggleBtn) toggleBtn.onclick = toggleMenu;
  if (overlay) overlay.onclick = toggleMenu;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 900) {
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
      }
    });
  });

  // Kanban Filter Action
  const kbFilt = $('#kanban-filter-period');
  if (kbFilt) kbFilt.onchange = () => UI.renderKanban();

  const exportBtn = $('#btn-export-pdf');
  if (exportBtn) {
    exportBtn.onclick = () => {
      showToast('Preparing PDF Export...', 'info', 2000);
      const el = document.querySelector('main');
      const opt = {
        margin: 10, filename: 'Risk_Engine_Report.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
      };
      html2pdf().set(opt).from(el).save();
    };
  }

  const themeBtn = $('#theme-toggle');
  if (themeBtn) themeBtn.onclick = () => {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme_dark', document.documentElement.classList.contains('dark') ? '1' : '0');
  };
  if (localStorage.getItem('theme_dark') === '1') document.documentElement.classList.add('dark');
  if ($('#btn-backup')) $('#btn-backup').onclick = () => {
    const blob = new Blob([JSON.stringify(store.state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'risk_engine_backup.json'; a.click();
  };
  if ($('#restore-input')) $('#restore-input').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const obj = JSON.parse(ev.target.result);
        store.replaceState(obj);
        renderAll();
        showToast('Backup restored ✓', 'success');
      } catch (e) { showToast('Invalid backup file', 'error'); }
    };
    r.readAsText(f);
  };
  if ($('#btn-clear')) $('#btn-clear').onclick = async () => {
    if (await showConfirm('Delete ALL local data? This cannot be undone.')) {
      store.replaceState({ systems: [], instruments: [], trades: [] });
      renderAll();
    }
  };

  // FIX: Missing Listeners for Adding
  if ($('#add-system')) $('#add-system').onclick = () => {
    store.addSystem({ name: 'System ' + (store.state.systems.length + 1), capital: 100000, R: 1000, daily_loss_limit: 20000 });
    UI.renderSystems();
  };
  if ($('#add-instrument')) $('#add-instrument').onclick = () => {
    store.addInstrument({ symbol: 'New_Inst', lot: 1, type: 'Futures' });
    UI.renderInstruments();
  };

  // F&O Master Excel Upload handler
  const foUpload = document.getElementById('upload-fo-master');
  if (foUpload) {
    foUpload.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const wb = XLSX.read(evt.target.result, { type: 'binary' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
          if (!rows.length) return showToast('Empty spreadsheet', 'error');

          // Try to detect columns (flexible naming)
          const firstRow = rows[0];
          const keys = Object.keys(firstRow);
          const symKey = keys.find(k => /symbol|instrument|stock|name|underlying/i.test(k)) || keys[0];
          const lotKey = keys.find(k => /lot|market.?lot|qty/i.test(k)) || keys[1];
          const typeKey = keys.find(k => /type|segment|inst.?type/i.test(k));

          const parsed = rows
            .filter(r => r[symKey] && String(r[symKey]).trim())
            .map(r => ({
              symbol: String(r[symKey]).trim().toUpperCase(),
              lot: Number(r[lotKey]) || 1,
              type: typeKey && r[typeKey] ? String(r[typeKey]).trim() : 'Futures'
            }));

          if (!parsed.length) return showToast('Could not parse any instruments', 'error');

          localStorage.setItem('nse_fo_master_uploaded', JSON.stringify(parsed));
          showToast(`✅ Loaded ${parsed.length} instruments from "${file.name}"`, 'success');

          // Refresh status
          const status = $('#fo-master-status');
          if (status) status.textContent = `Custom F&O Master: ${parsed.length} instruments loaded from "${file.name}"`;

          // Refresh datalist
          setupNewTradeForm();
        } catch (err) {
          console.error(err);
          showToast('Failed to parse Excel file: ' + err.message, 'error');
        }
      };
      reader.readAsBinaryString(file);
      foUpload.value = '';
    });
  }

  // Auth Button Listeners
  if ($('#btn-login-submit')) {
    $('#btn-login-submit').onclick = async () => {
      const u = $('#auth-user').value;
      const p = $('#auth-pass').value;
      if (!u || !p) return;
      try {
        await Auth.login(u, p);
        await store.load();
        renderAll();
      } catch (e) {
        const errEl = $('#auth-error');
        errEl.classList.remove('hidden');
        $('#auth-error-msg').textContent = e.message;
      }
    };
  }
  if ($('#btn-signup-submit')) {
    $('#btn-signup-submit').onclick = async () => {
      const u = $('#auth-user').value;
      const p = $('#auth-pass').value;
      if (!u || !p) return;
      try {
        await Auth.signup(u, p);
        showToast('Account created! Please login.', 'success');
      } catch (e) {
        const errEl = $('#auth-error');
        errEl.classList.remove('hidden');
        $('#auth-error-msg').textContent = e.message;
      }
    };
  }
  const btnLogout = $('#btn-logout');
  if (btnLogout) {
    btnLogout.onclick = () => Auth.logout();
  }
  const btnDeleteAccount = $('#btn-delete-account');
  if (btnDeleteAccount) {
    btnDeleteAccount.onclick = async () => {
      if (await showConfirm('Are you sure you want to permanently delete your account and all associated data? This cannot be undone.')) {
        try {
          await Auth.deleteAccount();
        } catch (e) {
          showToast(e.message, 'error');
        }
      }
    };
  }

  // Show F&O master status on init
  const foStatus = $('#fo-master-status');
  if (foStatus) {
    const uploaded = localStorage.getItem('nse_fo_master_uploaded');
    if (uploaded) {
      const list = JSON.parse(uploaded);
      foStatus.textContent = `Custom F&O Master: ${list.length} instruments loaded`;
    } else {
      foStatus.textContent = `Using bundled default (${DEFAULT_NSE_MASTER.length} instruments). Upload your own .xlsx to override.`;
    }
  }
}

// Direction toggle
function setDirection(dir) {
  if ($('#nt-direction')) $('#nt-direction').value = dir;
  const longBtn = $('#dir-long');
  const shortBtn = $('#dir-short');
  if (longBtn && shortBtn) {
    if (dir === 'Long') {
      longBtn.className = 'flex-1 py-2 rounded-l-md text-sm font-semibold bg-green-600 text-white border border-green-600 transition-all';
      shortBtn.className = 'flex-1 py-2 rounded-r-md text-sm font-semibold bg-white text-gray-600 border border-gray-300 transition-all';
    } else {
      shortBtn.className = 'flex-1 py-2 rounded-r-md text-sm font-semibold bg-red-600 text-white border border-red-600 transition-all';
      longBtn.className = 'flex-1 py-2 rounded-l-md text-sm font-semibold bg-white text-gray-600 border border-gray-300 transition-all';
    }
  }
  // Auto-set hedge type based on direction
  if ($('#hedge-type')) {
    $('#hedge-type').value = (dir === 'Long') ? 'PE' : 'CE';
  }
  updateTradeCalc();
}

// Fill Trade Form (for editing)
function fillTradeForm(trade) {
  if (!trade) return;
  if ($('#nt-system')) $('#nt-system').value = trade.system || '';
  if ($('#nt-instrument')) $('#nt-instrument').value = trade.instrument || '';
  if ($('#nt-date')) $('#nt-date').value = trade.date || '';
  if ($('#nt-entry')) $('#nt-entry').value = trade.entry || '';
  if ($('#nt-exit')) $('#nt-exit').value = trade.exit || '';
  if ($('#nt-lot')) $('#nt-lot').value = trade.lot || '';
  if ($('#nt-strike')) $('#nt-strike').value = trade.strike || '';
  if ($('#nt-optiontype')) $('#nt-optiontype').value = trade.optionType || 'CE';
  if ($('#nt-tags')) $('#nt-tags').value = (trade.tags || []).join(', ');
  setDirection(trade.direction || 'Long');
  // Hedge
  if (trade.hedge && trade.hedge.strike) {
    if ($('#hedge-fields')) $('#hedge-fields').classList.remove('hidden');
    if ($('#hedge-instrument')) $('#hedge-instrument').value = trade.hedge.instrument || '';
    if ($('#hedge-strike')) $('#hedge-strike').value = trade.hedge.strike || '';
    if ($('#hedge-type')) $('#hedge-type').value = trade.hedge.type || 'PE';
    if ($('#hedge-premium')) $('#hedge-premium').value = trade.hedge.entry || '';
    if ($('#hedge-qty')) $('#hedge-qty').value = trade.hedge.qty || '';
  } else {
    if ($('#hedge-fields')) $('#hedge-fields').classList.add('hidden');
  }
  updateTradeCalc();
}

// Floating Quick Trade Button logic
const quickTradeBtn = document.getElementById('btn-quick-trade');
if (quickTradeBtn) {
  quickTradeBtn.addEventListener('click', () => {
    resetForm();
    const btn = document.querySelector('.tab-btn[data-tab="newtrade"]');
    if (btn) btn.click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// PnL Filter listeners
['pnl-filter-inst', 'pnl-filter-sys', 'pnl-filter-period'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener(id === 'pnl-filter-inst' ? 'keyup' : 'change', () => UI.renderPNL());
});
if ($('#pnl-filter-btn')) $('#pnl-filter-btn').onclick = () => UI.renderPNL();
if ($('#pnl-filter-clear')) {
  $('#pnl-filter-clear').onclick = () => {
    $('#pnl-filter-inst').value = '';
    $('#pnl-filter-sys').value = '';
    $('#pnl-filter-period').value = 'all';
    UI.renderPNL();
  };
}

// Trades Filter listeners
['filter-instrument'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keyup', () => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }));
});
['filter-system', 'filter-period', 'filter-status', 'filter-direction'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }));
});
['filter-date-from', 'filter-date-to'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }));
});
if ($('#btn-refresh')) {
  $('#btn-refresh').onclick = () => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); });
}
if ($('#btn-trades-clear')) {
  $('#btn-trades-clear').onclick = () => {
    ['filter-instrument', 'filter-system'].forEach(id => { if ($('#' + id)) $('#' + id).value = ''; });
    if ($('#filter-period')) $('#filter-period').value = 'all';
    if ($('#filter-status')) $('#filter-status').value = '';
    if ($('#filter-direction')) $('#filter-direction').value = '';
    if ($('#filter-date-from')) { $('#filter-date-from').value = ''; $('#filter-date-from').classList.add('hidden'); }
    if ($('#filter-date-to')) { $('#filter-date-to').value = ''; $('#filter-date-to').classList.add('hidden'); }
    UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); });
  };
}

// ==========================================
// EXCEL EXPORT UTILITY (SheetJS)
// ==========================================
function exportTableToExcel(tableId, filename) {
  const table = document.getElementById(tableId);
  if (!table) return showToast('Table not found', 'error');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.table_to_sheet(table, { raw: false });
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, filename + '.xlsx');
  showToast('📥 Excel downloaded: ' + filename + '.xlsx', 'success');
}

// Trades Excel Export
if ($('#btn-export-trades-xlsx')) {
  $('#btn-export-trades-xlsx').onclick = () => exportTableToExcel('trades-table', 'Trades_Export_' + Calc.nowDate());
}
// PnL Excel Export
if ($('#btn-export-pnl-xlsx')) {
  $('#btn-export-pnl-xlsx').onclick = () => {
    // Build a combined table from open + closed PnL tables
    const wb = XLSX.utils.book_new();
    const openTable = document.getElementById('pnl-open');
    const closedTable = document.getElementById('pnl-closed');
    if (openTable) {
      const ws1 = XLSX.utils.table_to_sheet(openTable.closest('table'), { raw: false });
      XLSX.utils.book_append_sheet(wb, ws1, 'Open Positions');
    }
    if (closedTable) {
      const ws2 = XLSX.utils.table_to_sheet(closedTable.closest('table'), { raw: false });
      XLSX.utils.book_append_sheet(wb, ws2, 'Closed Positions');
    }
    XLSX.writeFile(wb, 'PnL_Export_' + Calc.nowDate() + '.xlsx');
    showToast('📥 PnL Excel downloaded', 'success');
  };
}

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  // Global Shortcuts (Alt + Key)
  if (e.altKey) {
    switch (e.key.toLowerCase()) {
      case 'n':
        e.preventDefault();
        const tabN = document.querySelector('.tab-btn[data-tab="newtrade"]');
        if (tabN) tabN.click();
        break;
      case 'd':
        e.preventDefault();
        const tabD = document.querySelector('.tab-btn[data-tab="dashboard"]');
        if (tabD) tabD.click();
        break;
      case 't':
        e.preventDefault();
        const tabT = document.querySelector('.tab-btn[data-tab="trades"]');
        if (tabT) tabT.click();
        break;
      case 'p':
        e.preventDefault();
        const tabP = document.querySelector('.tab-btn[data-tab="pnl"]');
        if (tabP) tabP.click();
        break;
      case 's':
        e.preventDefault();
        if ($('#view-newtrade') && !$('#view-newtrade').classList.contains('hidden')) {
          $('#save-trade').click();
        }
        break;
    }
  }
  if (e.key === 'Escape') {
    // Reset form if in new trade
    if ($('#view-newtrade') && !$('#view-newtrade').classList.contains('hidden')) {
      $('#reset-trade').click();
    }
    // Close search results
    if ($('#inst-results')) $('#inst-results').classList.add('hidden');
  }
});

// Admin Dashboard
async function fetchAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-400">Loading accounts...</td></tr>';

  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-red-500">Failed to load users (' + res.status + ')</td></tr>';
      return;
    }
    const data = await res.json();
    if (!data.users || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-400">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.users.forEach(u => {
      const tr = document.createElement('tr');
      // Format uuid to visual short uuid like in check_ownership script
      const shortId = u.id.substring(0, 8) + '...';
      const isSelf = u.username === store.state.username;
      tr.innerHTML = `
        <td class="p-3 text-gray-600 font-mono text-xs">${shortId}</td>
        <td class="p-3 font-medium ${isSelf ? 'text-indigo-600 font-bold' : ''}">${u.username} ${isSelf ? '(You)' : ''}</td>
        <td class="p-3 text-gray-500">${u.trades}</td>
        <td class="p-3 text-gray-500">${u.systems}</td>
        <td class="p-3 space-x-2">
            <button onclick="adminChangePassword('${u.id}', '${u.username}')" class="px-2 py-1 text-xs bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 font-medium">Change Pass</button>
            ${!isSelf ? `<button onclick="adminDeleteUser('${u.id}', '${u.username}')" class="px-2 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 font-medium tracking-wide">Delete</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-red-500">Network error fetching users</td></tr>';
  }
}

async function adminDeleteUser(targetId, targetUsername) {
  if (await showConfirm(`Are you sure you want to permanently delete user "${targetUsername}" and all their data?`)) {
    try {
      const res = await fetch('/api/admin/delete_user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_user_id: targetId })
      });
      if (res.ok) {
        showToast(`User ${targetUsername} deleted.`, 'success');
        fetchAdminUsers();
      } else {
        showToast('Failed to delete user.', 'error');
      }
    } catch (e) {
      showToast('Network error', 'error');
    }
  }
}

async function adminChangePassword(targetId, targetUsername) {
  const newPass = prompt(`Enter new password for user "${targetUsername}":`);
  if (!newPass || newPass.trim() === '') return;

  try {
    const res = await fetch('/api/admin/change_password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_user_id: targetId, new_password: newPass })
    });
    if (res.ok) {
      showToast(`Password for ${targetUsername} updated successfully.`, 'success');
    } else {
      showToast('Failed to update password.', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  }
}

// Start
init();
