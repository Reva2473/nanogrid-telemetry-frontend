import { telemetryService } from './api.js';
import { TelemetryChart, renderSvgSparkline } from './charts.js';

// Application State
let activeTab = 'live';
let activeNodeFilter = 'all';
let activeTimeRange = '15m';

// Chart instances
let chartVbat = null;
let chartSoc = null;
let chartVbus = null;
let chartIbat = null;

document.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initMobileSwitcher();
  initCharts();
  initApiModal();
  initTicker();

  // Start telemetry polling
  telemetryService.subscribe(onTelemetryUpdate);
  telemetryService.start();
});

/**
 * Top & Bottom Tab Navigation
 */
function initNavigation() {
  const tabs = [
    { btnDesktop: 'desktopTabLive', btnMobile: 'mobileTabLive', screenId: 'screenLive', name: 'live' },
    { btnDesktop: 'desktopTabCharts', btnMobile: 'mobileTabCharts', screenId: 'screenCharts', name: 'charts' },
  ];

  function switchTab(tabName) {
    activeTab = tabName;
    tabs.forEach(t => {
      const isCurrent = t.name === tabName;
      const elDesktop = document.getElementById(t.btnDesktop);
      const elMobile = document.getElementById(t.btnMobile);
      const screenEl = document.getElementById(t.screenId);

      if (elDesktop) elDesktop.classList.toggle('active', isCurrent);
      if (elMobile) elMobile.classList.toggle('active', isCurrent);
      if (screenEl) screenEl.classList.toggle('active', isCurrent);
    });

    if (tabName === 'charts') {
      setTimeout(() => {
        chartVbat?.initCanvasSize();
        chartSoc?.initCanvasSize();
        chartVbus?.initCanvasSize();
        chartIbat?.initCanvasSize();
        updateChartsData(telemetryService.getState());
      }, 50);
    }
  }

  tabs.forEach(t => {
    document.getElementById(t.btnDesktop)?.addEventListener('click', () => switchTab(t.name));
    document.getElementById(t.btnMobile)?.addEventListener('click', () => switchTab(t.name));
  });

  // Time range selector
  const rangeChips = document.querySelectorAll('.range-chip');
  rangeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      rangeChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeTimeRange = chip.getAttribute('data-range') || '15m';
      
      chartVbat?.setTimeRange(activeTimeRange);
      chartSoc?.setTimeRange(activeTimeRange);
      chartVbus?.setTimeRange(activeTimeRange);
      chartIbat?.setTimeRange(activeTimeRange);
    });
  });
}

/**
 * Mobile Node Filter Switcher
 */
function initMobileSwitcher() {
  const chips = document.querySelectorAll('.node-switch-chip');
  const card1 = document.getElementById('cardNode1');
  const card2 = document.getElementById('cardNode2');

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeNodeFilter = chip.getAttribute('data-node-filter');

      if (activeNodeFilter === '1') {
        if (card1) card1.style.display = 'block';
        if (card2) card2.style.display = 'none';
      } else if (activeNodeFilter === '2') {
        if (card1) card1.style.display = 'none';
        if (card2) card2.style.display = 'block';
      } else {
        if (card1) card1.style.display = 'block';
        if (card2) card2.style.display = 'block';
      }
    });
  });
}

/**
 * Initialize 4 High-DPI Canvas Charts
 */
function initCharts() {
  chartVbat = new TelemetryChart('chartCanvasVbat', 'tooltipVbat', {
    metricKey: 'vbat',
    unit: 'V',
    colorNode1: '#22D3EE',
    colorNode2: '#A78BFA',
    timeRange: activeTimeRange,
    decimals: 2
  });

  chartSoc = new TelemetryChart('chartCanvasSoc', 'tooltipSoc', {
    metricKey: 'soc',
    unit: '%',
    colorNode1: '#10B981',
    colorNode2: '#F59E0B',
    timeRange: activeTimeRange,
    decimals: 1
  });

  chartVbus = new TelemetryChart('chartCanvasVbus', 'tooltipVbus', {
    metricKey: 'vbus',
    unit: 'V',
    colorNode1: '#8B5CF6',
    colorNode2: '#38BDF8',
    timeRange: activeTimeRange,
    decimals: 2
  });

  chartIbat = new TelemetryChart('chartCanvasIbat', 'tooltipIbat', {
    metricKey: 'ibat',
    unit: 'A',
    colorNode1: '#3B82F6',
    colorNode2: '#EC4899',
    timeRange: activeTimeRange,
    decimals: 3
  });
}

