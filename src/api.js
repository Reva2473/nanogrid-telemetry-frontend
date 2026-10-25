/**
 * Nanogrid Telemetry API Client & Simulation Engine
 * Handles Supabase REST, local /ingest proxy, and realistic demo generation.
 */

class TelemetryService {
  constructor() {
    this.subscribers = new Set();
    this.pollIntervalMs = 1000;
    this.pollTimer = null;
    this.historyLoadedFromDb = false;

    // Configuration endpoints
    const savedUrl = localStorage.getItem('nanogrid_ingest_url');
    this.supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
    this.supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
    this.ingestUrl = savedUrl || import.meta.env.VITE_INGEST_READ_URL || '/ingest';

    // Track whether each node has received real telemetry
    this.hasReceivedLive = {
      1: false,
      2: false
    };

    // Modes: Live vs Demo Simulation
    const savedMode = localStorage.getItem('nanogrid_mode');
    this.isDemoMode = savedMode ? savedMode === 'demo' : false;
    this.lastSuccessfulLiveFetch = 0;

    // In-memory data store
    this.nodes = {
      1: {
        node_id: 1,
        vbat: 12.65,
        ibat: 0.32,
        vpv: 17.80,
        ipv: 0.45,
        vbus: 12.80,
        ibus: -0.15,
        soc: 82.0,
        pv_ok: true,
        source: 'PV',
        tie: 'EXPORT',
        lockout: false,
        timestamp: new Date().toISOString(),
        local_received_at: Date.now()
      },
      2: {
        node_id: 2,
        vbat: 12.38,
        ibat: -0.24,
        vpv: 4.20,
        ipv: 0.00,
        vbus: 12.80,
        ibus: 0.15,
        soc: 65.0,
        pv_ok: false,
        source: 'Battery',
        tie: 'IMPORT',
        lockout: false,
        timestamp: new Date().toISOString(),
        local_received_at: Date.now()
      }
    };

    // 24h rolling history buffer (downsampled for fast chart rendering)
    this.history = {
      1: [],
      2: []
    };

    // Pre-populate with realistic 24-hour baseline history
    this.seedHistoricalData();
  }

  setIngestUrl(url) {
    this.ingestUrl = url;
    localStorage.setItem('nanogrid_ingest_url', url);
  }

  setDemoMode(enabled) {
    this.isDemoMode = enabled;
    localStorage.setItem('nanogrid_mode', enabled ? 'demo' : 'live');
    this.notify();
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    // Immediate notification of current state
    callback(this.getState());
    return () => this.subscribers.delete(callback);
  }

  notify() {
    const state = this.getState();
    for (const sub of this.subscribers) {
      try {
        sub(state);
      } catch (err) {
        console.error('Error in subscriber callback:', err);
      }
    }
  }

  getState() {
    return {
      nodes: { ...this.nodes },
      history: {
        1: [...this.history[1]],
        2: [...this.history[2]]
      },
      isDemoMode: this.isDemoMode,
      lastSuccessfulLiveFetch: this.lastSuccessfulLiveFetch,
      ingestUrl: this.ingestUrl
    };
  }

  start() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async poll() {
    if (this.isDemoMode) {
      this.stepDemoSimulation();
      this.notify();
      return;
    }

    let liveSuccess = false;

    // 1. Try Supabase REST if credentials are provided
    if (this.supabaseUrl && this.supabaseAnonKey) {
      try {
        liveSuccess = await this.fetchSupabase();
      } catch (err) {
        console.warn('Supabase fetch failed:', err.message);
      }
    }

    // 2. Try Ingest REST / Read endpoint (/functions/v1/ingest or custom URL)
    if (!liveSuccess && this.ingestUrl) {
      try {
        liveSuccess = await this.fetchIngestEndpoint();
      } catch (err) {
        // Backend not running or unreachable
      }
    }

    if (liveSuccess) {
      this.lastSuccessfulLiveFetch = Date.now();
    }

    // In live mode, we only notify subscribers with real data.
    // If no new telemetry arrived, timestamps naturally age so "Delayed" (10s) and "Offline" (30s) trigger properly.
    this.notify();
  }

