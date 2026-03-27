// js/ui.js — UI Rendering & DOM Manipulation
import { store } from './store.js';
import * as Calc from './calc.js';
import * as Charts from './charts.js';

const $ = (s) => document.querySelector(s);

// --- Dashboard ---
export function renderDashboard() {
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

    // Risk Monitor Logic
    renderRiskMonitor(trades);

    // Charts
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

    // Quick Stats
    const win = Calc.computeWinRate(trades);
    const pf = Calc.computeProfitFactor(trades);
    const avg = Calc.computeAvgTrade(trades);

    if ($('#stat-win')) $('#stat-win').textContent = win === null ? '—' : win.toFixed(1) + '%';
    if ($('#stat-pf')) $('#stat-pf').textContent = pf === null ? '—' : pf.toFixed(2);
    if ($('#stat-avg')) $('#stat-avg').textContent = avg === null ? '—' : Calc.money(avg);

    // Systems Table
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
}

function renderRiskMonitor(trades) {
    const exposure = Calc.computeExposure(trades);
    const dailyPnL = Calc.getDailyRealizedPnL(trades);

    if ($('#risk-daily-pnl')) {
        $('#risk-daily-pnl').textContent = Calc.money(dailyPnL);
        // Example Circuit Breaker: -20,000 loss limit
        if (dailyPnL < -20000) {
            $('#risk-daily-pnl').classList.add('text-red-600');
            $('#risk-daily-warning').classList.remove('hidden');
        } else {
            $('#risk-daily-pnl').classList.remove('text-red-600');
            $('#risk-daily-warning').classList.add('hidden');
        }
    }

    if ($('#risk-total-exposure')) $('#risk-total-exposure').textContent = Calc.money(exposure.totalRisk);

    // Find max sector
    let maxSector = { name: 'None', val: 0 };
    for (const [sys, val] of Object.entries(exposure.bySystem)) {
        if (val > maxSector.val) maxSector = { name: sys, val };
    }
    if ($('#risk-max-sector')) $('#risk-max-sector').textContent = `${maxSector.name} (${Calc.money(maxSector.val)})`;
}

// --- Systems Tab ---
export function renderSystems() {
    const tbody = $('#systems-tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    store.state.systems.forEach((s, idx) => {
        const tr = document.createElement('tr');
        const max = s.capital && s.R ? Math.floor(s.capital / s.R) : 0;
        tr.innerHTML = `
      <td class="p-2"><input data-idx="${idx}" data-field="name" class="w-full border p-1 rounded text-sm" value="${s.name}"></td>
      <td><input data-idx="${idx}" data-field="capital" class="w-full border p-1 rounded text-sm" value="${s.capital}"></td>
      <td><input data-idx="${idx}" data-field="R" class="w-full border p-1 rounded text-sm" value="${s.R}"></td>
      <td class="p-2 max-trades-cell">${max}</td>
      <td class="p-2"><button data-idx="${idx}" class="del-system text-red-600">Delete</button></td>
    `;
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
            renderSystems();
        });
    });
}