/**
 * Main Telemetry Update Callback
 */
function onTelemetryUpdate(state) {
  const { nodes, history, isDemoMode } = state;

  // 1. Update Mode Toggle Button in Header
  const modeBtn = document.getElementById('modeToggleBtn');
  const modeText = document.getElementById('modeLabelText');
  if (modeBtn && modeText) {
    if (isDemoMode) {
      modeBtn.classList.add('mode-demo');
      modeText.textContent = 'Demo Simulation';
    } else {
      modeBtn.classList.remove('mode-demo');
      modeText.textContent = 'Live Backend';
    }
  }

  // 2. Render Node 1 and Node 2 Cards
  renderNodeCard(1, nodes[1], history[1]);
  renderNodeCard(2, nodes[2], history[2]);

  // 3. Render Combined Shared Inter-Tie Bus Panel
  renderCombinedBusPanel(nodes[1], nodes[2]);

  // 4. Update Overall System Status Pill
  updateSystemStatusPill(nodes[1], nodes[2]);

  // 5. Update Charts
  if (activeTab === 'charts') {
    updateChartsData(state);
  }
}

/**
 * Render Individual Node Card
 */
function renderNodeCard(nodeId, data, historyList) {
  if (!data) return;
  const prefix = `node${nodeId}`;
  const cardEl = document.getElementById(`cardNode${nodeId}`);
  if (!cardEl) return;

  const now = Date.now();
  const ageSeconds = Math.max(0, Math.round((now - (data.local_received_at || now)) / 1000));

  // Freshness & Dimming States
  const freshnessText = document.getElementById(`${prefix}Freshness`);
  const freshnessBadge = document.getElementById(`${prefix}FreshnessBadge`);
  const offlineBanner = document.getElementById(`${prefix}OfflineBanner`);

  if (freshnessText) {
    freshnessText.textContent = `Updated ${ageSeconds}s ago`;
  }

  if (ageSeconds > 30) {
    cardEl.classList.remove('node-delayed');
    cardEl.classList.add('node-offline');
    if (freshnessBadge) {
      freshnessBadge.className = 'freshness-badge badge-offline';
      freshnessBadge.textContent = 'Offline';
    }
    if (offlineBanner) offlineBanner.style.display = 'flex';
  } else if (ageSeconds > 10) {
    cardEl.classList.remove('node-offline');
    cardEl.classList.add('node-delayed');
    if (freshnessBadge) {
      freshnessBadge.className = 'freshness-badge badge-delayed';
      freshnessBadge.textContent = 'Delayed';
    }
    if (offlineBanner) offlineBanner.style.display = 'none';
  } else {
    cardEl.classList.remove('node-delayed', 'node-offline');
    if (freshnessBadge) {
      freshnessBadge.className = 'freshness-badge badge-live';
      freshnessBadge.textContent = 'Live';
    }
    if (offlineBanner) offlineBanner.style.display = 'none';
  }

  // Safety Lockout Banner
  const lockoutBanner = document.getElementById(`${prefix}LockoutBanner`);
  if (lockoutBanner) {
    lockoutBanner.style.display = data.lockout ? 'flex' : 'none';
  }

  // Amber Current Limit Warning Banner: |ibat| > 0.6 || |ipv| > 0.6 || |ibus| > 0.6
  const currentWarningBanner = document.getElementById(`${prefix}CurrentWarning`);
  const isHighCurrent = Math.abs(data.ibat) > 0.6 || Math.abs(data.ipv) > 0.6 || Math.abs(data.ibus) > 0.6;
  if (currentWarningBanner) {
    currentWarningBanner.style.display = isHighCurrent ? 'flex' : 'none';
  }

  // Amber Battery Voltage Warning Banner: vbat < 11.0 || vbat > 14.6
  const voltageWarningBanner = document.getElementById(`${prefix}VoltageWarning`);
  const voltageWarningText = document.getElementById(`${prefix}VoltageWarningText`);
  const isVoltageWarning = data.vbat < 11.0 || data.vbat > 14.6;
  if (voltageWarningBanner) {
    voltageWarningBanner.style.display = isVoltageWarning ? 'flex' : 'none';
    if (voltageWarningText && isVoltageWarning) {
      voltageWarningText.textContent = `Battery voltage warning (${data.vbat.toFixed(2)} V outside 11.0–14.6 V)`;
    }
  }

  // Status Strip (3 Pills)
  // 1. Local Source
  const chipSource = document.getElementById(`${prefix}ChipSource`);
  const textSource = document.getElementById(`${prefix}TextSource`);
  if (textSource) {
    const src = data.source || (data.pv_ok ? 'PV' : 'Battery');
    textSource.textContent = `Source: ${src}`;
    const dot = chipSource?.querySelector('.chip-dot');
    if (dot) {
      dot.className = `chip-dot ${src === 'PV' ? 'dot-cyan' : src === 'Battery' ? 'dot-green' : 'dot-muted'}`;
    }
  }

  // 2. Tie Status
  const chipTie = document.getElementById(`${prefix}ChipTie`);
  const textTie = document.getElementById(`${prefix}TextTie`);
  if (textTie) {
    let tieLabel = 'Tie: Idle';
    let tieDot = 'dot-muted';
    if (data.ibus < -0.02 || data.tie === 'EXPORT') {
      tieLabel = 'Tie: Exporting';
      tieDot = 'dot-blue';
    } else if (data.ibus > 0.02 || data.tie === 'IMPORT') {
      tieLabel = 'Tie: Importing';
      tieDot = 'dot-violet';
    }
    textTie.textContent = tieLabel;
    const dot = chipTie?.querySelector('.chip-dot');
    if (dot) dot.className = `chip-dot ${tieDot}`;
  }

  // 3. PV Health
  const chipPv = document.getElementById(`${prefix}ChipPv`);
  const textPv = document.getElementById(`${prefix}TextPv`);
  if (textPv) {
    const isOk = Boolean(data.pv_ok && data.vpv >= 12.0);
    textPv.textContent = isOk ? 'PV Rail OK' : 'PV Rail Low';
    const dot = chipPv?.querySelector('.chip-dot');
    if (dot) dot.className = `chip-dot ${isOk ? 'dot-green' : 'dot-amber'}`;
  }

  // Battery Block + Circular SVG SOC Ring
  const socRing = document.getElementById(`${prefix}SocRing`);
  const socValue = document.getElementById(`${prefix}SocValue`);
  const batState = document.getElementById(`${prefix}BatState`);
  const vbatEl = document.getElementById(`${prefix}Vbat`);
  const ibatEl = document.getElementById(`${prefix}Ibat`);
  const batPowerEl = document.getElementById(`${prefix}BatPower`);

  const soc = Math.max(0, Math.min(100, data.soc));
  if (socValue) socValue.textContent = `${Math.round(soc)}%`;

  // Stroke Dasharray: 2 * PI * 45 ≈ 282.743
  const circumference = 282.743;
  const offset = circumference - (soc / 100) * circumference;
  if (socRing) {
    socRing.style.strokeDasharray = circumference.toString();
    socRing.style.strokeDashoffset = offset.toString();
    // Color thresholds: > 40% green, 20-40% amber, < 20% red
    if (soc > 40) {
      socRing.style.stroke = '#10B981';
    } else if (soc >= 20) {
      socRing.style.stroke = '#F59E0B';
    } else {
      socRing.style.stroke = '#EF4444';
    }
  }

  if (vbatEl) vbatEl.textContent = `${data.vbat.toFixed(2)} V`;
  if (ibatEl) {
    const sign = data.ibat > 0 ? '+' : '';
    ibatEl.textContent = `${sign}${data.ibat.toFixed(2)} A`;
  }
  if (batPowerEl) {
    const pBat = Math.abs(data.vbat * data.ibat);
    batPowerEl.textContent = `${pBat.toFixed(2)} W`;
  }

  // Battery State Badge
  if (batState) {
    if (data.ibat > 0.02) {
      batState.className = 'block-state-badge badge-green';
      batState.textContent = 'Charging';
    } else if (data.ibat < -0.02) {
      batState.className = 'block-state-badge badge-amber';
      batState.textContent = 'Discharging';
    } else {
      batState.className = 'block-state-badge badge-muted';
      batState.textContent = 'Idle';
    }
  }

  // PV Block (After Converter)
  const vpvEl = document.getElementById(`${prefix}Vpv`);
  const ipvEl = document.getElementById(`${prefix}Ipv`);
  const pvPowerEl = document.getElementById(`${prefix}PvPower`);
  const pvHealthEl = document.getElementById(`${prefix}PvHealth`);

  if (vpvEl) vpvEl.textContent = `${data.vpv.toFixed(2)} V`;
  if (ipvEl) ipvEl.textContent = `${data.ipv.toFixed(2)} A`;
  if (pvPowerEl) {
    const pPv = data.vpv * data.ipv;
    pvPowerEl.textContent = `${pPv.toFixed(2)} W`;
  }
  if (pvHealthEl) {
    const isPvHealthy = Boolean(data.pv_ok && data.vpv >= 12.0);
    pvHealthEl.className = `block-state-badge ${isPvHealthy ? 'badge-cyan' : 'badge-amber'}`;
    pvHealthEl.textContent = isPvHealthy ? 'Healthy' : 'Inactive';
  }

  // Shared Bus Block
  const vbusEl = document.getElementById(`${prefix}Vbus`);
  const ibusEl = document.getElementById(`${prefix}Ibus`);
  const busPowerEl = document.getElementById(`${prefix}BusPower`);
  const busPhraseEl = document.getElementById(`${prefix}BusTransferPhrase`);

  if (vbusEl) vbusEl.textContent = `${data.vbus.toFixed(2)} V`;
  if (ibusEl) {
    const sign = data.ibus > 0 ? '+' : '';
    ibusEl.textContent = `${sign}${data.ibus.toFixed(2)} A`;
  }

  const busWattage = Math.abs(data.vbus * data.ibus);
  if (busPowerEl) {
    busPowerEl.textContent = `${busWattage.toFixed(2)} W`;
  }

  if (busPhraseEl) {
    if (data.ibus < -0.02 || data.tie === 'EXPORT') {
      busPhraseEl.className = 'block-state-badge badge-blue';
      busPhraseEl.textContent = `Exporting ${busWattage.toFixed(2)} W`;
    } else if (data.ibus > 0.02 || data.tie === 'IMPORT') {
      busPhraseEl.className = 'block-state-badge badge-violet';
      busPhraseEl.textContent = `Importing ${busWattage.toFixed(2)} W`;
    } else {
      busPhraseEl.className = 'block-state-badge badge-muted';
      busPhraseEl.textContent = 'Idle (0.00 W)';
    }
  }

  // Per-Node Energy Flow Diagram (Inline SVG active paths)
  renderNodeFlowDiagram(nodeId, data);

  // Sparklines
  if (historyList && historyList.length > 2) {
    const batHistory = historyList.slice(-20).map(p => p.vbat);
    const pvHistory = historyList.slice(-20).map(p => p.vpv * p.ipv);
    const busHistory = historyList.slice(-20).map(p => p.vbus);

    renderSvgSparkline(document.getElementById(`${prefix}BatSparkline`), batHistory, '#10B981');
    renderSvgSparkline(document.getElementById(`${prefix}PvSparkline`), pvHistory, '#22D3EE');
    renderSvgSparkline(document.getElementById(`${prefix}BusSparkline`), busHistory, '#8B5CF6');
  }
}