  async fetchIngestEndpoint() {
    const res = await fetch(this.ingestUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) return false;
    const data = await res.json();
    if (!data) return false;

    let updated = false;

    // Handle array format: { latest: [ { node: 2, ... } ] }
    if (Array.isArray(data.latest)) {
      for (const item of data.latest) {
        const rawNode = item.node ?? item.node_id ?? item.nodeId;
        const nid = parseInt(rawNode, 10) === 2 ? 2 : 1;
        this.applyNodeData(nid, item);
        this.hasReceivedLive[nid] = true;
        updated = true;
      }
    } else if (data.latest && typeof data.latest === 'object') {
      // Handle object format: { latest: { 1: {...}, 2: {...} } }
      for (const key of Object.keys(data.latest)) {
        const item = data.latest[key];
        if (item) {
          const rawNode = item.node ?? item.node_id ?? key;
          const nid = parseInt(rawNode, 10) === 2 ? 2 : 1;
          this.applyNodeData(nid, item);
          this.hasReceivedLive[nid] = true;
          updated = true;
        }
      }
    }

    // Merge server history if present
    if (Array.isArray(data.history) && data.history.length > 0) {
      for (const h of data.history) {
        const rawNode = h.node ?? h.node_id;
        const nid = parseInt(rawNode, 10) === 2 ? 2 : 1;
        const t = new Date(h.received_at || h.timestamp || Date.now()).getTime();
        const exists = this.history[nid].some(e => Math.abs(e.t - t) < 1500);
        if (!exists && !isNaN(t)) {
          this.history[nid].push({
            t,
            vbat: Number(h.vbat),
            soc: Number(h.soc),
            vbus: Number(h.vbus),
            ibat: Number(h.ibat),
            vpv: Number(h.vpv),
            ipv: Number(h.ipv)
          });
        }
      }
      this.history[1].sort((a, b) => a.t - b.t);
      this.history[2].sort((a, b) => a.t - b.t);
    }

    return updated;
  }

  async fetchSupabase() {
    const base = this.supabaseUrl.replace(/\/$/, '');
    const headers = {
      'apikey': this.supabaseAnonKey,
      'Authorization': `Bearer ${this.supabaseAnonKey}`,
      'Accept': 'application/json'
    };

    const latestRes = await fetch(`${base}/rest/v1/node_latest?select=*`, { headers });
    if (!latestRes.ok) return false;

    const latestRecords = await latestRes.json();
    if (!Array.isArray(latestRecords) || latestRecords.length === 0) return false;

    let updated = false;
    for (const r of latestRecords) {
      const nid = r.node === 2 ? 2 : 1;
      this.applyNodeData(nid, r);
      this.hasReceivedLive[nid] = true;
      updated = true;
    }

    // Fetch initial historical baseline once on boot, then let live 1s points append seamlessly
    if (!this.historyLoadedFromDb) {
      try {
        const histRes = await fetch(`${base}/rest/v1/node_history?select=*&order=received_at.asc&limit=500`, { headers });
        if (histRes.ok) {
          const histRecords = await histRes.json();
          this.historyLoadedFromDb = true;
          if (Array.isArray(histRecords) && histRecords.length > 0) {
            const h1 = [];
            const h2 = [];
            for (const h of histRecords) {
              const nid = h.node === 2 ? 2 : 1;
              const t = new Date(h.received_at).getTime();
              const point = {
                t,
                vbat: Number(h.vbat),
                soc: Number(h.soc),
                vbus: Number(h.vbus),
                ibat: Number(h.ibat),
                vpv: Number(h.vpv),
                ipv: Number(h.ipv)
              };
              if (nid === 2) h2.push(point);
              else h1.push(point);
            }
            if (h1.length > 0) this.history[1] = h1;
            if (h2.length > 0) this.history[2] = h2;
          }
        }
      } catch {
        // Non-fatal if history fetch fails
      }
    }

    return updated;
  }