// --- Instruments Tab ---
export function renderInstruments() {
    const tbody = $('#instruments-tbody'); if (!tbody) return;
    tbody.innerHTML = '';
    store.state.instruments.forEach((it, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td class="p-2"><input data-idx="${idx}" data-field="symbol" class="w-full border p-1 rounded text-sm" value="${it.symbol}"></td>
      <td><input data-idx="${idx}" data-field="lot" class="w-full border p-1 rounded text-sm" value="${it.lot}"></td>
      <td><select data-idx="${idx}" data-field="type" class="w-full border p-1 rounded text-sm"><option ${it.type === 'Futures' ? 'selected' : ''}>Futures</option><option ${it.type === 'Options' ? 'selected' : ''}>Options</option><option ${it.type === 'Stock' ? 'selected' : ''}>Stock</option></select></td>
      <td class="p-2"><button data-idx="${idx}" class="del-instrument text-red-600">Delete</button></td>
    `;
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
            renderInstruments();
        });
    });
}

// --- Trades List Tab ---
export function renderTrades(editCallback) {
    const tbody = $('#trades-tbody'); if (!tbody) return;
    tbody.innerHTML = '';

    const filtSys = $('#filter-system') ? $('#filter-system').value.trim() : '';
    const filtInst = $('#filter-instrument') ? $('#filter-instrument').value.trim().toUpperCase() : '';

    store.state.trades.forEach(t => {
        if (filtSys && t.system !== filtSys) return;
        if (filtInst && !(t.instrument.toUpperCase().includes(filtInst) || (t.tags || []).some(tt => tt.toUpperCase().includes(filtInst)))) return;

        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td class="p-2">${t.date}</td><td>${t.system}</td><td>${t.instrument}</td><td>${t.optionType || ''}</td>
      <td>${t.entry}</td><td>${t.exit}</td><td>${t.final_qty}</td><td>${Calc.money(t.actual_risk)}</td>
      <td>${t.flag}</td><td>${(t.tags || []).join(', ')}</td>
      <td><button class="edit-trade text-blue-600">Edit</button> <button class="del-trade text-red-600">Delete</button></td>
    `;
        tbody.appendChild(tr);

        tr.querySelector('.del-trade').addEventListener('click', () => {
            if (!confirm('Delete?')) return;
            store.removeTrade(t.id);
            renderTrades(editCallback);
        });

        tr.querySelector('.edit-trade').addEventListener('click', () => {
            if (editCallback) editCallback(t);
        });
    });
}

// --- Kanban View ---
export function renderKanban() {
    const { trades } = store.state;
    // Columns
    const cols = {
        watchlist: $('#kanban-watchlist'),
        open: $('#kanban-open'),
        wins: $('#kanban-wins'),
        losses: $('#kanban-losses')
    };
    if (!cols.watchlist) return; // if tab content missing

    // Clear
    Object.values(cols).forEach(c => c.innerHTML = '');

    trades.forEach(t => {
        let col = null;
        // Logic to sort into columns
        if (t.status === 'Open') col = cols.open;
        else if (t.status === 'Closed') {
            if (Number(t.realized_pnl) >= 0) col = cols.wins;
            else col = cols.losses;
        } else {
            // For future use: Pending orders?
            col = cols.watchlist;
        }

        if (!col) return;

        // Render Card
        const card = document.createElement('div');
        const borderColor = (Number(t.realized_pnl) > 0) ? 'border-l-green-500' : (Number(t.realized_pnl) < 0 ? 'border-l-red-500' : 'border-l-blue-500');
        card.className = "p-3 bg-white rounded shadow text-sm border-l-4 mb-2 " + borderColor;

        const centerContent = t.status === 'Closed'
            ? `<div class="mt-1 font-bold ${Number(t.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600'}">${Calc.money(t.realized_pnl)}</div>`
            : `<div class="mt-1 text-blue-600">Risk: ${Calc.money(t.actual_risk)}</div>`;

        card.innerHTML = `
            <div class="font-bold flex justify-between">
                <span>${t.instrument}</span> 
                <span class="text-xs text-gray-500 bg-gray-100 px-1 rounded">${t.system}</span>
            </div>
            <div class="mt-1 text-xs text-gray-500">Qty: ${t.final_qty} • ${t.date}</div>
            ${centerContent}
        `;

        col.appendChild(card);
    });
}