/**
 * Animate Per-Node Energy Flow SVG
 */
function renderNodeFlowDiagram(nodeId, data) {
  const nKey = `n${nodeId}`;
  const pvLine = document.getElementById(`${nKey}PvFlowLine`);
  const batLine = document.getElementById(`${nKey}BatFlowLine`);
  const tieLine = document.getElementById(`${nKey}TieFlowLine`);

  // 1. PV Path (PV -> Local Bus)
  // Active when ipv > 0.02
  if (pvLine) {
    if (data.ipv > 0.02) {
      pvLine.classList.remove('flow-active-reverse');
      pvLine.classList.add('flow-active-forward');
    } else {
      pvLine.classList.remove('flow-active-forward', 'flow-active-reverse');
    }
  }

  // 2. Battery Path (Local Bus <-> Battery)
  // Active when |ibat| > 0.02
  // If ibat > 0.02: Local Bus -> Battery (charging: forward)
  // If ibat < -0.02: Battery -> Local Bus (discharging: reverse)
  if (batLine) {
    if (data.ibat > 0.02) {
      batLine.classList.remove('flow-active-reverse');
      batLine.classList.add('flow-active-forward');
      batLine.setAttribute('stroke', '#10B981');
    } else if (data.ibat < -0.02) {
      batLine.classList.remove('flow-active-forward');
      batLine.classList.add('flow-active-reverse');
      batLine.setAttribute('stroke', '#F59E0B');
    } else {
      batLine.classList.remove('flow-active-forward', 'flow-active-reverse');
    }
  }

  // 3. Tie Bus Path (Local Bus <-> Shared Bus)
  // Active when |ibus| > 0.02
  // If ibus < -0.02: Exporting (Local Bus -> Shared Bus: forward, blue)
  // If ibus > 0.02: Importing (Shared Bus -> Local Bus: reverse, violet)
  if (tieLine) {
    if (data.ibus < -0.02 || data.tie === 'EXPORT') {
      tieLine.classList.remove('flow-active-reverse');
      tieLine.classList.add('flow-active-forward');
      tieLine.setAttribute('stroke', '#3B82F6');
    } else if (data.ibus > 0.02 || data.tie === 'IMPORT') {
      tieLine.classList.remove('flow-active-forward');
      tieLine.classList.add('flow-active-reverse');
      tieLine.setAttribute('stroke', '#8B5CF6');
    } else {
      tieLine.classList.remove('flow-active-forward', 'flow-active-reverse');
    }
  }
}

