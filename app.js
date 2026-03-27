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
  const indicatorChartEl = document.getElementById("indicator-chart");
  const layerSelect = document.getElementById("layer-select");
  const mapModeLabel = document.getElementById("map-mode-label");
  const timeSlider = document.getElementById("time-slider");
  const timeLabel = document.getElementById("time-label");
  const playBtn = document.getElementById("play-btn");
  const mapPopupCard = document.getElementById("map-popup-card");
  const viewSwitchButtons = Array.from(document.querySelectorAll("#view-switch [data-view]"));
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
    const frames = scenario().frames;
    const safeIndex = ((frameIndex % frames.length) + frames.length) % frames.length;
    return Object.fromEntries(frames[safeIndex].cells.map((cell) => [cell.id, cell]));
  }

  function resetSelection() {
    const firstCell = scenario().cells[0] || null;
    state.selectedCellId = firstCell ? firstCell.id : null;
    state.selectedCorridorId = null;
  }

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
    return { 1: "Low", 2: "Level 2", 3: "Elevated", 4: "High", 5: "Severe" }[level] || "Unknown";
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
    if (current.level >= 5) return "Immediate patrol and suppression staging are recommended.";
    if (current.level >= 4) return "Increase inspection frequency and prepare rapid response teams.";
    if (current.level >= 3) return "Maintain active watch during the current time window.";
    return "Routine watch is sufficient under the current conditions.";
  }

  function nearestBaseCell(lat, lon) {
    return scenario().cells.reduce((best, cell) => {
      if (!best) return cell;
      const d1 = (cell.lat - lat) ** 2 + (cell.lon - lon) ** 2;
      const d2 = (best.lat - lat) ** 2 + (best.lon - lon) ** 2;
      return d1 < d2 ? cell : best;
    }, null);
  }

  function corridorAnchorCell(corridor) {
    if (!corridor || !corridor.segment_styles || !corridor.segment_styles.length) return scenario().cells[0] || null;
    const coords = corridor.segment_styles[0].coords || [];
    const mid = coords[Math.floor(coords.length / 2)] || coords[0];
    return mid ? nearestBaseCell(mid[0], mid[1]) : scenario().cells[0] || null;
  }

  function getSelectedCellContext() {
    if (state.selectedCorridorId) {
      const corridor = currentFrame().corridors.find((item) => item.id === state.selectedCorridorId);
      const anchor = corridorAnchorCell(corridor);
      if (!anchor) return null;
      return { base: anchor, current: frameCellMap(state.frameIndex)[anchor.id] };
    }
    const base = baseCellMap()[state.selectedCellId] || scenario().cells[0] || null;
    if (!base) return null;
    return { base, current: frameCellMap(state.frameIndex)[base.id] };
  }

  function cellBounds(base) {
    const halfLat = scenario().meta.lat_step / 2;
    const halfLon = scenario().meta.lon_step / 2;
    return [[base.lat - halfLat, base.lon - halfLon], [base.lat + halfLat, base.lon + halfLon]];
  }

  function scenarioBounds() {
    return L.geoJSON(scenario().boundary).getBounds();
  }

  function boundaryCoordinateSets() {
    const geometry = scenario().boundary.geometry;
    if (!geometry) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates];
    if (geometry.type === "MultiPolygon") return geometry.coordinates;
    return [];
  }

  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInBoundary(lat, lon) {
    return boundaryCoordinateSets().some((polygon) => {
      if (!polygon.length) return false;
      if (!pointInRing(lat, lon, polygon[0])) return false;
      for (let i = 1; i < polygon.length; i += 1) {
        if (pointInRing(lat, lon, polygon[i])) return false;
      }
      return true;
    });
  }

  const map = L.map("map", { zoomControl: true, preferCanvas: true });
  map.createPane("terrainPane");
  map.createPane("boundaryPane");
  map.createPane("heatPane");
  map.createPane("cellPane");
  map.createPane("selectionPane");
  map.createPane("corridorPane");
  map.createPane("watchPane");
  map.getPane("terrainPane").style.zIndex = 320;
  map.getPane("boundaryPane").style.zIndex = 330;
  map.getPane("heatPane").style.zIndex = 340;
  map.getPane("cellPane").style.zIndex = 350;
  map.getPane("selectionPane").style.zIndex = 360;
  map.getPane("corridorPane").style.zIndex = 470;
  map.getPane("watchPane").style.zIndex = 390;
  map.getPane("terrainPane").style.pointerEvents = "none";
  map.getPane("boundaryPane").style.pointerEvents = "none";
  map.getPane("heatPane").style.pointerEvents = "none";
  map.getPane("cellPane").style.pointerEvents = "none";
  map.getPane("selectionPane").style.pointerEvents = "none";
  map.getPane("watchPane").style.pointerEvents = "none";

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
  const selectionLayer = L.layerGroup().addTo(map);
  const hotspotLayer = L.layerGroup().addTo(map);
  const corridorLayer = L.layerGroup().addTo(map);
  const watchLayer = L.layerGroup().addTo(map);
  let heatLayer = null;

  const palette = {
    risk: (_base, dynamic) => dynamic.color,
    elevation: (base) => gradient(base.elevation_m, 200, 3600, ["#17324a", "#2f7d5b", "#d6b96d", "#f6ead2"]),
    slope: (base) => gradient(base.slope_deg, 0, 35, ["#17324a", "#1e8a70", "#f2c94c", "#eb5757"]),
    wind: (_base, dynamic) => gradient(dynamic.wind_ms, 0, 18, ["#21435a", "#2d7fb6", "#7dd8c2", "#f6d365"]),
    dryness: (_base, dynamic) => gradient(dynamic.dfmc_selected, 0, 22, ["#2c5d46", "#7ba943", "#f3b13a", "#dd5c3d"]),
  };

  function fitScenarioBounds() {
    const bounds = scenarioBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.04), { animate: false });
  }

  function updateScenarioHeader() {
    mapTitleEl.textContent = scenario().name;
    scenarioSubtitleEl.textContent = "Click anywhere inside the calculation range to inspect the nearest synthetic risk cell.";
    villageTitleEl.textContent = state.scenarioId === "sichuan" ? "Province Aggregation" : "State Aggregation";
  }

  function renderScenarioSwitch() {
    scenarioSwitchEl.innerHTML = scenarios.map((item) => `
      <button class="chip ${item.id === state.scenarioId ? "active" : ""}" data-scenario-id="${item.id}">${item.name}</button>
    `).join("");
    scenarioSwitchEl.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => switchScenario(button.dataset.scenarioId));
    });
  }

  function renderViewSwitch() {
    viewSwitchButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.view === state.view);
    });
    const active = viewSwitchButtons.find((button) => button.dataset.view === state.view);
    mapModeLabel.textContent = active ? active.textContent : "Heatmap";
  }

  function renderBoundary() {
    boundaryLayer.clearLayers();
    boundaryLayer.addLayer(L.geoJSON(scenario().boundary, {
      pane: "boundaryPane",
      style: {
        color: "#d7efe8",
        weight: 1.6,
        opacity: 0.82,
        fillColor: "#54737a",
        fillOpacity: state.view === "terrain" ? 0.08 : 0.02,
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
        fillOpacity: state.view === "terrain" ? 0.42 : 0.12,
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
  }

  function metricCard(label, value) {
    return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function renderMetrics() {
    const summary = currentFrame().summary;
    metricsEl.innerHTML = [
      metricCard("High-risk Cells", `${summary.high_risk_cells}`),
      metricCard("Level-2 Cells", `${currentFrame().cells.filter((cell) => cell.level === 2).length}`),
      metricCard("Average Risk", `${(summary.mean_risk * 100).toFixed(1)}%`),
      metricCard("Peak Risk", `${(summary.max_risk * 100).toFixed(1)}%`),
    ].join("");
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
      gradient: { 0.05: "#225b80", 0.25: "#2bb3a3", 0.5: "#f2c94c", 0.75: "#f2994a", 1.0: "#eb5757" },
      minOpacity: 0.24,
    }).addTo(map);
  }

  function renderCells() {
    cellLayer.clearLayers();
    hotspotLayer.clearLayers();
    const dyn = frameCellMap(state.frameIndex);
    const shouldShowCells = state.view === "cells" || state.view === "terrain";
    for (const base of scenario().cells) {
      const current = dyn[base.id];
      if (!current) continue;
      if (shouldShowCells) {
        const fillMode = state.view === "terrain" ? "elevation" : state.layer;
        cellLayer.addLayer(L.rectangle(cellBounds(base), {
          pane: "cellPane",
          stroke: true,
          weight: 0.2,
          color: "rgba(255,255,255,0.10)",
          fillColor: palette[fillMode](base, current),
          fillOpacity: state.view === "terrain" ? 0.28 : 0.34,
          interactive: false,
        }));
      }
      if (state.showHotspots && current.hotspot) {
        hotspotLayer.addLayer(L.circle([base.lat, base.lon], {
          pane: "cellPane",
          radius: 7000,
          color: current.color,
          weight: 1,
          opacity: 0.16,
          fillColor: current.color,
          fillOpacity: 0.06,
          interactive: false,
        }));
      }
    }
  }

  function renderSelection() {
    selectionLayer.clearLayers();
    const ctx = getSelectedCellContext();
    if (!ctx || !ctx.base || !ctx.current) return;
    selectionLayer.addLayer(L.rectangle(cellBounds(ctx.base), {
      pane: "selectionPane",
      stroke: true,
      weight: 2,
      color: "#fff3cc",
      fillColor: ctx.current.color,
      fillOpacity: state.view === "cells" || state.view === "terrain" ? 0.08 : 0,
      interactive: false,
    }));
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
          interactive: false,
        });
        const line = L.polyline(segment.coords, {
          pane: "corridorPane",
          color: segment.color,
          weight: selected ? segment.weight + 2 : segment.weight,
          opacity: 0.9,
          className: selected ? "corridor-segment-selected corridor-segment-main" : "corridor-segment-main",
          lineCap: "round",
          lineJoin: "round",
        });
        line.on("click", (event) => {
          if (event.originalEvent) {
            L.DomEvent.stopPropagation(event.originalEvent);
            L.DomEvent.preventDefault(event.originalEvent);
          }
          state.selectedCorridorId = corridor.id;
          const anchor = corridorAnchorCell(current);
          state.selectedCellId = anchor ? anchor.id : state.selectedCellId;
          renderAll();
          updateMapPopup();
        });
        corridorLayer.addLayer(glow);
        corridorLayer.addLayer(line);
      }
    }
  }

  function renderWatchZones() {
    watchLayer.clearLayers();
    if (!state.showWatchpoints) return;
    for (const point of scenario().watch_points || []) {
      watchLayer.addLayer(L.circle([point.lat, point.lon], {
        pane: "watchPane",
        radius: point.coverage_km * 5000,
        color: "#7dd8c2",
        weight: 1,
        opacity: 0.24,
        fillColor: "#7dd8c2",
        fillOpacity: 0.03,
        interactive: false,
      }));
    }
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
        risk, wind, humidity, rain, spread, dryness, level,
        color: [null, "#4BC27B", "#A7DB5A", "#F2C94C", "#F2994A", "#EB5757"][level],
      });
    }
    return hourly;
  }

  function level2Distribution(base) {
    const currentMap = frameCellMap(state.frameIndex);
    const latSpan = scenario().meta.lat_step * 2.4;
    const lonSpan = scenario().meta.lon_step * 2.4;
    const nearby = scenario().cells.filter((cell) => Math.abs(cell.lat - base.lat) <= latSpan && Math.abs(cell.lon - base.lon) <= lonSpan);
    const level2Cells = nearby.filter((cell) => (currentMap[cell.id] || {}).level === 2);
    const highCells = nearby.filter((cell) => ((currentMap[cell.id] || {}).level || 0) >= 4);
    return {
      nearbyCount: nearby.length,
      level2Count: level2Cells.length,
      level2Ratio: nearby.length ? level2Cells.length / nearby.length : 0,
      highCount: highCells.length,
    };
  }

  function trendDescription(hourly) {
    const start = hourly[0].risk;
    const end = hourly[hourly.length - 1].risk;
    const peak = hourly.reduce((max, item) => Math.max(max, item.risk), 0);
    if (peak >= 0.88) return "The next 8 hours keep the location in a severe window, with peak pressure near the top of the forecast range.";
    if (end - start >= 0.12) return "Risk is projected to climb through the next 8 hours as wind and dryness continue to reinforce spread potential.";
    if (start - end >= 0.12) return "Risk gradually eases through the next 8 hours, though localized flare-up potential remains present.";
    return "Risk stays broadly stable through the next 8 hours, with moderate hour-to-hour fluctuation.";
  }

  function buildRiskSparkline(hourly) {
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

  function renderIndicatorChart(hourly) {
    const width = 280;
    const height = 180;
    const padLeft = 30;
    const padRight = 12;
    const padTop = 12;
    const padBottom = 24;
    const xAt = (index) => padLeft + (index * (width - padLeft - padRight)) / Math.max(hourly.length - 1, 1);
    const yFrom = (value, min, max) => padTop + (1 - ((value - min) / (max - min))) * (height - padTop - padBottom);
    const series = [
      { key: "humidity", color: "#66d1ff", min: 20, max: 100 },
      { key: "dryness", color: "#f2c94c", min: 0, max: 22 },
      { key: "wind", color: "#ff8a6c", min: 0, max: 20 },
    ];
    const grid = [0, 0.25, 0.5, 0.75, 1].map((tick) => {
      const y = (padTop + tick * (height - padTop - padBottom)).toFixed(1);
      return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="rgba(173,220,216,0.12)" stroke-width="1" />`;
    }).join("");
    const paths = series.map((serie) => {
      const d = hourly.map((item, index) => {
        const x = xAt(index).toFixed(1);
        const y = yFrom(item[serie.key], serie.min, serie.max).toFixed(1);
        return `${index === 0 ? "M" : "L"}${x} ${y}`;
      }).join(" ");
      return `<path d="${d}" fill="none" stroke="${serie.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>`;
    }).join("");
    const labels = hourly.map((item, index) => `<text x="${xAt(index).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="rgba(238,245,239,0.64)" font-size="10">${item.label}</text>`).join("");
    indicatorChartEl.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" width="100%" height="180" aria-label="Indicator chart">
        ${grid}
        ${paths}
        ${labels}
      </svg>
    `;
  }

  function renderForecastPanel() {
    const ctx = getSelectedCellContext();
    if (!ctx || !ctx.base || !ctx.current) {
      forecastEl.innerHTML = `<div class="forecast-empty">Forecast preview will appear after you click a sector inside the calculation range.</div>`;
      indicatorChartEl.innerHTML = "";
      return;
    }
    const hourly = buildHourlyForecast(ctx.base.id);
    renderIndicatorChart(hourly);
    forecastEl.innerHTML = `
      <div class="forecast-card-header">
        <strong>${ctx.base.village}</strong>
        <span>${state.selectedCorridorId ? "Corridor anchor forecast" : "Selected sector forecast"}</span>
      </div>
      ${buildRiskSparkline(hourly)}
      <div class="forecast-empty">${trendDescription(hourly)}</div>
      <div class="forecast-grid">
        ${hourly.map((item) => `
          <div class="forecast-item">
            <div class="forecast-top"><strong>+${item.offsetHour}h</strong><span>${item.label}</span></div>
            <div class="forecast-risk-row"><span class="forecast-chip" style="background:${item.color};">${riskLabel(item.level)}</span><strong>${(item.risk * 100).toFixed(0)}%</strong></div>
            <p>Wind ${item.wind.toFixed(1)} m/s / Humidity ${item.humidity.toFixed(0)}% / Dryness ${item.dryness.toFixed(1)}</p>
          </div>
        `).join("")}
      </div>
    `;
  }

  function updateMapPopup() {
    const ctx = getSelectedCellContext();
    if (!ctx || !ctx.base || !ctx.current) {
      mapPopupCard.classList.add("hidden");
      mapPopupCard.innerHTML = "";
      return;
    }
    const distribution = level2Distribution(ctx.base);
    const hourly = buildHourlyForecast(ctx.base.id);
    const corridorNote = state.selectedCorridorId ? `<div class="map-popup-sub">Linked corridor: ${state.selectedCorridorId}</div>` : `<div class="map-popup-sub">Nearest sector picked from the synthetic calculation range.</div>`;
    mapPopupCard.innerHTML = `
      <div class="map-popup-title">
        <strong>${ctx.base.village}</strong>
        <span class="pill" style="background:${ctx.current.color};">${riskLabel(ctx.current.level)}</span>
      </div>
      ${corridorNote}
      <div class="map-popup-grid">
        <div class="map-popup-item"><span>Current Risk</span><strong>${(ctx.current.final_risk * 100).toFixed(1)}%</strong></div>
        <div class="map-popup-item"><span>Level-2 Footprint</span><strong>${distribution.level2Count}/${distribution.nearbyCount} nearby cells</strong></div>
        <div class="map-popup-item"><span>Main Drivers</span><strong>${cellDrivers(ctx.base, ctx.current).join(", ")}</strong></div>
        <div class="map-popup-item"><span>Next 8 Hours</span><strong>${trendDescription(hourly)}</strong></div>
      </div>
      <div class="map-popup-note">Wind ${ctx.current.wind_ms.toFixed(1)} m/s, humidity ${ctx.current.humidity_pct.toFixed(0)}%, fuel dryness ${ctx.current.dfmc_selected.toFixed(1)}. Suggested action: ${cellAction(ctx.current)}</div>
    `;
    mapPopupCard.classList.remove("hidden");
  }

  function renderDetail() {
    const ctx = getSelectedCellContext();
    if (!ctx || !ctx.base || !ctx.current) return;
    const distribution = level2Distribution(ctx.base);
    const hourly = buildHourlyForecast(ctx.base.id);
    const corridorHeader = state.selectedCorridorId ? `<div style="color: var(--muted); margin-top: 6px;">Corridor ${state.selectedCorridorId} is anchored to this sector for analysis.</div>` : `<div style="color: var(--muted); margin-top: 6px;">${ctx.base.vegetation.label} sector during ${currentFrame().timestamp}</div>`;
    detailEl.innerHTML = `
      <div class="detail-title">
        <div>
          <strong>${ctx.base.village}</strong>
          ${corridorHeader}
        </div>
        <span class="pill" style="background:${ctx.current.color};">${riskLabel(ctx.current.level)}</span>
      </div>
      <div class="detail-grid">
        <div class="detail-item"><span>Current Risk</span><strong>${(ctx.current.final_risk * 100).toFixed(1)}%</strong></div>
        <div class="detail-item"><span>Level-2 Distribution</span><strong>${distribution.level2Count}/${distribution.nearbyCount} nearby cells (${(distribution.level2Ratio * 100).toFixed(0)}%)</strong></div>
        <div class="detail-item"><span>Humidity</span><strong>${ctx.current.humidity_pct.toFixed(0)}%</strong></div>
        <div class="detail-item"><span>Wind Speed</span><strong>${ctx.current.wind_ms.toFixed(1)} m/s</strong></div>
        <div class="detail-item"><span>Fuel Condition</span><strong>${ctx.current.dfmc_selected.toFixed(1)} from ${ctx.current.dfmc_key}</strong></div>
        <div class="detail-item"><span>Terrain</span><strong>${ctx.base.elevation_m} m / ${ctx.base.slope_deg} deg</strong></div>
      </div>
      <div class="stack-bar">
        <div class="stack-row"><span>Trigger</span><div class="stack-track"><div class="stack-fill" style="width:${(ctx.current.p_trigger * 100).toFixed(1)}%; background:#7dd8c2;"></div></div><strong>${(ctx.current.p_trigger * 100).toFixed(0)}%</strong></div>
        <div class="stack-row"><span>Ignite</span><div class="stack-track"><div class="stack-fill" style="width:${(ctx.current.p_ignite * 100).toFixed(1)}%; background:#ffb84d;"></div></div><strong>${(ctx.current.p_ignite * 100).toFixed(0)}%</strong></div>
        <div class="stack-row"><span>Spread</span><div class="stack-track"><div class="stack-fill" style="width:${(ctx.current.p_spread * 100).toFixed(1)}%; background:#f26b5b;"></div></div><strong>${(ctx.current.p_spread * 100).toFixed(0)}%</strong></div>
      </div>
      <p style="margin:16px 0 0; color: var(--muted); line-height:1.5;">Main disaster factors: ${cellDrivers(ctx.base, ctx.current).join(", ")}. Forecast summary: ${trendDescription(hourly)}</p>
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
    renderViewSwitch();
    renderBoundary();
    renderTerrainBase();
    renderTimeHeader();
    renderAlertStrip();
    renderOverviewCards();
    renderMetrics();
    renderHeat();
    renderCells();
    renderSelection();
    renderCorridors();
    renderWatchZones();
    corridorLayer.eachLayer((layer) => { if (layer.bringToFront) layer.bringToFront(); });
    renderDetail();
    renderForecastPanel();
    renderVillages();
    updateMapPopup();
  }

  function setFrame(index) {
    state.frameIndex = (index + scenario().frames.length) % scenario().frames.length;
    renderAll();
  }

  function stopPlayback(updateHeader = true) {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    state.playing = false;
    if (updateHeader) renderTimeHeader();
  }

  function startPlayback() {
    stopPlayback(false);
    state.playing = true;
    state.timer = window.setInterval(() => setFrame(state.frameIndex + 1), 1600);
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
    params.set("scenario", id);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    fitScenarioBounds();
    renderAll();
    if (state.playing) startPlayback();
  }

  map.on("click", (event) => {
    const { lat, lng } = event.latlng;
    if (!pointInBoundary(lat, lng)) return;
    const nearest = nearestBaseCell(lat, lng);
    if (!nearest) return;
    state.selectedCellId = nearest.id;
    state.selectedCorridorId = null;
    renderAll();
  });

  viewSwitchButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      renderAll();
    });
  });

  layerSelect.addEventListener("change", (event) => {
    state.layer = event.target.value;
    renderCells();
    renderSelection();
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
    renderSelection();
  });

  toggles.watchpoints.addEventListener("click", () => {
    state.showWatchpoints = !state.showWatchpoints;
    toggles.watchpoints.classList.toggle("active", state.showWatchpoints);
    renderWatchZones();
  });

  resetSelection();
  fitScenarioBounds();
  renderAll();
  startPlayback();
})();