  applyNodeData(nodeId, raw) {
    const vbat = Number(raw.vbat ?? raw.v_bat ?? this.nodes[nodeId].vbat);
    const ibat = Number(raw.ibat ?? raw.i_bat ?? this.nodes[nodeId].ibat);
    const vpv = Number(raw.vpv ?? raw.v_pv ?? this.nodes[nodeId].vpv);
    const ipv = Number(raw.ipv ?? raw.i_pv ?? this.nodes[nodeId].ipv);
    const vbus = Number(raw.vbus ?? raw.v_bus ?? this.nodes[nodeId].vbus);
    const ibus = Number(raw.ibus ?? raw.i_bus ?? this.nodes[nodeId].ibus);

    let soc = raw.soc ?? raw.battery_soc;
    if (soc === undefined || soc === null) {
      soc = Math.max(0, Math.min(100, Math.round(((vbat - 11.0) / (14.2 - 11.0)) * 100 * 10) / 10));
    } else {
      soc = Number(soc);
    }

    const pv_ok = Boolean(raw.pv_ok ?? raw.pvOk ?? (vpv >= 12.0 && ipv >= 0.02));

    let source = raw.src ?? raw.source ?? raw.source_status;
    if (!source) {
      if (pv_ok && ipv > 0.05) source = 'PV';
      else if (vbat >= 11.2) source = 'Battery';
      else source = 'None';
    } else {
      const s = String(source).toUpperCase();
      if (s === 'BATTERY') source = 'Battery';
      else if (s === 'PV') source = 'PV';
      else if (s === 'NONE') source = 'None';
      else source = s;
    }

    let tie = raw.tie ?? raw.tie_status;
    if (!tie) {
      if (ibus < -0.02) tie = 'EXPORT';
      else if (ibus > 0.02) tie = 'IMPORT';
      else tie = 'IDLE';
    } else {
      tie = String(tie).toUpperCase();
    }

    const lockout = Boolean(raw.lockout ?? raw.safety_lockout ?? false);
    const rawTime = raw.received_at || raw.timestamp || raw.created_at;
    const timestamp = rawTime || new Date().toISOString();
    const serverRecTime = rawTime ? new Date(rawTime).getTime() : Date.now();
    const local_received_at = !isNaN(serverRecTime) ? serverRecTime : Date.now();

    const normalized = {
      node_id: nodeId,
      vbat: Number(vbat.toFixed(2)),
      ibat: Number(ibat.toFixed(3)),
      vpv: Number(vpv.toFixed(2)),
      ipv: Number(ipv.toFixed(3)),
      vbus: Number(vbus.toFixed(2)),
      ibus: Number(ibus.toFixed(3)),
      soc: Number(soc.toFixed(1)),
      pv_ok,
      source,
      tie,
      lockout,
      timestamp,
      local_received_at
    };

    this.nodes[nodeId] = normalized;
    this.hasReceivedLive[nodeId] = true;

    // Append to rolling history
    this.appendHistoryPoint(nodeId, normalized);
  }

  appendHistoryPoint(nodeId, item) {
    const t = item.local_received_at || Date.now();
    const arr = this.history[nodeId];
    if (arr.length > 0 && arr[arr.length - 1].t === t) {
      return; // Avoid duplicate entry when polling sees the same timestamp
    }
    arr.push({
      t,
      vbat: item.vbat,
      soc: item.soc,
      vbus: item.vbus,
      ibat: item.ibat,
      vpv: item.vpv,
      ipv: item.ipv
    });

    // Retain up to 2000 points
    if (arr.length > 2000) {
      arr.shift();
    }
  }