/**
 * Render Combined Shared Inter-Tie Bus Panel
 */
function renderCombinedBusPanel(node1, node2) {
  if (!node1 || !node2) return;

  const busVoltEl = document.getElementById('combinedBusVoltage');
  const n1Action = document.getElementById('node1TieAction');
  const n2Action = document.getElementById('node2TieAction');
  const transferChannel = document.getElementById('busTransferChannel');
  const transferArrow = document.getElementById('transferArrow');
  const transferWattage = document.getElementById('transferWattage');
  const transferPhrase = document.getElementById('transferPhrase');

  // Average bus voltage
  const avgBusV = ((node1.vbus + node2.vbus) / 2).toFixed(2);
  if (busVoltEl) busVoltEl.textContent = `${avgBusV} V`;

  // Transfer power calculation
  // Negative ibus = exporting, positive ibus = importing
  const transferW = Math.max(
    Math.abs(node1.vbus * node1.ibus),
    Math.abs(node2.vbus * node2.ibus)
  );

  if (transferWattage) {
    transferWattage.textContent = `${transferW.toFixed(2)} W`;
  }

  if (node1.ibus < -0.02 && node2.ibus > 0.02) {
    // Node 1 exporting -> Node 2 importing
    if (n1Action) n1Action.textContent = 'Exporting';
    if (n2Action) n2Action.textContent = 'Importing';
    if (transferArrow) transferArrow.textContent = '➔';
    if (transferPhrase) transferPhrase.textContent = 'Node 1 ➔ Node 2';
    if (transferChannel) {
      transferChannel.classList.remove('flow-n2-to-n1');
      transferChannel.classList.add('flow-n1-to-n2');
    }
  } else if (node2.ibus < -0.02 && node1.ibus > 0.02) {
    // Node 2 exporting -> Node 1 importing
    if (n1Action) n1Action.textContent = 'Importing';
    if (n2Action) n2Action.textContent = 'Exporting';
    if (transferArrow) transferArrow.textContent = '➔';
    if (transferPhrase) transferPhrase.textContent = 'Node 2 ➔ Node 1';
    if (transferChannel) {
      transferChannel.classList.remove('flow-n1-to-n2');
      transferChannel.classList.add('flow-n2-to-n1');
    }
  } else {
    // Balanced or minimal transfer
    if (n1Action) n1Action.textContent = 'Idle';
    if (n2Action) n2Action.textContent = 'Idle';
    if (transferArrow) transferArrow.textContent = '⟷';
    if (transferPhrase) transferPhrase.textContent = 'Bus Balanced';
    if (transferChannel) {
      transferChannel.classList.remove('flow-n1-to-n2', 'flow-n2-to-n1');
    }
  }
}

