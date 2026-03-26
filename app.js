(function () {
  const rootDataset = window.DATASET;
  const scenarioSwitchEl = document.getElementById("scenario-switch");
  const scenarioSubtitleEl = document.getElementById("scenario-subtitle");
  const mapTitleEl = document.getElementById("map-title");
  const villageTitleEl = document.getElementById("village-title");
  const metricsEl = document.getElementById("metrics");
  const detailEl = document.getElementById("cell-detail");
  const villageEl = document.getElementById("village-list");
  const alertStripEl = document.getElementById("alert-strip");
  const overviewCardsEl = document.getElementById("overview-cards");
  const layerSelect = document.getElementById("layer-select");
  const viewSelect = document.getElementById("view-select");
  const mapModeLabel = document.getElementById("map-mode-label");
  const timeSlider = document.getElementById("time-slider");
  const timeLabel = document.getElementById("time-label");
  const playBtn = document.getElementById("play-btn");
  const toggles = {
    lines: document.getElementById("toggle-lines"),
    hotspots: document.getElementById("toggle-hotspots"),
    watchpoints: document.getElementById("toggle-watchpoints"),
  };

  const scenarios = rootDataset.scenarios || [];
  const scenarioMap = Object.fromEntries(scenarios.map((item) => [item.id, item]));
  const queryScenario = new URLSearchParams(window.location.search).get("scenario");
  const defaultScenarioId = scenarioMap[queryScenario] ? queryScenario : (scenarios[0] ? scenarios[0].id : null);

  const state = {
    scenarioId: defaultScenarioId,
    layer: "risk",
    view: "heat",
    frameIndex: 0,
    selectedCellId: null,
    selectedCorridorId: null,
    showLines: true,
    showHotspots: false,
    showWatchpoints: false,
    playing: true,
    timer: null,
  };

  function scenario() {
    return scenarioMap[state.scenarioId];
  }

  function currentFrame() {
    return scenario().frames[state.frameIndex];
  }

  function baseCellMap() {
    return Object.fromEntries(scenario().cells.map((cell) => [cell.id, cell]));
  }

  function resetSelection() {
    const cells = scenario().cells;
    state.selectedCellId = cells[0] ? cells[0].id : null;
    state.selectedCorridorId = null;
  }

  resetSelection();

  const map = L.map("map", { zoomControl: true }).setView([
    scenario().meta.base_lat + scenario().meta.lat_step * (scenario().meta.rows / 2),
    scenario().meta.base_lon + scenario().meta.lon_step * (scenario().meta.cols / 2),
  ], 10);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  let heatLayer = null;
  const cellLayer = L.layerGroup().addTo(map);
  const hotspotLayer = L.layerGroup().addTo(map);
  const corridorLayer = L.layerGroup().addTo(map);
  const watchLayer = L.layerGroup().addTo(map);

  const palette = {
    risk: (_base, dynamic) => dynamic.color,
    elevation: (base) => gradient(base.elevation_m, 1200, 3300, ["#17324a", "#2f7d5b", "#d6b96d", "#f6ead2"]),
    slope: (base) => gradient(base.slope_deg, 0, 35, ["#17324a", "#1e8a70", "#f2c94c", "#eb5757"]),
    wind: (_base, dynamic) => gradient(dynamic.wind_ms, 0, 18, ["#21435a", "#2d7fb6", "#7dd8c2", "#f6d365"]),
    dryness: (_base, dynamic) => gradient(dynamic.dfmc_selected, 0, 22, ["#2c5d46", "#7ba943", "#f3b13a", "#dd5c3d"]),
  };

  function gradient(value, min, max, colors) {
    const t = Math.max(0, Math.min(0.999, (value - min) / (max - min)));
    const scaled = t * (colors.length - 1);
    const index = Math.floor(scaled);
    const next = Math.min(colors.length - 1, index + 1);
    const localT = scaled - index;
    return mix(colors[index], colors[next], localT);
  }

  function mix(a, b, t) {
    const ar = parseInt(a.slice(1, 3), 16);
    const ag = parseInt(a.slice(3, 5), 16);
    const ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16);
    const bg = parseInt(b.slice(3, 5), 16);
    const bb = parseInt(b.slice(5, 7), 16);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const b2 = Math.round(ab + (bb - ab) * t);
    return `rgb(${r}, ${g}, ${b2})`;
  }

  function riskLabel(level) {
    return { 1: "Low", 2: "Guarded", 3: "Elevated", 4: "High", 5: "Severe" }[level] || "Unknown";
  }

  function hotspotLabel(current) {
    return current.hotspot ? "Hotspot candidate" : "Under watch";
  }

  function cellDrivers(base, current) {
    const drivers = [];
    if (current.wind_ms >= 11) drivers.push("strong upslope wind");
    if (current.dfmc_selected <= 9) drivers.push("very dry fuel");
    if (base.slope_deg >= 28) drivers.push("steep terrain");
    if (base.clearance_m <= 2.5) drivers.push("tight safety distance");
    if (drivers.length === 0) drivers.push("moderate terrain and weather pressure");
    return drivers;
  }

  function cellAction(current) {
    if (current.level >= 5) return "Immediate patrol and corridor watch are recommended.";
    if (current.level >= 4) return "Increase inspection frequency and keep suppression teams ready.";
    if (current.level >= 3) return "Maintain active monitoring during the current time window.";
    return "Routine watch is sufficient under the current conditions.";
  }

  function cellPopupHTML(base, current) {
    return `
      <div>
        <strong>${base.village}</strong><br/>
        ${riskLabel(current.level)} warning, ${(current.final_risk * 100).toFixed(1)}% risk<br/>
        ${hotspotLabel(current)} during ${currentFrame().timestamp}<br/>
        Main drivers: ${cellDrivers(base, current).join(", ")}<br/>
        Suggested action: ${cellAction(current)}
      </div>
    `;
  }

  function corridorNarrative(corridor) {
    if (corridor.risk >= 0.8) return "This corridor is under severe pressure and should be prioritized first.";
    if (corridor.risk >= 0.65) return "This corridor is one of the main warning corridors in the current frame.";
    if (corridor.risk >= 0.45) return "This corridor shows elevated but manageable fire spread potential.";
    return "This corridor is currently below the main warning threshold.";
  }

  function corridorPopupHTML(corridorId, segment, corridor) {
    return `
      <div>
        <strong>${corridorId}</strong><br/>
        ${riskLabel(segment.level)} corridor segment, ${(segment.risk * 100).toFixed(1)}% segment risk<br/>
        Width signal: ${segment.weight.toFixed(1)} px visual intensity<br/>
        ${corridorNarrative(corridor)}
      </div>
    `;
  }

  function cellBounds(base) {
    const halfLat = scenario().meta.lat_step / 2;
    const halfLon = scenario().meta.lon_step / 2;
    return [[base.lat - halfLat, base.lon - halfLon], [base.lat + halfLat, base.lon + halfLon]];
  }

  function syncMapCenter() {
    map.setView([
      scenario().meta.base_lat + scenario().meta.lat_step * (scenario().meta.rows / 2),
      scenario().meta.base_lon + scenario().meta.lon_step * (scenario().meta.cols / 2),
    ], state.scenarioId === "australia" ? 9 : 10);
    mapTitleEl.textContent = scenario().name;
    scenarioSubtitleEl.textContent = scenario().subtitle;
    villageTitleEl.textContent = state.scenarioId === "australia" ? "District Aggregation" : "Regional Aggregation";
  }

  function renderScenarioSwitch() {
    scenarioSwitchEl.innerHTML = scenarios.map((item) => `
      <button class="chip ${item.id === state.scenarioId ? 'active' : ''}" data-scenario-id="${item.id}">${item.name}</button>
    `).join("");
    scenarioSwitchEl.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => switchScenario(button.dataset.scenarioId));
    });
  }

  function renderAll() {
    syncMapCenter();
    renderScenarioSwitch();
    renderTimeHeader();
    renderAlertStrip();
    renderOverviewCards();
    renderMetrics();
    renderHeat();
    renderCells();
    renderCorridors();
    renderWatchPoints();
    renderDetail();
    renderVillages();
  }

  function renderTimeHeader() {
    const frame = currentFrame();
    timeSlider.max = String(scenario().frames.length - 1);
    timeSlider.value = String(state.frameIndex);
    timeLabel.textContent = frame.timestamp;
    playBtn.textContent = state.playing ? "Pause" : "Play";
    playBtn.classList.toggle("active", state.playing);
    mapModeLabel.textContent = viewSelect.options[viewSelect.selectedIndex].textContent;
  }

  function renderAlertStrip() {
    const frame = currentFrame();
    const topVillage = frame.villages[0];
    const topCorridor = frame.corridors.slice().sort((a, b) => b.risk - a.risk)[0];
    alertStripEl.innerHTML = [
      `<div class="alert-card"><strong>Scenario</strong><span>${scenario().name}</span></div>`,
      `<div class="alert-card"><strong>Top Corridor</strong><span>${topCorridor.id} at ${(topCorridor.risk * 100).toFixed(1)}% corridor risk</span></div>`,
      `<div class="alert-card"><strong>Top Region</strong><span>${topVillage.name} at ${(topVillage.score * 100).toFixed(1)}% regional score</span></div>`,
    ].join("");
  }

  function renderOverviewCards() {
    const frame = currentFrame();
    const topCorridor = frame.corridors.slice().sort((a, b) => b.risk - a.risk)[0];
    overviewCardsEl.innerHTML = `
      <div class="overview-grid">
        <div class="overview-item"><span>Current Time</span><strong>${frame.timestamp}</strong></div>
        <div class="overview-item"><span>Hotspots</span><strong>${frame.summary.hotspot_count}</strong></div>
        <div class="overview-item"><span>Peak Corridor</span><strong>${topCorridor.id}</strong></div>
        <div class="overview-item"><span>Peak Risk</span><strong>${(frame.summary.max_risk * 100).toFixed(1)}%</strong></div>
      </div>
    `;
  }

  function renderMetrics() {
    const summary = currentFrame().summary;
    metricsEl.innerHTML = [
      metricCard("High-risk Cells", `${summary.high_risk_cells}`),
      metricCard("Hotspots", `${summary.hotspot_count}`),
      metricCard("Average Risk", `${(summary.mean_risk * 100).toFixed(1)}%`),
      metricCard("Peak Risk", `${(summary.max_risk * 100).toFixed(1)}%`),
    ].join("");
  }

  function metricCard(label, value) {
    return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function renderHeat() {
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
    }
    if (state.view !== "heat" && state.view !== "corridor") return;
    const points = currentFrame().cells.map((cell) => {
      const base = baseCellMap()[cell.id];
      return [base.lat, base.lon, cell.final_risk];
    });
    heatLayer = L.heatLayer(points, {
      radius: state.view === "heat" ? 24 : 16,
      blur: state.view === "heat" ? 26 : 18,
      maxZoom: 12,
      max: 1.0,
      gradient: {
        0.05: "#1f6f8b",
        0.25: "#2bb3a3",
        0.5: "#f2c94c",
        0.75: "#f2994a",
        1.0: "#eb5757",
      },
    }).addTo(map);
  }

  function renderCells() {
    cellLayer.clearLayers();
    hotspotLayer.clearLayers();
    if (state.view !== "cells" && state.view !== "terrain") return;
    const baseMap = baseCellMap();
    const dyn = Object.fromEntries(currentFrame().cells.map((cell) => [cell.id, cell]));
    for (const base of scenario().cells) {
      const current = dyn[base.id];
      const selected = state.selectedCellId === base.id && !state.selectedCorridorId;
      const fillMode = state.view === "terrain" ? "elevation" : state.layer;
      const rect = L.rectangle(cellBounds(base), {
        stroke: selected,
        weight: selected ? 2.2 : 0.35,
        color: selected ? "#ffffff" : "rgba(255,255,255,0.12)",
        fillColor: palette[fillMode](base, current),
        fillOpacity: selected ? 0.92 : 0.7,
      });
      rect.on("click", () => {
        state.selectedCellId = base.id;
        state.selectedCorridorId = null;
        renderDetail();
      });
      rect.bindPopup(cellPopupHTML(base, current));
      cellLayer.addLayer(rect);

      if (state.showHotspots && current.hotspot) {
        hotspotLayer.addLayer(L.circle([base.lat, base.lon], {
          radius: 380,
          color: current.color,
          weight: 1,
          opacity: 0.25,
          fillColor: current.color,
          fillOpacity: 0.12,
        }));
      }
    }
  }

  function renderCorridors() {
    corridorLayer.clearLayers();
    if (!state.showLines) return;
    const corridorMap = Object.fromEntries(currentFrame().corridors.map((corridor) => [corridor.id, corridor]));
    for (const corridor of scenario().corridors) {
      const current = corridorMap[corridor.id];
      if (!current) continue;
      const selected = state.selectedCorridorId === corridor.id;
      for (const segment of current.segment_styles) {
        const glow = L.polyline(segment.coords, {
          color: segment.color,
          weight: segment.weight + 7,
          opacity: state.view === "corridor" ? 0.28 : 0.18,
          className: selected ? "corridor-segment-selected" : "corridor-segment-glow",
          lineCap: "round",
          lineJoin: "round",
        });
        const line = L.polyline(segment.coords, {
          color: segment.color,
          weight: selected ? segment.weight + 2.2 : segment.weight,
          opacity: 0.95,
          className: selected ? "corridor-segment-selected corridor-segment-main" : "corridor-segment-main",
          lineCap: "round",
          lineJoin: "round",
        });
        line.on("click", () => {
          state.selectedCorridorId = corridor.id;
          state.selectedCellId = null;
          renderDetail();
        });
        line.bindPopup(corridorPopupHTML(corridor.id, segment, current));
        corridorLayer.addLayer(glow);
        corridorLayer.addLayer(line);
      }
    }
  }

  function renderWatchPoints() {
    watchLayer.clearLayers();
    if (!state.showWatchpoints) return;
    for (const point of scenario().watch_points) {
      watchLayer.addLayer(L.circle([point.lat, point.lon], {
        radius: point.coverage_km * 550,
        color: "#7dd8c2",
        weight: 1,
        opacity: 0.35,
        fillColor: "#7dd8c2",
        fillOpacity: 0.06,
      }));
    }
  }

  function renderDetail() {
    const frame = currentFrame();
    if (state.selectedCorridorId) {
      const corridor = frame.corridors.find((item) => item.id === state.selectedCorridorId);
      if (corridor) {
        detailEl.innerHTML = `
          <div class="detail-title">
            <div>
              <strong>${corridor.id}</strong>
              <div style="color: var(--muted); margin-top: 6px;">Corridor warning summary for ${frame.timestamp}</div>
            </div>
            <span class="pill" style="background:${corridor.segment_styles[0] ? corridor.segment_styles[0].color : '#999'};">${riskLabel(corridor.level)}</span>
          </div>
          <div class="detail-grid">
            <div class="detail-item"><span>Corridor Risk</span><strong>${(corridor.risk * 100).toFixed(1)}%</strong></div>
            <div class="detail-item"><span>Segments</span><strong>${corridor.segment_styles.length}</strong></div>
            <div class="detail-item"><span>Main Reading</span><strong>${corridor.level >= 4 ? 'Priority watch corridor' : 'Routine corridor watch'}</strong></div>
            <div class="detail-item"><span>Display</span><strong>Curved line with width gradient</strong></div>
          </div>
          <p style="margin:16px 0 0; color: var(--muted); line-height:1.5;">
            ${corridorNarrative(corridor)}
          </p>
        `;
        return;
      }
    }

    const baseMap = baseCellMap();
    const dyn = Object.fromEntries(frame.cells.map((cell) => [cell.id, cell]));
    const base = baseMap[state.selectedCellId] || scenario().cells[0];
    const current = dyn[base.id];
    detailEl.innerHTML = `
      <div class="detail-title">
        <div>
          <strong>${base.village}</strong>
          <div style="color: var(--muted); margin-top: 6px;">${base.vegetation.label} slope zone during ${frame.timestamp}</div>
        </div>
        <span class="pill" style="background:${current.color};">${riskLabel(current.level)}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><span>Warning Score</span><strong>${(current.final_risk * 100).toFixed(1)}%</strong></div>
        <div class="detail-item"><span>Terrain</span><strong>${base.elevation_m} m / ${base.slope_deg} deg</strong></div>
        <div class="detail-item"><span>Weather Pressure</span><strong>${current.wind_ms} m/s wind / ${current.humidity_pct}% humidity</strong></div>
        <div class="detail-item"><span>Fuel Condition</span><strong>${current.dfmc_selected} from ${current.dfmc_key}</strong></div>
        <div class="detail-item"><span>Status</span><strong>${hotspotLabel(current)}</strong></div>
        <div class="detail-item"><span>Action</span><strong>${cellAction(current)}</strong></div>
      </div>
      <div class="stack-bar">
        <div class="stack-row"><span>Trigger</span><div class="stack-track"><div class="stack-fill" style="width:${(current.p_trigger * 100).toFixed(1)}%; background:#7dd8c2;"></div></div><strong>${(current.p_trigger * 100).toFixed(0)}%</strong></div>
        <div class="stack-row"><span>Ignite</span><div class="stack-track"><div class="stack-fill" style="width:${(current.p_ignite * 100).toFixed(1)}%; background:#ffb84d;"></div></div><strong>${(current.p_ignite * 100).toFixed(0)}%</strong></div>
        <div class="stack-row"><span>Spread</span><div class="stack-track"><div class="stack-fill" style="width:${(current.p_spread * 100).toFixed(1)}%; background:#f26b5b;"></div></div><strong>${(current.p_spread * 100).toFixed(0)}%</strong></div>
      </div>
      <p style="margin:16px 0 0; color: var(--muted); line-height:1.5;">
        Main drivers for the current warning are ${cellDrivers(base, current).join(', ')}. Suggested action: ${cellAction(current)}
      </p>
    `;
  }

  function renderVillages() {
    villageEl.innerHTML = currentFrame().villages.map((village) => `
      <div class="village-card">
        <div>
          <strong>${village.name}</strong>
          <p>${riskLabel(village.level)} regional warning / ${village.hotspots} hotspots / ${village.population} people</p>
        </div>
        <span class="pill" style="background:${village.color};">${(village.score * 100).toFixed(0)}%</span>
      </div>
    `).join('');
  }

  function setFrame(index) {
    state.frameIndex = (index + scenario().frames.length) % scenario().frames.length;
    renderAll();
  }

  function startPlayback() {
    stopPlayback();
    state.playing = true;
    state.timer = window.setInterval(() => setFrame(state.frameIndex + 1), 1500);
    renderTimeHeader();
  }

  function stopPlayback() {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    state.playing = false;
    renderTimeHeader();
  }

  function togglePlayback() {
    if (state.playing) stopPlayback();
    else startPlayback();
  }

  function switchScenario(id) {
    if (!scenarioMap[id] || id === state.scenarioId) return;
    state.scenarioId = id;
    state.frameIndex = 0;
    resetSelection();
    const params = new URLSearchParams(window.location.search);
    params.set('scenario', id);
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    renderAll();
    if (state.playing) startPlayback();
  }

  viewSelect.addEventListener('change', (event) => {
    state.view = event.target.value;
    renderAll();
  });

  layerSelect.addEventListener('change', (event) => {
    state.layer = event.target.value;
    renderCells();
  });

  timeSlider.addEventListener('input', (event) => {
    stopPlayback();
    setFrame(Number(event.target.value));
  });

  playBtn.addEventListener('click', togglePlayback);

  toggles.lines.addEventListener('click', () => {
    state.showLines = !state.showLines;
    toggles.lines.classList.toggle('active', state.showLines);
    renderCorridors();
  });
  toggles.hotspots.addEventListener('click', () => {
    state.showHotspots = !state.showHotspots;
    toggles.hotspots.classList.toggle('active', state.showHotspots);
    renderCells();
  });
  toggles.watchpoints.addEventListener('click', () => {
    state.showWatchpoints = !state.showWatchpoints;
    toggles.watchpoints.classList.toggle('active', state.showWatchpoints);
    renderWatchPoints();
  });

  renderAll();
  startPlayback();
})();