  /**
   * Directly post a sample telemetry payload (used by in-app test buttons)
   */
  async postDirectTelemetry(payload) {
    const rawNode = payload.node ?? payload.node_id ?? 1;
    const nid = parseInt(rawNode, 10) === 2 ? 2 : 1;

    const body = {
      node: nid,
      uptime_s: payload.uptime_s ?? 120,
      src: (payload.src ?? payload.source ?? 'PV').toUpperCase(),
      tie: (payload.tie ?? 'EXPORT').toUpperCase(),
      soc: Number(payload.soc ?? 80),
      vbat: Number(payload.vbat ?? 12.6),
      ibat: Number(payload.ibat ?? 0.3),
      vpv: Number(payload.vpv ?? 18.0),
      ipv: Number(payload.ipv ?? 0.5),
      vbus: Number(payload.vbus ?? 12.8),
      ibus: Number(payload.ibus ?? -0.2),
      pv_ok: Boolean(payload.pv_ok ?? true),
      lockout: Boolean(payload.lockout ?? false),
      import_bus_ok: Boolean(payload.import_bus_ok ?? true),
      rssi: Number(payload.rssi ?? -65),
      fw: payload.fw || 'v1.0.0'
    };

    try {
      const res = await fetch(this.ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Key': 'test-device-key-change-me'
        },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        this.applyNodeData(nid, body);
        this.notify();
        return true;
      }
    } catch (err) {
      console.warn('Could not POST to ingest endpoint, applying directly to local state:', err);
      this.applyNodeData(nid, body);
      this.notify();
      return true;
    }
    return false;
  }

  /**
   * Physics-inspired simulation generator for realistic Demo mode
   */
  stepDemoSimulation() {
    const t = Date.now() / 1000;
    const now = Date.now();

    // Node 1: Solar generation active, battery charging, exporting to bus
    if (this.isDemoMode || !this.hasReceivedLive[1]) {
      const n1SolarFlux = Math.sin(t * 0.08) * 0.08 + 0.45;
      const n1Vpv = 17.6 + Math.sin(t * 0.05) * 0.35;
      const n1Ipv = Math.max(0.05, n1SolarFlux);
      const n1Vbat = 12.60 + Math.sin(t * 0.03) * 0.08;
      const n1Ibat = 0.28 + Math.sin(t * 0.06) * 0.06;
      const n1Vbus = 12.80 + Math.sin(t * 0.04) * 0.02;
      const n1Ibus = -0.15 + Math.sin(t * 0.07) * 0.03; // negative = exporting

      this.nodes[1] = {
        node_id: 1,
        vbat: Number(n1Vbat.toFixed(2)),
        ibat: Number(n1Ibat.toFixed(3)),
        vpv: Number(n1Vpv.toFixed(2)),
        ipv: Number(n1Ipv.toFixed(3)),
        vbus: Number(n1Vbus.toFixed(2)),
        ibus: Number(n1Ibus.toFixed(3)),
        soc: Number((82.0 + Math.sin(t * 0.02) * 1.5).toFixed(1)),
        pv_ok: true,
        source: 'PV',
        tie: 'EXPORT',
        lockout: false,
        timestamp: new Date().toISOString(),
        local_received_at: now
      };
      this.appendHistoryPoint(1, this.nodes[1]);
    }

    // Node 2: Shaded / night mode, battery supplying local load, importing from bus
    if (this.isDemoMode || !this.hasReceivedLive[2]) {
      const n2Vbat = 12.38 + Math.sin(t * 0.03 + 2.0) * 0.06;
      const n2Ibat = -0.22 + Math.sin(t * 0.05 + 1.0) * 0.04; // negative = discharging
      const n2Vpv = 4.10 + Math.sin(t * 0.02) * 0.15;
      const n2Ipv = 0.00;
      const n2Vbus = this.nodes[1].vbus;
      const n2Ibus = -this.nodes[1].ibus; // balanced inter-tie transfer (importing ~+0.15A)

      this.nodes[2] = {
        node_id: 2,
        vbat: Number(n2Vbat.toFixed(2)),
        ibat: Number(n2Ibat.toFixed(3)),
        vpv: Number(n2Vpv.toFixed(2)),
        ipv: Number(n2Ipv.toFixed(3)),
        vbus: Number(n2Vbus.toFixed(2)),
        ibus: Number(n2Ibus.toFixed(3)),
        soc: Number((65.0 - Math.sin(t * 0.02) * 1.2).toFixed(1)),
        pv_ok: false,
        source: 'Battery',
        tie: 'IMPORT',
        lockout: false,
        timestamp: new Date().toISOString(),
        local_received_at: now
      };
      this.appendHistoryPoint(2, this.nodes[2]);
    }
  }

  seedHistoricalData() {
    const now = Date.now();
    const points = 72; // 24-hour simulation at 20-minute intervals
    const intervalMs = (24 * 60 * 60 * 1000) / points;

    for (let i = points; i >= 0; i--) {
      const t = now - (i * intervalMs);
      const angle = (t / (24 * 60 * 60 * 1000)) * Math.PI * 2;

      // Diurnal solar wave
      const solarStrength = Math.max(0, Math.sin(angle));

      // Node 1 History
      const n1Vpv = solarStrength > 0.1 ? 17.5 + solarStrength * 0.8 : 3.5;
      const n1Ipv = solarStrength > 0.1 ? solarStrength * 0.55 : 0;
      const n1Vbat = 12.3 + solarStrength * 0.45;
      const n1Ibat = solarStrength > 0.2 ? 0.35 : -0.12;
      const n1Soc = 75 + solarStrength * 18;
      const n1Vbus = 12.80 + Math.sin(angle * 3) * 0.03;
      const n1Ibus = solarStrength > 0.3 ? -0.16 : 0.02;

      this.history[1].push({
        t,
        vbat: Number(n1Vbat.toFixed(2)),
        soc: Number(n1Soc.toFixed(1)),
        vbus: Number(n1Vbus.toFixed(2)),
        ibat: Number(n1Ibat.toFixed(3)),
        vpv: Number(n1Vpv.toFixed(2)),
        ipv: Number(n1Ipv.toFixed(3))
      });

      // Node 2 History
      const n2Vpv = 4.0;
      const n2Ipv = 0.0;
      const n2Vbat = 12.5 - Math.min(0.35, (1 - solarStrength) * 0.25);
      const n2Ibat = solarStrength > 0.3 ? 0.12 : -0.22;
      const n2Soc = 72 - (1 - solarStrength) * 14;
      const n2Vbus = n1Vbus;
      const n2Ibus = -n1Ibus;

      this.history[2].push({
        t,
        vbat: Number(n2Vbat.toFixed(2)),
        soc: Number(n2Soc.toFixed(1)),
        vbus: Number(n2Vbus.toFixed(2)),
        ibat: Number(n2Ibat.toFixed(3)),
        vpv: Number(n2Vpv.toFixed(2)),
        ipv: Number(n2Ipv.toFixed(3))
      });
    }
  }
}

export const telemetryService = new TelemetryService();