/**
 * Update Overall System Status Pill
 */
function updateSystemStatusPill(node1, node2) {
  const pill = document.getElementById('systemStatusPill');
  const text = document.getElementById('systemStatusText');
  if (!pill || !text || !node1 || !node2) return;

  const now = Date.now();
  const age1 = Math.round((now - (node1.local_received_at || now)) / 1000);
  const age2 = Math.round((now - (node2.local_received_at || now)) / 1000);
  const oldestAge = Math.max(age1, age2);
  const youngestAge = Math.min(age1, age2);

  if (youngestAge > 30) {
    pill.className = 'system-status-pill status-offline';
    text.textContent = 'Offline';
  } else if (oldestAge > 10) {
    pill.className = 'system-status-pill status-delayed';
    text.textContent = 'Delayed';
  } else {
    pill.className = 'system-status-pill status-live';
    text.textContent = 'Live';
  }
}

/**
 * Update Chart Canvases with Rolling Historical Data
 */
function updateChartsData(state) {
  const { history, nodes } = state;
  if (!history || !history[1] || !history[2]) return;

  // 1. Battery Voltage Series
  const sVbat1 = history[1].map(d => ({ t: d.t, val: d.vbat }));
  const sVbat2 = history[2].map(d => ({ t: d.t, val: d.vbat }));
  chartVbat?.setData(sVbat1, sVbat2);

  // 2. SOC Series
  const sSoc1 = history[1].map(d => ({ t: d.t, val: d.soc }));
  const sSoc2 = history[2].map(d => ({ t: d.t, val: d.soc }));
  chartSoc?.setData(sSoc1, sSoc2);

  // 3. Shared Bus Voltage Series
  const sVbus1 = history[1].map(d => ({ t: d.t, val: d.vbus }));
  const sVbus2 = history[2].map(d => ({ t: d.t, val: d.vbus }));
  chartVbus?.setData(sVbus1, sVbus2);

  // 4. Battery Net Current Series
  const sIbat1 = history[1].map(d => ({ t: d.t, val: d.ibat }));
  const sIbat2 = history[2].map(d => ({ t: d.t, val: d.ibat }));
  chartIbat?.setData(sIbat1, sIbat2);

  // Update card header summaries
  const c1Sum = document.getElementById('chart1Summary');
  if (c1Sum && nodes[1] && nodes[2]) {
    c1Sum.innerHTML = `<span class="summary-n1">N1: ${nodes[1].vbat.toFixed(2)} V</span><span class="summary-n2">N2: ${nodes[2].vbat.toFixed(2)} V</span>`;
  }

  const c2Sum = document.getElementById('chart2Summary');
  if (c2Sum && nodes[1] && nodes[2]) {
    c2Sum.innerHTML = `<span class="summary-n1">N1: ${nodes[1].soc.toFixed(1)}%</span><span class="summary-n2">N2: ${nodes[2].soc.toFixed(1)}%</span>`;
  }

  const c3Sum = document.getElementById('chart3Summary');
  if (c3Sum && nodes[1] && nodes[2]) {
    c3Sum.innerHTML = `<span class="summary-n1">N1: ${nodes[1].vbus.toFixed(2)} V</span><span class="summary-n2">N2: ${nodes[2].vbus.toFixed(2)} V</span>`;
  }

  const c4Sum = document.getElementById('chart4Summary');
  if (c4Sum && nodes[1] && nodes[2]) {
    const s1 = nodes[1].ibat > 0 ? '+' : '';
    const s2 = nodes[2].ibat > 0 ? '+' : '';
    c4Sum.innerHTML = `<span class="summary-n1">N1: ${s1}${nodes[1].ibat.toFixed(2)} A</span><span class="summary-n2">N2: ${s2}${nodes[2].ibat.toFixed(2)} A</span>`;
  }
}

