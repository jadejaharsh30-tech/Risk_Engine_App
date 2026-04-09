// js/calc.js — Pure financial logic

export const money = (n) => "₹" + Number(n || 0).toLocaleString();
export const nowDate = () => new Date().toISOString().slice(0, 10);

// --- Trade Math ---
export function calculateRiskQty(R, entry, exit) {
    const riskPerShare = Math.abs(entry - exit);
    if (!riskPerShare) return { riskPerShare: 0, qty: 0 };
    const qty = Math.floor(R / riskPerShare);
    return { riskPerShare, qty };
}

export function enforceLotSize(qty, lot) {
    if (qty <= 0 || lot <= 0) return 0;
    if (qty < lot) return lot; // Minimum 1 lot
    return Math.floor(qty / lot) * lot;
}

// --- Metrics ---
export function computeWinRate(trades) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    const wins = closed.filter(t => Number(t.realized_pnl || 0) >= 0).length;
    return (wins / closed.length) * 100;
}

export function computeProfitFactor(trades) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    const grossProfit = closed.filter(t => t.realized_pnl > 0).reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const grossLoss = Math.abs(closed.filter(t => t.realized_pnl < 0).reduce((a, b) => a + Number(b.realized_pnl || 0), 0));
    if (grossLoss === 0) return grossProfit ? Infinity : null;
    return grossProfit / grossLoss;
}

export function computeAvgTrade(trades) {
    const closed = trades.filter(t => t.status === 'Closed');
    if (!closed.length) return null;
    return closed.reduce((a, b) => a + Number(b.realized_pnl || 0), 0) / closed.length;
}

export function computeAvgRMultiple(trades, systems) {
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
}

export function estimateMaxDrawdown(trades) {
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
}

export function computeSystemMetrics(sys, trades) {
    const openTrades = trades.filter(t => t.system === sys.name && t.status === 'Open');
    const closedTrades = trades.filter(t => t.system === sys.name && t.status === 'Closed');
    const riskInPlay = openTrades.reduce((a, b) => a + Number(b.actual_risk || 0), 0);
    const unrealized = openTrades.reduce((a, b) => {
        const dir = (b.direction === 'Short') ? -1 : 1;
        return a + (dir * (Number(b.mark_price || 0) - Number(b.entry || 0)) * Number(b.final_qty || 0));
    }, 0);
    const realized = closedTrades.reduce((a, b) => a + Number(b.realized_pnl || 0), 0);
    const maxTrades = sys.capital && sys.R ? Math.floor(sys.capital / sys.R) : 0;
    const openCount = openTrades.length;
    const capacityLeft = sys.capital ? Math.max(0, sys.capital - riskInPlay) : 0;
    return { openTrades, closedTrades, riskInPlay, unrealized, realized, maxTrades, openCount, capacityLeft };
}

export function computeExposure(trades) {
    const open = trades.filter(t => t.status === 'Open');
    const totalRisk = open.reduce((a, b) => a + Number(b.actual_risk || 0), 0);

    // Exposure by System
    const bySystem = {};
    open.forEach(t => {
        if (!bySystem[t.system]) bySystem[t.system] = 0;
        bySystem[t.system] += Number(t.actual_risk || 0);
    });

    // Exposure by Type (Futures/Options) determined by instrument type inference or explicit field
    const byType = { Futures: 0, Options: 0 };
    open.forEach(t => {
        const type = t.optionType ? 'Options' : 'Futures'; // heuristic
        byType[type] += Number(t.actual_risk || 0);
    });

    return { totalRisk, bySystem, byType };
}

export function getDailyRealizedPnL(trades) {
    const today = nowDate();
    return trades
        .filter(t => t.status === 'Closed' && t.close_date === today)
        .reduce((sum, t) => sum + Number(t.realized_pnl || 0), 0);
}

export function computeTagAnalytics(trades) {
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
