// app.js — Bundled Risk Engine (Universal Compatibility)

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
    const wins = closed.filter(t => t.realized_pnl > 0).length;
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
      const R = sys ? (sys.R || 0) : 0;
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
    const peakVal = peak || 1;
    return (maxdd / peakVal) * 100;
  },

  computeSystemMetrics(sys, trades) {
    const openTrades = trades.filter(t => t.system === sys.name && t.status === 'Open');
    const closedTrades = trades.filter(t => t.system === sys.name && t.status === 'Closed');
    const riskInPlay = openTrades.reduce((a, b) => a + Number(b.actual_risk || 0), 0);
    const unrealized = openTrades.reduce((a, b) => a + ((Number(b.mark_price || 0) - Number(b.entry || 0)) * Number(b.final_qty || 0)), 0);
    const realized = closedTrades.reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const maxTrades = sys.capital && sys.R ? Math.floor(sys.capital / sys.R) : 0;
    const openCount = openTrades.length;
    const capacityLeft = sys.capital ? Math.max(0, sys.capital - riskInPlay) : 0;
    return { openTrades, closedTrades, riskInPlay, unrealized, realized, maxTrades, openCount, capacityLeft };
  },

  computeExposure(trades) {
    const open = trades.filter(t => t.status === 'Open');
    const totalRisk = open.reduce((a, b) => a + Number(b.actual_risk || 0), 0);
    const bySystem = {};
    open.forEach(t => {
      if (!bySystem[t.system]) bySystem[t.system] = 0;
      bySystem[t.system] += Number(t.actual_risk || 0);
    });
    const byType = { Futures: 0, Options: 0 };
    open.forEach(t => {
      const type = t.optionType ? 'Options' : 'Futures';
      byType[type] += Number(t.actual_risk || 0);
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
// 2. STORE MODULE
// ==========================================
const LS_KEY = "risk_engine_pro_v1";
const initialState = { systems: [], instruments: [], trades: [] };

const store = {
  state: { ...initialState },

  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        this.state = JSON.parse(raw);
        if (!this.state.systems) this.state.systems = [];
        if (!this.state.instruments) this.state.instruments = [];
        if (!this.state.trades) this.state.trades = [];
      } else {
        this.save();
      }
    } catch (e) {
      console.error("Failed to load state", e);
      this.state = { ...initialState };
    }
  },

  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.state));
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