/**
 * 1-second Interval Ticker for Smooth Freshness Age Updates
 */
function initTicker() {
  setInterval(() => {
    const state = telemetryService.getState();
    const now = Date.now();

    [1, 2].forEach(id => {
      const node = state.nodes[id];
      if (node) {
        const age = Math.max(0, Math.round((now - (node.local_received_at || now)) / 1000));
        const el = document.getElementById(`node${id}Freshness`);
        if (el) el.textContent = `Updated ${age}s ago`;

        // Update delayed/offline states
        const cardEl = document.getElementById(`cardNode${id}`);
        const badgeEl = document.getElementById(`node${id}FreshnessBadge`);
        const offlineBanner = document.getElementById(`node${id}OfflineBanner`);

        if (cardEl && badgeEl) {
          if (age > 30) {
            cardEl.classList.remove('node-delayed');
            cardEl.classList.add('node-offline');
            badgeEl.className = 'freshness-badge badge-offline';
            badgeEl.textContent = 'Offline';
            if (offlineBanner) offlineBanner.style.display = 'flex';
          } else if (age > 10) {
            cardEl.classList.remove('node-offline');
            cardEl.classList.add('node-delayed');
            badgeEl.className = 'freshness-badge badge-delayed';
            badgeEl.textContent = 'Delayed';
            if (offlineBanner) offlineBanner.style.display = 'none';
          }
        }
      }
    });

    updateSystemStatusPill(state.nodes[1], state.nodes[2]);
  }, 1000);
}

