// js/store.js — State management

const LS_KEY = "risk_engine_pro_v1";

// Initial empty state
const initialState = { systems: [], instruments: [], trades: [] };

export const store = {
    state: { ...initialState },

    load() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                this.state = JSON.parse(raw);
                // Ensure structure integrity merge if keys missing
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

    // Helpers to mutate state
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
        this.state.trades = this.state.trades.filter(t => t.id !== id);
        this.save();
    },

    // Full replace (for backup restore)
    replaceState(newState) {
        this.state = newState;
        this.save();
    }
};