const UI = {
  renderDashboard() {
    const { systems, trades } = store.state;
    // Aggregates
    const totalCapital = systems.reduce((a, b) => a + Number(b.capital || 0), 0);
    const totalRisk = trades.filter(t => t.status === 'Open').reduce((a, b) => a + Number(b.actual_risk || 0), 0);
    const realized = trades.filter(t => t.status === 'Closed').reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const unreal = trades.filter(t => t.status === 'Open').reduce((a, b) => a + ((Number(b.mark_price || 0) - Number(b.entry || 0)) * Number(b.final_qty || 0)), 0);

    if ($('#sum-capital')) $('#sum-capital').textContent = Calc.money(totalCapital);
    if ($('#sum-risk')) $('#sum-risk').textContent = Calc.money(totalRisk);
    if ($('#sum-real')) $('#sum-real').textContent = Calc.money(realized);
    if ($('#sum-unreal')) $('#sum-unreal').textContent = Calc.money(unreal);

    this.renderRiskMonitor(trades);

    Charts.renderAllocChart('allocChart', systems);
    const points = []; let cum = 0;
    const tradesSorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));
    tradesSorted.forEach(t => {
      const pnl = (t.status === 'Closed') ? Number(t.realized_pnl || 0) : ((Number(t.mark_price || 0) - Number(t.entry || 0)) * Number(t.final_qty || 0));
      cum += pnl;
      points.push({ x: t.date, y: Number((cum / 100000).toFixed(2)) });
    });
    if (points.length === 0) points.push({ x: Calc.nowDate(), y: 0 });
    Charts.renderEquityChart('equityChart', points);

    const win = Calc.computeWinRate(trades);
    const pf = Calc.computeProfitFactor(trades);
    const avg = Calc.computeAvgTrade(trades);
    if ($('#stat-win')) $('#stat-win').textContent = win === null ? '—' : win.toFixed(1) + '%';
    if ($('#stat-pf')) $('#stat-pf').textContent = pf === null ? '—' : pf.toFixed(2);
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
      if (dailyPnL < -20000) {
        $('#risk-daily-pnl').classList.add('text-red-600');
        $('#risk-daily-warning').classList.remove('hidden');
      } else {
        $('#risk-daily-pnl').classList.remove('text-red-600');
        $('#risk-daily-warning').classList.add('hidden');
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
      btn.addEventListener('click', () => {
        if (!confirm('Delete system?')) return;
        store.removeSystem(btn.dataset.idx);
        UI.renderSystems();
      });
    });
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
      btn.addEventListener('click', () => {
        if (!confirm('Delete instrument?')) return;
        store.removeInstrument(btn.dataset.idx);
        UI.renderInstruments();
      });
    });
  },

  renderTrades(editCallback, highlightId = null) {
    const tbody = $('#trades-tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    const filtSys = $('#filter-system') ? $('#filter-system').value.trim() : '';
    const filtInst = $('#filter-instrument') ? $('#filter-instrument').value.trim().toUpperCase() : '';

    // Sort reverse chronological
    const sorted = [...store.state.trades].sort((a, b) => new Date(b.date) - new Date(a.date));

    sorted.forEach(t => {
      // HIDE CHILD TRADES
      if (t.parent_id) return;

      if (filtSys && t.system !== filtSys) return;
      if (filtInst && !(t.instrument.toUpperCase().includes(filtInst) || (t.tags || []).some(tt => tt.toUpperCase().includes(filtInst)))) return;

      const tr = document.createElement('tr');
      // Highlight if matches
      if (highlightId && t.id === highlightId) {
        tr.classList.add('bg-blue-100');
        setTimeout(() => tr.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
      }

      tr.innerHTML = `<td class="p-2">${t.date}</td><td class="text-xs text-gray-400">#${t.id.replace('trade_', '')}</td><td>${t.system}</td><td>${t.instrument}</td><td>${t.optionType || ''}</td>
        <td>${t.entry}</td><td>${t.exit}</td><td>${t.final_qty}</td><td>${Calc.money(t.actual_risk)}</td>
        <td>${t.flag}</td><td>${(t.tags || []).join(', ')}</td>
        <td><button class="edit-trade text-blue-600">Edit</button> <button class="del-trade text-red-600">Delete</button></td>`;
      tbody.appendChild(tr);
      tr.querySelector('.del-trade').addEventListener('click', () => {
        if (!confirm('Delete?')) return;
        store.removeTrade(t.id);
        UI.renderTrades(editCallback);
      });
      tr.querySelector('.edit-trade').addEventListener('click', () => {
        if (editCallback) editCallback(t);
      });
    });
  },

  renderKanban() {
    const { trades } = store.state;
    const cols = { watchlist: $('#kanban-watchlist'), open: $('#kanban-open'), wins: $('#kanban-wins'), losses: $('#kanban-losses') };
    if (!cols.watchlist) return;
    Object.values(cols).forEach(c => c.innerHTML = '');
    trades.forEach(t => {
      let col = null;
      if (t.status === 'Open') col = cols.open;
      else if (t.status === 'Closed') {
        if (Number(t.realized_pnl) >= 0) col = cols.wins;
        else col = cols.losses;
      } else { col = cols.watchlist; }
      if (!col) return;
      const card = document.createElement('div');
      const borderColor = (Number(t.realized_pnl) > 0) ? 'border-l-green-500' : (Number(t.realized_pnl) < 0 ? 'border-l-red-500' : 'border-l-blue-500');
      card.className = "p-3 bg-white rounded shadow text-sm border-l-4 mb-2 cursor-pointer " + borderColor;
      const centerContent = t.status === 'Closed' ? `<div class="mt-1 font-bold ${Number(t.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600'}">${Calc.money(t.realized_pnl)}</div>` : `<div class="mt-1 text-blue-600">Risk: ${Calc.money(t.actual_risk)}</div>`;
      card.innerHTML = `<div class="font-bold flex justify-between"><span>${t.instrument}</span> <span class="text-xs text-gray-500 bg-gray-100 px-1 rounded">${t.system}</span></div><div class="mt-1 text-xs text-gray-500">Qty: ${t.final_qty} • ${t.date}</div>${centerContent}`;

      // Make Kanban card clickable to edit
      card.onclick = () => {
        $('.tab-btn[data-tab="trades"]').click();
        setTimeout(() => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }, t.parent_id || t.id), 50);
      };

      col.appendChild(card);
    });
  },

  renderPNL() {
    const openT = $('#pnl-open'); const closedT = $('#pnl-closed');
    if (!openT || !closedT) return;
    openT.innerHTML = ''; closedT.innerHTML = '';
    store.state.trades.forEach(t => {
      if (t.status === 'Open') {
        const tr = document.createElement('tr');
        // Add Link Button
        const linkBtn = `<button class="jump-btn ml-2 text-xs text-blue-500 hover:text-blue-700" title="View in Trades">↗</button>`;

        tr.innerHTML = `<td class="p-2">${t.date}</td>
        <td>${t.instrument}${t.strike ? ' ' + t.strike + ' ' + t.optionType : ''} ${linkBtn}</td>
        <td>${t.entry}</td><td class="qty-cell">${t.final_qty}</td><td><input data-id="${t.id}" class="mark-input border p-1 rounded text-sm" style="width:100px" value="${t.mark_price || ''}"></td><td class="unreal">—</td><td><button data-id="${t.id}" class="close-btn px-2 py-1 rounded text-sm bg-green-600 text-white">Close</button></td>`;
        openT.appendChild(tr);

        tr.querySelector('.jump-btn').addEventListener('click', () => {
          // Go to trades tab
          const masterId = t.parent_id || t.id;
          $('.tab-btn[data-tab="trades"]').click();
          // Re-render with highlight (timeout to allow tab switch?)
          // actually the click listener on tab renders trades immediately.
          // WE need to override it or set a flag.
          // Easier: Call renderTrades properly after the click.
          setTimeout(() => UI.renderTrades((trd) => { editingTradeId = trd.id; $('.tab-btn[data-tab="newtrade"]').click(); fillTradeForm(trd); }, masterId), 50);
        });

        const markInput = tr.querySelector('.mark-input');
        const unrealCell = tr.querySelector('.unreal');
        if (t.mark_price) {
          const pnl = (Number(t.mark_price) - Number(t.entry)) * Number(t.final_qty);
          unrealCell.textContent = Calc.money(pnl);
        }
        markInput.addEventListener('input', (e) => {
          const id = e.target.dataset.id;
          const tglass = store.state.trades.find(x => x.id === id);
          if (!tglass) return;
          const raw = e.target.value;
          const parsed = Number(raw || 0);
          tglass.mark_price = parsed;
          const pnl = (parsed - Number(tglass.entry || 0)) * Number(tglass.final_qty || 0);
          unrealCell.textContent = (raw.trim() === '') ? '—' : Calc.money(pnl);
          store.save();
        });
        tr.querySelector('.close-btn').addEventListener('click', () => UI.handleCloseTrade(t));
      }
    });
    this.renderClosedTradesGrouped(closedT);
  },

  handleCloseTrade(trade) {
    const closePriceStr = prompt('Enter close price for ' + trade.instrument + ':', trade.entry);
    if (closePriceStr === null) return;
    const closePrice = Number(closePriceStr);
    if (isNaN(closePrice)) return alert('Invalid price');
    const maxQty = trade.final_qty;
    const qtyStr = prompt('Enter qty to close (max ' + maxQty + '):', String(maxQty));
    if (qtyStr === null) return;
    let qtyClose = Number(qtyStr);

    const instObj = store.state.instruments.find(x => x.symbol === trade.instrument);
    const lotSize = instObj ? Number(instObj.lot || 1) : 1;

    // Default round down for close, or just strict? Let's use standard lot enforcement (Floor) for safety on partials
    const adjusted = Calc.enforceLotSize(qtyClose, lotSize, 'down');

    if (qtyClose !== adjusted && qtyClose < maxQty) {
      if (!confirm(`Adjust qty ${qtyClose} to valid lot multiple ${adjusted}?`)) return;
      qtyClose = adjusted;
    }
    if (qtyClose <= 0 || qtyClose > maxQty) return alert('Invalid qty');
    const realized = (closePrice - trade.entry) * qtyClose;

    if (qtyClose < maxQty) {
      // PARTIAL CLOSE
      trade.final_qty -= qtyClose;
      trade.qty_rounded = trade.final_qty;
      trade.actual_risk = trade.final_qty * Math.abs(trade.entry - trade.exit);

      // Determine Child ID index
      // Find all children of this trade
      const siblings = store.state.trades.filter(x => x.parent_id === trade.id);
      const suffix = siblings.length + 1;
      const childId = trade.id + '.' + suffix;

      const closedObj = {
        ...trade,
        id: childId,
        parent_id: trade.id,
        final_qty: qtyClose,
        qty_rounded: qtyClose,
        actual_risk: Math.abs(trade.entry - trade.exit) * qtyClose,
        status: 'Closed',
        close_price: closePrice,
        close_date: Calc.nowDate(),
        realized_pnl: realized,
        notes: (trade.notes || '') + ' (partial close)',
        mark_price: null
      };

      store.addTrade(closedObj);
    } else {
      // FULL CLOSE
      trade.status = 'Closed';
      // trade.parent_id = trade.id; // NO! Keep original ID if it's the parent closing itself. Structure update: Only truly partial splits get new rows? 
      // Wait, if we close the parent fully, it just becomes status=Closed. It stays as the main row.
      // If user wants to see it in "Closed" section grouped, we handle that in renderClosedTradesGrouped.
      trade.close_price = closePrice;
      trade.close_date = Calc.nowDate();
      trade.realized_pnl = realized;
      trade.mark_price = null;
      store.save();
    }
    UI.renderPNL();
  },

  renderClosedTradesGrouped(container) {
    const closed = store.state.trades.filter(x => x.status === 'Closed');
    closed.forEach(c => {
      if (!c.parent_id) {
        const parent = store.state.trades.find(t => t.id !== c.id && t.instrument === c.instrument && t.entry === c.entry && t.system === c.system);
        if (parent) c.parent_id = parent.id;
      }
    });
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
      const weightedExit = totalQty ? (items.reduce((s, i) => s + (i.close_price * i.final_qty), 0) / totalQty) : 0;
      const tr = document.createElement('tr');
      tr.classList.add('bg-gray-50', 'border-b');
      const expandId = 'grp-' + key.replace(/[^a-zA-Z0-9]/g, '');
      tr.innerHTML = `<td class="p-2">${items.length > 1 ? `<button data-target="${expandId}" class="toggle-grp text-xs bg-gray-200 px-1 rounded">▶</button>` : ''} ${items[items.length - 1].close_date}</td><td>${parent.instrument}</td><td>${parent.entry}</td><td>${weightedExit.toFixed(2)}</td><td>${totalQty}</td><td class="${totalRealized >= 0 ? 'text-green-600' : 'text-red-600'} font-semibold">${Calc.money(totalRealized)}</td>`;
      container.appendChild(tr);
      if (items.length > 1) {
        items.forEach(it => {
          const sub = document.createElement('tr');
          sub.classList.add(expandId, 'hidden', 'text-xs', 'text-gray-500', 'bg-white');
          sub.innerHTML = `<td></td><td class="pl-4">Partial: ${it.close_date}</td><td>—</td><td>${it.close_price}</td><td>${it.final_qty}</td><td>${Calc.money(it.realized_pnl)}</td>`;
          container.appendChild(sub);
        });
      }
    });
    container.querySelectorAll('.toggle-grp').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        const subs = document.getElementsByClassName(target);
        for (let row of subs) { row.classList.toggle('hidden'); }
        btn.textContent = btn.textContent === '▶' ? '▼' : '▶';
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
    if ($('#analytic-pf')) $('#analytic-pf').textContent = pf === null ? '—' : pf.toFixed(2);
    if ($('#analytic-rmul')) $('#analytic-rmul').textContent = rm === null ? '—' : rm.toFixed(2);
    if ($('#analytic-avgp')) $('#analytic-avgp').textContent = avg === null ? '—' : Calc.money(avg);
    if ($('#analytic-draw')) $('#analytic-draw').textContent = draw === null ? '—' : (draw.toFixed(1) + '%');
    if ($('#analytic-total')) $('#analytic-total').textContent = trades.length;

    const pts = []; let cum = 0;
    const sorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));
    const labels = sorted.map(t => t.date);
    sorted.forEach(t => { const pnl = (t.status === 'Closed') ? Number(t.realized_pnl || 0) : ((Number(t.mark_price || 0) - Number(t.entry || 0)) * Number(t.final_qty || 0)); cum += pnl; pts.push(cum / 100000); });
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
      alert('Synced to Sheet!');
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
    if (!confirm('This will OVERWRITE all local data. Continue?')) return;

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
      alert('Data Imported!');

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