// --- PNL Tab ---
export function renderPNL() {
    const openT = $('#pnl-open');
    const closedT = $('#pnl-closed');
    if (!openT || !closedT) return;

    openT.innerHTML = '';
    closedT.innerHTML = '';

    store.state.trades.forEach(t => {
        if (t.status === 'Open') {
            const tr = document.createElement('tr');
            tr.innerHTML = `
        <td class="p-2">${t.date}</td>
        <td>${t.instrument}${t.strike ? ' ' + t.strike + ' ' + t.optionType : ''}</td>
        <td>${t.entry}</td>
        <td class="qty-cell">${t.final_qty}</td>
        <td><input data-id="${t.id}" class="mark-input border p-1 rounded text-sm" style="width:100px" value="${t.mark_price || ''}"></td>
        <td class="unreal">—</td>
        <td><button data-id="${t.id}" class="close-btn px-2 py-1 rounded text-sm bg-green-600 text-white">Close</button></td>
      `;
            openT.appendChild(tr);

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

            tr.querySelector('.close-btn').addEventListener('click', () => handleCloseTrade(t));
        }
    });

    renderClosedTradesGrouped(closedT);
}

function handleCloseTrade(trade) {
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
    const adjusted = Calc.enforceLotSize(qtyClose, lotSize);

    if (qtyClose !== adjusted && qtyClose < maxQty) { // Only enforce on partials
        if (!confirm(`Adjust qty ${qtyClose} to valid lot multiple ${adjusted}?`)) return;
        qtyClose = adjusted;
    }

    if (qtyClose <= 0 || qtyClose > maxQty) return alert('Invalid qty');

    const realized = (closePrice - trade.entry) * qtyClose;

    if (qtyClose < maxQty) {
        trade.final_qty -= qtyClose;
        trade.qty_rounded = trade.final_qty;
        trade.actual_risk = trade.final_qty * Math.abs(trade.entry - trade.exit);

        const closedObj = {
            ...trade,
            id: 'C' + (store.state.trades.length + 1) + '-' + Date.now().toString().slice(-4),
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
        trade.status = 'Closed';
        trade.parent_id = trade.id;
        trade.close_price = closePrice;
        trade.close_date = Calc.nowDate();
        trade.realized_pnl = realized;
        trade.mark_price = null;
        store.save();
    }

    renderPNL();
}

function renderClosedTradesGrouped(container) {
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

        tr.innerHTML = `
      <td class="p-2">${items.length > 1 ? `<button data-target="${expandId}" class="toggle-grp text-xs bg-gray-200 px-1 rounded">▶</button>` : ''} ${items[items.length - 1].close_date}</td>
      <td>${parent.instrument}</td>
      <td>${parent.entry}</td>
      <td>${weightedExit.toFixed(2)}</td>
      <td>${totalQty}</td>
      <td class="${totalRealized >= 0 ? 'text-green-600' : 'text-red-600'} font-semibold">${Calc.money(totalRealized)}</td>
    `;
        container.appendChild(tr);

        if (items.length > 1) {
            items.forEach(it => {
                const sub = document.createElement('tr');
                sub.classList.add(expandId, 'hidden', 'text-xs', 'text-gray-500', 'bg-white');
                sub.innerHTML = `
            <td></td>
            <td class="pl-4">Partial: ${it.close_date}</td>
            <td>—</td>
            <td>${it.close_price}</td>
            <td>${it.final_qty}</td>
            <td>${Calc.money(it.realized_pnl)}</td>
        `;
                container.appendChild(sub);
            });
        }
    });

    container.querySelectorAll('.toggle-grp').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.target;
            const subs = document.getElementsByClassName(target);
            for (let row of subs) {
                row.classList.toggle('hidden');
            }
            btn.textContent = btn.textContent === '▶' ? '▼' : '▶';
        });
    });
}

// --- Analytics Tab ---
export function renderAnalytics() {
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

    // Chart 2
    const pts = []; let cum = 0;
    const sorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));
    const labels = sorted.map(t => t.date);
    sorted.forEach(t => { const pnl = (t.status === 'Closed') ? Number(t.realized_pnl || 0) : ((Number(t.mark_price || 0) - Number(t.entry || 0)) * Number(t.final_qty || 0)); cum += pnl; pts.push(cum / 100000); });
    if (pts.length === 0) pts.push(0);
    Charts.renderDetailedEquityChart('equityChart2', pts, labels);

    // Tag Analytics
    renderTagAnalytics(trades);
}

export function renderTagAnalytics(trades) {
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
