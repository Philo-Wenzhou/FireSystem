(function () {
  const rootDataset = window.DATASET;
  if (!rootDataset || !Array.isArray(rootDataset.scenarios) || !rootDataset.scenarios.length) {
    console.error("Missing or invalid DATASET");
    return;
  }

  const scenarioSwitchEl = document.getElementById("scenario-switch");
  const scenarioSubtitleEl = document.getElementById("scenario-subtitle");
  const mapTitleEl = document.getElementById("map-title");
  const villageTitleEl = document.getElementById("village-title");
  const metricsEl = document.getElementById("metrics");
  const detailEl = document.getElementById("cell-detail");
  const forecastEl = document.getElementById("forecast-panel");
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

  const scenarios = rootDataset.scenarios;
  const scenarioMap = Object.fromEntries(scenarios.map((item) => [item.id, item]));
  const queryScenario = new URLSearchParams(window.location.search).get("scenario");
  const defaultScenarioId = scenarioMap[queryScenario] ? queryScenario : scenarios[0].id;

  const state = {
    scenarioId: defaultScenarioId,
    layer: "risk",
    view: "heat",
    frameIndex: 0,
    selectedCellId: null,
    selectedCorridorId: null,
    selectedWatchpointName: null,
    showLines: true,
    showHotspots: false,
    showWatchpoints: false,
    playing: true,
    draggingTime: false,
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

  function frameCellMap(frameIndex) {
    const frame = scenario().frames[(frameIndex + scenario().frames.length) % scenario().frames.length];
    return Object.fromEntries(frame.cells.map((cell) => [cell.id, cell]));
  }

  function resetSelection() {
    const cells = scenario().cells;
    state.selectedCellId = cells[0] ? cells[0].id : null;
    state.selectedCorridorId = null;
    state.selectedWatchpointName = null;
  }

  function nearestBaseCell(lat, lon) {
    return scenario().cells.reduce((best, cell) => {
      if (!best) return cell;
      const d1 = (cell.lat - lat) ** 2 + (cell.lon - lon) ** 2;
      const d2 = (best.lat - lat) ** 2 + (best.lon - lon) ** 2;
      return d1 < d2 ? cell : best;
    }, null);
  }

  function getWatchpointContext(name) {
    const point = scenario().watch_points.find((item) => item.name === name);
    if (!point) return null;
    const base = nearestBaseCell(point.lat, point.lon);
    const current = frameCellMap(state.frameIndex)[base.id];
    return { point, base, current };
  }

  resetSelection();

  const map = L.map("map", { zoomControl: true, preferCanvas: true });
  map.createPane("terrainPane");
  map.createPane("boundaryPane");
  map.createPane("heatPane");
  map.createPane("cellPane");
  map.createPane("corridorPane");
  map.createPane("watchPane");
  map.createPane("fixedPointPane");
  map.getPane("terrainPane").style.zIndex = 320;
  map.getPane("boundaryPane").style.zIndex = 330;
  map.getPane("heatPane").style.zIndex = 340;
  map.getPane("cellPane").style.zIndex = 350;
  map.getPane("corridorPane").style.zIndex = 470;
  map.getPane("watchPane").style.zIndex = 480;
  map.getPane("fixedPointPane").style.zIndex = 490;
  map.getPane("terrainPane").style.pointerEvents = "none";
  map.getPane("boundaryPane").style.pointerEvents = "none";
  map.getPane("heatPane").style.pointerEvents = "none";

  const onlineTileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap",
  });
  let tileErrorCount = 0;
  onlineTileLayer.on("tileerror", () => {
    tileErrorCount += 1;
    if (tileErrorCount > 12 && map.hasLayer(onlineTileLayer)) map.removeLayer(onlineTileLayer);
  });
  onlineTileLayer.on("load", () => { tileErrorCount = 0; });
  if (navigator.onLine) onlineTileLayer.addTo(map);

  const terrainBaseLayer = L.layerGroup().addTo(map);
  const boundaryLayer = L.layerGroup().addTo(map);
  const cellLayer = L.layerGroup().addTo(map);
  const hotspotLayer = L.layerGroup().addTo(map);
  const corridorLayer = L.layerGroup().addTo(map);
  const watchLayer = L.layerGroup().addTo(map);
  const fixedPointLayer = L.layerGroup().addTo(map);
  let heatLayer = null;

  const palette = {
    risk: (_base, dynamic) => dynamic.color,
    elevation: (base) => gradient(base.elevation_m, 200, 3600, ["#17324a", "#2f7d5b", "#d6b96d", "#f6ead2"]),
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
    const blue = Math.round(ab + (bb - ab) * t);
    return `rgb(${r}, ${g}, ${blue})`;
  }

  function riskLabel(level) {
    return { 1: "Low", 2: "Guarded", 3: "Elevated", 4: "High", 5: "Severe" }[level] || "Unknown";
  }

  function levelFromRisk(score, windMs = 0, rainMm = 0) {
    let level = 1;
    if (score >= 0.2) level = 2;
    if (score >= 0.5) level = 3;
    if (score >= 0.75) level = 4;
    if (score >= 0.9) level = 5;
    if (windMs > 14) level = Math.min(level + 1, 5);
    if (rainMm > 15) level = 1;
    else if (rainMm > 5) level = Math.max(level - 1, 1);
    return level;
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
    if (!drivers.length) drivers.push("moderate terrain and weather pressure");
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

  function watchpointPopupHTML(point, base, current) {
    return `
      <div class="station-popup-card">
        <div class="station-popup-top">
          <strong>${point.name}</strong>
          <span class="station-popup-badge" style="background:${current.color};">${riskLabel(current.level)}</span>
        </div>
        <div class="station-popup-sub">Fixed monitoring point ? Linked sector ${base.village}</div>
        <div class="station-popup-risk">${(current.final_risk * 100).toFixed(1)}% current risk</div>
        <div class="station-popup-meta">Wind ${current.wind_ms.toFixed(1)} m/s ? Humidity ${current.humidity_pct.toFixed(0)}%</div>
        <div class="station-popup-factors">Main drivers: ${cellDrivers(base, current).join(", ")}</div>
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

  function scenarioBounds() {
    return L.geoJSON(scenario().boundary).getBounds();
  }

  function updateScenarioHeader() {
    mapTitleEl.textContent = scenario().name;
    scenarioSubtitleEl.textContent = scenario().subtitle;
    villageTitleEl.textContent = state.scenarioId === "sichuan" ? "Province Aggregation" : "State Aggregation";
  }

  function fitScenarioBounds() {
    const bounds = scenarioBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.04), { animate: false });
  }

  function renderScenarioSwitch() {
    scenarioSwitchEl.innerHTML = scenarios.map((item) => `
      <button class="chip ${item.id === state.scenarioId ? "active" : ""}" data-scenario-id="${item.id}">${item.name}</button>
    `).join("");
    scenarioSwitchEl.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => switchScenario(button.dataset.scenarioId));
    });
  }

  function renderBoundary() {
    boundaryLayer.clearLayers();
    boundaryLayer.addLayer(L.geoJSON(scenario().boundary, {
      pane: "boundaryPane",
      style: {
        color: "#d7efe8",
        weight: 1.6,
        opacity: 0.85,
        fillColor: "#54737a",
        fillOpacity: state.view === "terrain" ? 0.06 : 0.015,
      },
      interactive: false,
    }));
  }

  function renderTerrainBase() {
    terrainBaseLayer.clearLayers();
    for (const base of scenario().cells) {
      terrainBaseLayer.addLayer(L.rectangle(cellBounds(base), {
        pane: "terrainPane",
        stroke: false,
        fillColor: palette.elevation(base),
        fillOpacity: state.view === "terrain" ? 0.46 : 0.10,
        interactive: false,
      }));
    }
  }

  function renderTimeHeader() {
    const frame = currentFrame();
    timeSlider.max = String(scenario().frames.length - 1);
    if (!state.draggingTime) timeSlider.value = String(state.frameIndex);
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
      `<div class="alert-card"><strong>Scenario</strong><span>${scenario().shape_name}</span></div>`,
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
      pane: "heatPane",
      radius: state.view === "heat" ? 28 : 20,
      blur: state.view === "heat" ? 26 : 18,
      maxZoom: 12,
      max: 1.0,
      gradient: {
        0.05: "#225b80",
        0.25: "#2bb3a3",
        0.5: "#f2c94c",
        0.75: "#f2994a",
        1.0: "#eb5757",
      },
      minOpacity: 0.22,
    }).addTo(map);
  }

  function renderCells() {
    cellLayer.clearLayers();
    hotspotLayer.clearLayers();
    if (state.view !== "cells" && state.view !== "terrain") return;
    const dyn = frameCellMap(state.frameIndex);
    for (const base of scenario().cells) {
      const current = dyn[base.id];
      if (!current) continue;
      const selected = state.selectedCellId === base.id && !state.selectedCorridorId && !state.selectedWatchpointName;
      const fillMode = state.view === "terrain" ? "elevation" : state.layer;
      const rect = L.rectangle(cellBounds(base), {
        pane: "cellPane",
        stroke: selected,
        weight: selected ? 1.8 : 0.12,
        color: selected ? "#ffffff" : "rgba(255,255,255,0.06)",
        fillColor: palette[fillMode](base, current),
        fillOpacity: selected ? 0.75 : 0.42,
      });
      rect.on("click", (event) => {
        if (event.originalEvent) event.originalEvent.stopPropagation();
        state.selectedCellId = base.id;
        state.selectedCorridorId = null;
        state.selectedWatchpointName = null;
        renderDetail();
        renderForecastPanel();
        rect.openPopup();
      });
      rect.bindPopup(cellPopupHTML(base, current));
      cellLayer.addLayer(rect);

      if (state.showHotspots && current.hotspot) {
        hotspotLayer.addLayer(L.circle([base.lat, base.lon], {
          pane: "cellPane",
          radius: 7000,
          color: current.color,
          weight: 1,
          opacity: 0.18,
          fillColor: current.color,
          fillOpacity: 0.08,
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
          pane: "corridorPane",
          color: segment.color,
          weight: segment.weight + 6,
          opacity: state.view === "corridor" ? 0.24 : 0.14,
          className: selected ? "corridor-segment-selected" : "corridor-segment-glow",
          lineCap: "round",
          lineJoin: "round",
        });
        const line = L.polyline(segment.coords, {
          pane: "corridorPane",
          color: segment.color,
          weight: selected ? segment.weight + 1.8 : segment.weight,
          opacity: 0.86,
          className: selected ? "corridor-segment-selected corridor-segment-main" : "corridor-segment-main",
          lineCap: "round",
          lineJoin: "round",
        });
        line.on("click", (event) => {
          if (event.originalEvent) event.originalEvent.stopPropagation();
          state.selectedCorridorId = corridor.id;
          state.selectedCellId = null;
          state.selectedWatchpointName = null;
          renderDetail();
          renderForecastPanel();
          line.openPopup();
        });
        line.bindPopup(corridorPopupHTML(corridor.id, segment, current));
        corridorLayer.addLayer(glow);
        corridorLayer.addLayer(line);
      }
    }
  }

  function renderWatchPoints() {
    watchLayer.clearLayers();
    fixedPointLayer.clearLayers();
    for (const point of scenario().watch_points) {
      const ctx = getWatchpointContext(point.name);
      if (!ctx) continue;
      const selected = state.selectedWatchpointName === point.name;
      const marker = L.circleMarker([point.lat, point.lon], {
        pane: "fixedPointPane",
        radius: selected ? 8 : 6,
        color: "#f7f3dc",
        weight: 1.5,
        fillColor: ctx.current.color,
        fillOpacity: 0.95,
      });
      marker.on("click", (event) => {
        if (event.originalEvent) event.originalEvent.stopPropagation();
        state.selectedWatchpointName = point.name;
        state.selectedCellId = ctx.base.id;
        state.selectedCorridorId = null;
        renderDetail();
        renderForecastPanel();
        marker.openPopup();
      });
      marker.bindPopup(watchpointPopupHTML(point, ctx.base, ctx.current));
      fixedPointLayer.addLayer(marker);

      if (state.showWatchpoints) {
        watchLayer.addLayer(L.circle([point.lat, point.lon], {
          pane: "watchPane",
          radius: point.coverage_km * 5000,
          color: "#7dd8c2",
          weight: 1,
          opacity: 0.28,
          fillColor: "#7dd8c2",
          fillOpacity: 0.04,
        }));
      }
    }
  }

  function selectedForecastContext() {
    if (state.selectedWatchpointName) return getWatchpointContext(state.selectedWatchpointName);
    if (state.selectedCorridorId) return null;
    const base = baseCellMap()[state.selectedCellId] || scenario().cells[0];
    const current = frameCellMap(state.frameIndex)[base.id];
    return { point: null, base, current };
  }

  function interpolateValue(a, b, frac, key) {
    return a[key] + (b[key] - a[key]) * frac;
  }

  function addHours(label, hours) {
    const [hh, mm] = label.split(":").map(Number);
    const total = hh * 60 + mm + hours * 60;
    const normalized = ((total % 1440) + 1440) % 1440;
    const outH = String(Math.floor(normalized / 60)).padStart(2, "0");
    const outM = String(normalized % 60).padStart(2, "0");
    return `${outH}:${outM}`;
  }

  function buildHourlyForecast(baseId) {
    const frames = scenario().frames;
    const hourly = [];
    for (let hour = 1; hour <= 8; hour += 1) {
      const position = state.frameIndex + hour / 2;
      const indexA = Math.floor(position) % frames.length;
      const indexB = (indexA + 1) % frames.length;
      const frac = position - Math.floor(position);
      const a = Object.fromEntries(frames[indexA].cells.map((cell) => [cell.id, cell]))[baseId];
      const b = Object.fromEntries(frames[indexB].cells.map((cell) => [cell.id, cell]))[baseId];
      const risk = interpolateValue(a, b, frac, "final_risk");
      const wind = interpolateValue(a, b, frac, "wind_ms");
      const humidity = interpolateValue(a, b, frac, "humidity_pct");
      const rain = interpolateValue(a, b, frac, "rain_mm");
      const spread = interpolateValue(a, b, frac, "p_spread");
      const dryness = interpolateValue(a, b, frac, "dfmc_selected");
      const level = levelFromRisk(risk, wind, rain);
      hourly.push({
        offsetHour: hour,
        label: addHours(currentFrame().timestamp, hour),
        risk,
        wind,
        humidity,
        rain,
        spread,
        dryness,
        level,
        color: [null, "#4BC27B", "#A7DB5A", "#F2C94C", "#F2994A", "#EB5757"][level],
      });
    }
    return hourly;
  }

  function buildForecastSparkline(hourly) {
    const width = 320;
    const height = 72;
    const pad = 8;
    const points = hourly.map((item, index) => {
      const x = pad + (index * (width - pad * 2)) / Math.max(hourly.length - 1, 1);
      const y = height - pad - item.risk * (height - pad * 2);
      return [x, y];
    });
    const polyline = points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = [`${pad},${height - pad}`, ...points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`), `${width - pad},${height - pad}`].join(" ");
    const dots = points.map((p, index) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2" fill="${hourly[index].color}" />`).join("");
    return `
      <svg class="forecast-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <polyline points="${area}" fill="rgba(242, 153, 74, 0.16)" stroke="none"></polyline>
        <polyline points="${polyline}" fill="none" stroke="#ffd48a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${dots}
      </svg>
    `;
  }

  function renderForecastPanel() {
    const ctx = selectedForecastContext();
    if (!ctx) {
      forecastEl.innerHTML = `<div class="forecast-empty">Forecast preview is available for fixed monitoring points and selected sectors.</div>`;
      return;
    }
    const title = ctx.point ? ctx.point.name : ctx.base.village;
    const hourly = buildHourlyForecast(ctx.base.id);
    forecastEl.innerHTML = `
      <div class="forecast-card-header">
        <strong>${title}</strong>
        <span>${ctx.point ? "Fixed monitoring point" : "Selected sector"}</span>
      </div>
      ${buildForecastSparkline(hourly)}
      <div class="forecast-grid">
        ${hourly.map((item) => `
          <div class="forecast-item">
            <div class="forecast-top">
              <strong>+${item.offsetHour}h</strong>
              <span>${item.label}</span>
            </div>
            <div class="forecast-risk-row">
              <span class="forecast-chip" style="background:${item.color};">${riskLabel(item.level)}</span>
              <strong>${(item.risk * 100).toFixed(0)}%</strong>
            </div>
            <p>Wind ${item.wind.toFixed(1)} m/s ? Dryness ${item.dryness.toFixed(1)} ? Spread ${(item.spread * 100).toFixed(0)}%</p>
          </div>
        `).join("")}
      </div>
    `;
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
            <div class="detail-item"><span>Main Reading</span><strong>${corridor.level >= 4 ? "Priority watch corridor" : "Routine corridor watch"}</strong></div>
            <div class="detail-item"><span>Display</span><strong>Boundary-aware curved line</strong></div>
          </div>
          <p style="margin:16px 0 0; color: var(--muted); line-height:1.5;">${corridorNarrative(corridor)}</p>
        `;
        return;
      }
    }

    if (state.selectedWatchpointName) {
      const ctx = getWatchpointContext(state.selectedWatchpointName);
      if (ctx) {
        detailEl.innerHTML = `
          <div class="detail-title">
            <div>
              <strong>${ctx.point.name}</strong>
              <div style="color: var(--muted); margin-top: 6px;">Fixed monitoring point linked to ${ctx.base.village} during ${frame.timestamp}</div>
            </div>
            <span class="pill" style="background:${ctx.current.color};">${riskLabel(ctx.current.level)}</span>
          </div>
          <div class="detail-grid">
            <div class="detail-item"><span>Point Risk</span><strong>${(ctx.current.final_risk * 100).toFixed(1)}%</strong></div>
            <div class="detail-item"><span>Linked Sector</span><strong>${ctx.base.village}</strong></div>
            <div class="detail-item"><span>Weather Pressure</span><strong>${ctx.current.wind_ms} m/s wind / ${ctx.current.humidity_pct}% humidity</strong></div>
            <div class="detail-item"><span>Fuel Condition</span><strong>${ctx.current.dfmc_selected} from ${ctx.current.dfmc_key}</strong></div>
            <div class="detail-item"><span>Main Factors</span><strong>${cellDrivers(ctx.base, ctx.current).join(", ")}</strong></div>
            <div class="detail-item"><span>Action</span><strong>${cellAction(ctx.current)}</strong></div>
          </div>
          <p style="margin:16px 0 0; color: var(--muted); line-height:1.5;">This fixed monitoring point is designed as a replaceable interface. Clients can later swap the simulated feed with a real point forecast or sensor stream.</p>
        `;
        return;
      }
    }

    const base = baseCellMap()[state.selectedCellId] || scenario().cells[0];
    const current = frameCellMap(state.frameIndex)[base.id];
    if (!base || !current) return;
    detailEl.innerHTML = `
      <div class="detail-title">
        <div>
          <strong>${base.village}</strong>
          <div style="color: var(--muted); margin-top: 6px;">${base.vegetation.label} sector during ${frame.timestamp}</div>
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
      <p style="margin:16px 0 0; color: var(--muted); line-height:1.5;">Main drivers for the current warning are ${cellDrivers(base, current).join(", ")}. Suggested action: ${cellAction(current)}</p>
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
    `).join("");
  }

  function renderAll() {
    updateScenarioHeader();
    renderScenarioSwitch();
    renderBoundary();
    renderTerrainBase();
    renderTimeHeader();
    renderAlertStrip();
    renderOverviewCards();
    renderMetrics();
    renderHeat();
    renderCells();
    renderCorridors();
    renderWatchPoints();
    corridorLayer.eachLayer((layer) => { if (layer.bringToFront) layer.bringToFront(); });
    fixedPointLayer.eachLayer((layer) => { if (layer.bringToFront) layer.bringToFront(); });
    renderDetail();
    renderForecastPanel();
    renderVillages();
  }

  function setFrame(index) {
    state.frameIndex = (index + scenario().frames.length) % scenario().frames.length;
    renderAll();
  }

  function startPlayback() {
    stopPlayback(false);
    state.playing = true;
    state.timer = window.setInterval(() => setFrame(state.frameIndex + 1), 1500);
    renderTimeHeader();
  }

  function stopPlayback(updateHeader = true) {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    state.playing = false;
    if (updateHeader) renderTimeHeader();
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
    params.set("scenario", id);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    fitScenarioBounds();
    renderAll();
    if (state.playing) startPlayback();
  }

  viewSelect.addEventListener("change", (event) => {
    state.view = event.target.value;
    renderAll();
  });

  layerSelect.addEventListener("change", (event) => {
    state.layer = event.target.value;
    renderCells();
  });

  timeSlider.addEventListener("pointerdown", () => {
    state.draggingTime = true;
    stopPlayback();
  });

  timeSlider.addEventListener("input", (event) => {
    state.frameIndex = Number(event.target.value);
    renderAll();
  });

  timeSlider.addEventListener("change", (event) => {
    state.draggingTime = false;
    setFrame(Number(event.target.value));
  });

  playBtn.addEventListener("click", togglePlayback);

  toggles.lines.addEventListener("click", () => {
    state.showLines = !state.showLines;
    toggles.lines.classList.toggle("active", state.showLines);
    renderCorridors();
  });

  toggles.hotspots.addEventListener("click", () => {
    state.showHotspots = !state.showHotspots;
    toggles.hotspots.classList.toggle("active", state.showHotspots);
    renderCells();
  });

  toggles.watchpoints.addEventListener("click", () => {
    state.showWatchpoints = !state.showWatchpoints;
    toggles.watchpoints.classList.toggle("active", state.showWatchpoints);
    renderWatchPoints();
  });

  fitScenarioBounds();
  renderAll();
  startPlayback();
})();