function init() {
  store.load();
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
  const dl = $('#inst-list');
  if (dl) {
    dl.innerHTML = '';
    store.state.instruments.forEach(i => {
      const o = document.createElement('option');
      o.value = i.symbol;
      dl.appendChild(o);
    });
  }
  if ($('#nt-date') && !$('#nt-date').value) $('#nt-date').value = Calc.nowDate();
  const ids = ['nt-system', 'nt-entry', 'nt-exit', 'nt-instrument', 'nt-lot', 'nt-strike', 'nt-optiontype', 'nt-tags', 'nt-round-mode'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.oninput = updateTradeCalc;
  });
  if ($('#prefill-lot')) $('#prefill-lot').onclick = () => {
    const sym = $('#nt-instrument').value.trim();
    const it = store.state.instruments.find(x => x.symbol === sym);
    if (it) { $('#nt-lot').value = it.lot; updateTradeCalc(); }
    else alert('Instrument not found');
  };
  const instInput = $('#nt-instrument');
  if (instInput) {
    instInput.oninput = () => {
      const sym = instInput.value.trim();
      const it = store.state.instruments.find(x => x.symbol === sym);
      if (it && it.type === 'Options') {
        $('#option-fields').classList.remove('hidden');
        $('#option-type-field').classList.remove('hidden');
      } else {
        $('#option-fields').classList.add('hidden');
        $('#option-type-field').classList.add('hidden');
      }
      if (it) $('#nt-lot').value = it.lot;
      updateTradeCalc();
    }
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
  const mode = $('#nt-round-mode') ? $('#nt-round-mode').value : 'down';

  const { riskPerShare, qty } = Calc.calculateRiskQty(R, entry, exit);
  $('#calc-riskqty').textContent = riskPerShare || '—';
  $('#calc-qtyrisk').textContent = qty || '—';
  let qtyrounded = '—';
  let finalqty = '—';
  if (qty > 0 && lot > 0) {
    // USE NEW ROUNDING LOGIC
    qtyrounded = Calc.enforceLotSize(qty, lot, mode);
    finalqty = qtyrounded;
  }
  $('#calc-qtyrounded').textContent = qtyrounded;
  $('#calc-finalqty').textContent = finalqty;
  const actualRisk = (finalqty !== '—' && riskPerShare) ? (finalqty * riskPerShare) : '—';
  $('#calc-actual').textContent = actualRisk === '—' ? '—' : Calc.money(actualRisk);
  const totalBuy = (finalqty !== '—' && entry) ? (finalqty * entry) : '—';
  $('#calc-totalbuy').textContent = totalBuy === '—' ? '—' : Calc.money(totalBuy);
}