/**
 * API Ingestion & Modal Config
 */
function initApiModal() {
  const modal = document.getElementById('apiModalBackdrop');
  const openBtn = document.getElementById('apiModalOpenBtn');
  const closeBtn = document.getElementById('modalCloseBtn');
  const endpointInput = document.getElementById('endpointInput');
  const copyBtn = document.getElementById('copyCurlBtn');
  const modeBtn = document.getElementById('modeToggleBtn');

  // Mode Toggle Button (Demo vs Live)
  modeBtn?.addEventListener('click', () => {
    const cur = telemetryService.isDemoMode;
    telemetryService.setDemoMode(!cur);
  });

  // Modal Open / Close
  openBtn?.addEventListener('click', () => {
    if (endpointInput) endpointInput.value = telemetryService.ingestUrl;
    if (modal) modal.style.display = 'flex';
  });

  closeBtn?.addEventListener('click', () => {
    if (modal) modal.style.display = 'none';
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  endpointInput?.addEventListener('change', (e) => {
    telemetryService.setIngestUrl(e.target.value.trim());
  });

  // Copy curl helper
  copyBtn?.addEventListener('click', () => {
    const code = document.getElementById('curlSnippet')?.textContent || '';
    navigator.clipboard?.writeText(code).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy curl'; }, 2000);
    });
  });

  // Simulate Ingest Buttons
  document.getElementById('sendTestN1Btn')?.addEventListener('click', () => {
    telemetryService.postDirectTelemetry({
      node_id: 1,
      vbat: 12.68,
      ibat: 0.42,
      vpv: 18.25,
      ipv: 0.58,
      vbus: 12.82,
      ibus: -0.22,
      soc: 84.5,
      pv_ok: true,
      source: 'PV',
      tie: 'EXPORT',
      lockout: false,
      timestamp: new Date().toISOString()
    });
  });

  document.getElementById('sendTestN2Btn')?.addEventListener('click', () => {
    telemetryService.postDirectTelemetry({
      node_id: 2,
      vbat: 12.72,
      ibat: 0.35,
      vpv: 18.10,
      ipv: 0.52,
      vbus: 12.80,
      ibus: -0.20,
      soc: 82.0,
      pv_ok: true,
      source: 'PV',
      tie: 'EXPORT',
      lockout: false,
      timestamp: new Date().toISOString()
    });
  });
}
