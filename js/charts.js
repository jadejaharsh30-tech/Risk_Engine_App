// js/charts.js — Chart.js wrappers

let equityChart = null;
let allocChart = null;
let equityChart2 = null;

export function renderEquityChart(canvasId, points) {
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
}

export function renderAllocChart(canvasId, systems) {
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
}

export function renderDetailedEquityChart(canvasId, dataPoints, labels) {
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
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });
}