function saveTrade() {
  const sysName = $('#nt-system').value;
  if (!sysName) return alert('Select System');
  const inst = $('#nt-instrument').value.trim();
  const entry = Number($('#nt-entry').value);
  const exit = Number($('#nt-exit').value);
  const lot = Number($('#nt-lot').value || 1);
  const mode = $('#nt-round-mode') ? $('#nt-round-mode').value : 'down';

  const sys = store.state.systems.find(s => s.name === sysName);
  const R = sys ? Number(sys.R) : 0;
  const { riskPerShare, qty } = Calc.calculateRiskQty(R, entry, exit);
  let final_qty = 0;

  if (qty > 0 && lot > 0) {
    final_qty = Calc.enforceLotSize(qty, lot, mode);
  } else {
    if (!confirm('Risk qty 0. Use lot?')) return;
    final_qty = lot;
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

  const tradeObj = {
    id: newId,
    date: $('#nt-date').value || Calc.nowDate(),
    system: sysName,
    instrument: inst,
    strike: $('#nt-strike').value ? Number($('#nt-strike').value) : null,
    optionType: $('#nt-optiontype').value || null,
    entry, exit, lot,
    qty_risk: qty, final_qty, qty_rounded: final_qty, actual_risk, leverage,
    flag: leverage > 1 ? 'Over risk' : 'OK',
    tags: $('#nt-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    notes: '', status: 'Open', close_price: null, close_date: null, realized_pnl: null, mark_price: null
  };
  if (editingTradeId) store.updateTrade(tradeObj);
  else store.addTrade(tradeObj);
  if (!store.state.instruments.find(x => x.symbol === inst)) {
    if (confirm('Add new instrument to master?')) {
      store.addInstrument({ symbol: inst, lot, type: tradeObj.optionType ? 'Options' : 'Futures' });
    }
  }
  alert('Saved');
  resetForm();
  editingTradeId = null;
  UI.renderDashboard();
}

function resetForm() {
  editingTradeId = null;
  ['nt-entry', 'nt-exit', 'nt-instrument', 'nt-lot', 'nt-strike', 'nt-optiontype', 'nt-tags'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  $('#nt-system').value = '';
  updateTradeCalc();
}

function setupGlobalListeners() {
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
        alert('Restored');
      } catch (e) { alert('Invalid File'); }
    };
    r.readAsText(f);
  };
  if ($('#btn-clear')) $('#btn-clear').onclick = () => {
    if (confirm('Delete All Data?')) {
      store.replaceState({ systems: [], instruments: [], trades: [] });
      renderAll();
    }
  };

  // FIX: Missing Listeners for Adding
  if ($('#add-system')) $('#add-system').onclick = () => {
    store.addSystem({ name: 'System ' + (store.state.systems.length + 1), capital: 100000, R: 1000 });
    UI.renderSystems();
  };
  if ($('#add-instrument')) $('#add-instrument').onclick = () => {
    store.addInstrument({ symbol: 'New_Inst', lot: 1, type: 'Futures' });
    UI.renderInstruments();
  };
}

// Start
init();
