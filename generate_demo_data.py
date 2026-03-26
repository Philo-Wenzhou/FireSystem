from __future__ import annotations

import json
import math
import random
from pathlib import Path

SEED = 20260326
COLS = 34
ROWS = 22
CELL_SIZE_KM = 0.8
LAT_STEP = 0.0155
LON_STEP = 0.0205
TIME_LABELS = [
    "06:00",
    "08:00",
    "10:00",
    "12:00",
    "14:00",
    "16:00",
    "18:00",
    "20:00",
]

VEG_TYPES = [
    ("pine_forest", "Pine Forest", "#1f6b45", 0.24, 18.0, 0.05, 0.50, "100h"),
    ("shrub", "Shrubland", "#5b8f3a", 0.30, 14.0, 0.08, 0.58, "10h"),
    ("grassland", "Grassland", "#c08a2b", 0.38, 11.0, 0.12, 0.72, "1h"),
    ("mixed", "Mixed Cover", "#2f7d5b", 0.28, 15.0, 0.07, 0.56, "10h"),
]

PALETTE = {1: "#4BC27B", 2: "#A7DB5A", 3: "#F2C94C", 4: "#F2994A", 5: "#EB5757"}

SCENARIOS = [
    {
        "id": "sichuan",
        "name": "Sichuan Public Demo",
        "subtitle": "Synthetic mountain warning board for a broad Sichuan upland setting.",
        "base_lat": 30.88,
        "base_lon": 103.84,
        "elevation_shift": 120.0,
        "heat_bias": 0.1,
        "humidity_bias": -2.0,
        "rain_bias": 0.2,
        "village_names": {
            (0, 0): "West Upland",
            (1, 0): "Cloud Cedar",
            (2, 0): "Stone Basin",
            (0, 1): "Red Slope",
            (1, 1): "Watch Ridge",
            (2, 1): "South Hollow",
        },
        "watch_points": [
            {"name": "West Upland Tower", "col": 6, "row": 4, "coverage_km": 6.0},
            {"name": "Cloud Cedar Station", "col": 16, "row": 10, "coverage_km": 5.2},
            {"name": "South Hollow Hub", "col": 28, "row": 17, "coverage_km": 5.8},
        ],
        "corridors": [
            ("Ridge Corridor Alpha", [(1, 3), (4, 4), (8, 6), (12, 7), (17, 8), (22, 10), (28, 11), (32, 13)]),
            ("Valley Corridor Beta", [(2, 18), (6, 17), (10, 16), (14, 15), (19, 13), (24, 12), (31, 11)]),
            ("East Spur Gamma", [(22, 3), (23, 5), (24, 8), (25, 11), (26, 14), (28, 17), (31, 20)]),
            ("South Arc Delta", [(4, 20), (7, 19), (11, 18), (16, 17), (21, 17), (26, 18), (31, 19)]),
        ],
    },
    {
        "id": "australia",
        "name": "Australia Public Demo",
        "subtitle": "Synthetic bushfire warning board for a broad southeast Australia setting.",
        "base_lat": -36.12,
        "base_lon": 148.26,
        "elevation_shift": -80.0,
        "heat_bias": 1.8,
        "humidity_bias": -5.5,
        "rain_bias": -0.35,
        "village_names": {
            (0, 0): "Blue Gum Ridge",
            (1, 0): "Ironbark Flat",
            (2, 0): "Snowgrass Bend",
            (0, 1): "Ash Creek",
            (1, 1): "Stringybark Watch",
            (2, 1): "South Range",
        },
        "watch_points": [
            {"name": "Blue Gum Tower", "col": 5, "row": 5, "coverage_km": 6.3},
            {"name": "Ash Creek Patrol", "col": 17, "row": 9, "coverage_km": 5.4},
            {"name": "South Range Staging", "col": 29, "row": 16, "coverage_km": 6.0},
        ],
        "corridors": [
            ("Foothill Corridor Alpha", [(1, 4), (5, 5), (9, 7), (13, 8), (18, 8), (24, 9), (30, 11), (33, 13)]),
            ("Creekline Beta", [(2, 19), (7, 18), (11, 16), (15, 15), (20, 14), (26, 13), (32, 11)]),
            ("East Ash Gamma", [(21, 2), (22, 4), (23, 7), (24, 10), (25, 13), (27, 16), (31, 20)]),
            ("Southern Sweep Delta", [(3, 20), (7, 19), (12, 18), (17, 18), (22, 17), (27, 18), (32, 19)]),
        ],
    },
]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value))


def emc_simard(temp_c: float, humidity: float) -> float:
    h = clamp(humidity, 0.0, 100.0)
    if h < 10.0:
        emc = 0.03229 + 0.351073 * h - 0.000578 * h * temp_c
    elif h < 50.0:
        emc = 3.22749 + 0.200107 * h - 0.01478 * temp_c
    else:
        emc = 25.0606 + 0.006565 * (h ** 2) - 0.00035 * h * temp_c - 0.423199 * h
    return clamp(emc, 0.0, 60.0)


def fuel_moisture(emc: float, rain_mm: float, time_key: str) -> float:
    base = {"1h": emc * 0.72, "10h": emc * 0.88, "100h": emc * 1.05}[time_key]
    wetting = {"1h": 1.8, "10h": 1.4, "100h": 1.0}[time_key] * rain_mm
    return clamp(base + wetting, 2.0, 32.0)


def build_elevation(col: int, row: int, rng: random.Random, scenario: dict) -> float:
    x = col / (COLS - 1)
    y = row / (ROWS - 1)
    ridge_1 = 980 * math.exp(-((x - 0.28) ** 2 / 0.012 + (y - 0.38) ** 2 / 0.08))
    ridge_2 = 760 * math.exp(-((x - 0.72) ** 2 / 0.018 + (y - 0.60) ** 2 / 0.05))
    ridge_3 = 420 * math.exp(-((x - 0.52) ** 2 / 0.05 + (y - 0.18) ** 2 / 0.03))
    waves = 220 * math.sin(x * 6.4) + 140 * math.cos(y * 7.2) + 110 * math.sin((x + y) * 9.0)
    noise = rng.uniform(-35, 35)
    return max(520.0, 1650.0 + scenario["elevation_shift"] + ridge_1 + ridge_2 + ridge_3 + waves + noise)


def choose_vegetation(elevation: float, slope_deg: float, dryness_bias: float):
    if elevation > 2500 and slope_deg > 24:
        return VEG_TYPES[2]
    if dryness_bias > 0.6:
        return VEG_TYPES[2]
    if elevation > 2200:
        return VEG_TYPES[0]
    if slope_deg < 10:
        return VEG_TYPES[3]
    return VEG_TYPES[1]


def risk_level(score: float, wind_ms: float, rain_mm: float) -> int:
    if score < 0.20:
        level = 1
    elif score < 0.50:
        level = 2
    elif score < 0.75:
        level = 3
    elif score < 0.90:
        level = 4
    else:
        level = 5
    if wind_ms > 14.0:
        level = min(level + 1, 5)
    if rain_mm > 15.0:
        level = 1
    elif rain_mm > 5.0:
        level = max(level - 1, 1)
    return level


def cell_latlon(col: int, row: int, scenario: dict) -> tuple[float, float]:
    lat = scenario["base_lat"] + (ROWS - 1 - row) * LAT_STEP
    lon = scenario["base_lon"] + col * LON_STEP
    return lat, lon


def village_name(col: int, row: int, scenario: dict) -> str:
    x_band = min(col * 3 // COLS, 2)
    y_band = min(row * 2 // ROWS, 1)
    return scenario["village_names"][(x_band, y_band)]


def build_base_cells(scenario: dict) -> tuple[list[dict], dict[str, dict], list[dict]]:
    rng = random.Random(SEED + sum(ord(ch) for ch in scenario["id"]))
    elevation = [[build_elevation(c, r, rng, scenario) for c in range(COLS)] for r in range(ROWS)]
    cells = []
    villages: dict[str, dict] = {}

    for row in range(ROWS):
        for col in range(COLS):
            left = elevation[row][max(col - 1, 0)]
            right = elevation[row][min(col + 1, COLS - 1)]
            up = elevation[max(row - 1, 0)][col]
            down = elevation[min(row + 1, ROWS - 1)][col]
            dzdx = (right - left) / (2 * CELL_SIZE_KM * 1000)
            dzdy = (down - up) / (2 * CELL_SIZE_KM * 1000)
            slope_deg = math.degrees(math.atan(math.sqrt(dzdx * dzdx + dzdy * dzdy) * 7.5))
            aspect_deg = (math.degrees(math.atan2(dzdy, -dzdx)) + 360.0) % 360.0
            ridge_exposure = 0.5 + 0.5 * math.sin((col / COLS) * math.pi * 2.4)
            valley_channel = 0.5 + 0.5 * math.cos((row / ROWS) * math.pi * 1.6)
            wind_ms = clamp(4.2 + ridge_exposure * 4.2 + slope_deg / 18 + rng.uniform(-0.8, 0.8), 1.2, 14.0)
            humidity = clamp(64 - ridge_exposure * 16 - slope_deg * 0.25 + valley_channel * 6 + scenario["humidity_bias"] + rng.uniform(-3.0, 3.0), 18, 88)
            temp_c = clamp(23 - elevation[row][col] / 480 + ridge_exposure * 2.4 + scenario["heat_bias"] + rng.uniform(-1.0, 1.0), 8, 32)
            rain_mm = clamp(max(0.0, 1.2 - ridge_exposure * 0.8 + valley_channel * 0.7 + scenario["rain_bias"] + rng.uniform(-0.4, 0.4)), 0.0, 4.8)
            dryness_bias = clamp((100 - humidity) / 100 + wind_ms / 20, 0.0, 1.0)
            veg_code, veg_label, veg_color, p0, mc_ref, kw, fuel_base, dfmc_key = choose_vegetation(elevation[row][col], slope_deg, dryness_bias)
            clearance_distance = clamp(2.2 + (1 - dryness_bias) * 4.0 + valley_channel * 1.3 + rng.uniform(-0.7, 0.7), 0.7, 7.8)
            patrol_access = clamp(8.7 - slope_deg / 8.5 - ridge_exposure * 2.2 + rng.uniform(-0.6, 0.6), 2.8, 9.4)
            lat, lon = cell_latlon(col, row, scenario)
            cell = {
                "id": f"{scenario['id'].upper()}_C{row:02d}_{col:02d}",
                "col": col,
                "row": row,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "elevation_m": round(elevation[row][col], 1),
                "slope_deg": round(slope_deg, 1),
                "aspect_deg": round(aspect_deg, 1),
                "base_wind_ms": round(wind_ms, 1),
                "base_humidity_pct": round(humidity, 1),
                "base_temp_c": round(temp_c, 1),
                "base_rain_mm": round(rain_mm, 1),
                "clearance_m": round(clearance_distance, 1),
                "access_score": round(patrol_access, 1),
                "ridge_exposure": round(ridge_exposure, 3),
                "valley_channel": round(valley_channel, 3),
                "vegetation": {
                    "code": veg_code,
                    "label": veg_label,
                    "color": veg_color,
                    "p0": p0,
                    "mc_ref": mc_ref,
                    "kw": kw,
                    "fuel_base": fuel_base,
                    "dfmc_key": dfmc_key,
                },
                "village": village_name(col, row, scenario),
            }
            cells.append(cell)
            village = villages.setdefault(cell["village"], {"name": cell["village"], "cell_ids": [], "population": rng.randint(800, 3200)})
            village["cell_ids"].append(cell["id"])

    watch_points = []
    for point in scenario["watch_points"]:
        lat, lon = cell_latlon(point["col"], point["row"], scenario)
        watch_points.append({**point, "lat": round(lat, 6), "lon": round(lon, 6)})

    return cells, villages, watch_points


def catmull_rom(points: list[tuple[float, float]], samples_per_seg: int = 12) -> list[list[float]]:
    if len(points) < 2:
        return [[points[0][0], points[0][1]]] if points else []
    extended = [points[0], *points, points[-1]]
    result = []
    for i in range(1, len(extended) - 2):
        p0, p1, p2, p3 = extended[i - 1], extended[i], extended[i + 1], extended[i + 2]
        for step in range(samples_per_seg):
            t = step / samples_per_seg
            t2 = t * t
            t3 = t2 * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            result.append([round(x, 6), round(y, 6)])
    result.append([round(points[-1][0], 6), round(points[-1][1], 6)])
    return result


def build_corridors(scenario: dict) -> list[dict]:
    corridors = []
    for corridor_id, nodes in scenario["corridors"]:
        latlon_nodes = []
        for col, row in nodes:
            lat, lon = cell_latlon(col, row, scenario)
            latlon_nodes.append((lat, lon))
        smooth_latlon = catmull_rom(latlon_nodes, 10)
        geometry = [[pt[1], pt[0]] for pt in smooth_latlon]
        corridors.append({"id": corridor_id, "geometry": {"type": "LineString", "coordinates": geometry}, "anchors": nodes})
    return corridors


def dynamic_weather(base: dict, time_index: int, scenario: dict) -> tuple[float, float, float, float]:
    phase = time_index / (len(TIME_LABELS) - 1)
    midday = math.sin(phase * math.pi)
    late_burst = math.exp(-((phase - 0.8) ** 2) / 0.02)
    wind = clamp(base["base_wind_ms"] + 1.8 * midday + base["ridge_exposure"] * 2.0 * midday + late_burst * 1.0 + scenario["heat_bias"] * 0.2, 0.8, 18.5)
    humidity = clamp(base["base_humidity_pct"] - 13.0 * midday - base["ridge_exposure"] * 4.0 * midday + base["valley_channel"] * 2.0 + scenario["humidity_bias"] * 0.2, 15.0, 95.0)
    temp = clamp(base["base_temp_c"] + 5.6 * midday + base["ridge_exposure"] * 0.8 + scenario["heat_bias"], 6.0, 36.0)
    rain = clamp(base["base_rain_mm"] + scenario["rain_bias"] + (1.8 if time_index == len(TIME_LABELS) - 1 else 0.0) - 0.7 * midday, 0.0, 8.0)
    return wind, humidity, temp, rain


def build_frames(cells: list[dict], villages: dict[str, dict], corridors: list[dict], scenario: dict) -> list[dict]:
    cell_lookup = {(cell["row"], cell["col"]): cell for cell in cells}
    frames = []
    for idx, label in enumerate(TIME_LABELS):
        frame_cells = []
        village_stats: dict[str, dict] = {}
        for cell in cells:
            wind_ms, humidity, temp_c, rain_mm = dynamic_weather(cell, idx, scenario)
            emc = emc_simard(temp_c, humidity)
            dfmc_1h = fuel_moisture(emc, rain_mm, "1h")
            dfmc_10h = fuel_moisture(emc, rain_mm, "10h")
            dfmc_100h = fuel_moisture(emc, rain_mm, "100h")
            key = cell["vegetation"]["dfmc_key"]
            moist_selected = {"1h": dfmc_1h, "10h": dfmc_10h, "100h": dfmc_100h}[key]
            p0 = cell["vegetation"]["p0"]
            mc_ref = cell["vegetation"]["mc_ref"]
            kw = cell["vegetation"]["kw"]
            fuel_base = cell["vegetation"]["fuel_base"]
            z = 0.38 * wind_ms + 2.9 * math.exp(-((cell["clearance_m"] - 0.8) ** 2) / (2 * 2.5 ** 2)) + 0.11 * (10 - cell["access_score"]) - 6.2
            p_trigger = clamp(sigmoid(z), 0.0001, 0.95)
            f_d = math.exp(-cell["clearance_m"] / 5.0)
            f_m = math.exp(-moist_selected / mc_ref)
            f_w = math.exp(kw * wind_ms)
            p_ignite = clamp(sigmoid(5.0 * (p0 * f_d * f_m * f_w - 0.32)), 0.0, 1.0)
            ws_lim = clamp(wind_ms, 0.0, 12.0)
            slope_lim = clamp(cell["slope_deg"], 0.0, 35.0)
            term_ws = math.exp(0.8 * fuel_base * ws_lim)
            term_slope = math.exp(2.0 * math.tan(math.radians(slope_lim)))
            term_moist = math.exp(-0.15 * clamp(moist_selected, 0.0, 35.0))
            p_spread = clamp(0.18 * term_moist * (1 + 0.012 * term_ws) * (1 + 0.018 * term_slope), 0.0, 1.0)
            final_risk = clamp(1 - (1 - p_trigger) * (1 - p_ignite) * (1 - p_spread), 0.0, 1.0)
            level = risk_level(final_risk, wind_ms, rain_mm)
            hotspot = final_risk > 0.78 or (wind_ms > 12.5 and moist_selected < 8.5)
            record = {
                "id": cell["id"],
                "wind_ms": round(wind_ms, 1),
                "humidity_pct": round(humidity, 1),
                "temp_c": round(temp_c, 1),
                "rain_mm": round(rain_mm, 1),
                "dfmc_selected": round(moist_selected, 2),
                "dfmc_key": key,
                "p_trigger": round(p_trigger, 4),
                "p_ignite": round(p_ignite, 4),
                "p_spread": round(p_spread, 4),
                "final_risk": round(final_risk, 4),
                "level": level,
                "color": PALETTE[level],
                "hotspot": hotspot,
            }
            frame_cells.append(record)
            stat = village_stats.setdefault(cell["village"], {"sum": 0.0, "max": 0.0, "hotspots": 0, "count": 0})
            stat["sum"] += final_risk
            stat["max"] = max(stat["max"], final_risk)
            stat["hotspots"] += 1 if hotspot else 0
            stat["count"] += 1

        risk_map = {cell["id"]: cell["final_risk"] for cell in frame_cells}
        corridor_frames = []
        for corridor in corridors:
            coords = corridor["geometry"]["coordinates"]
            segment_styles = []
            segment_risks = []
            for i in range(len(coords) - 1):
                lon_a, lat_a = coords[i]
                lon_b, lat_b = coords[i + 1]
                col_a = int(round((lon_a - scenario["base_lon"]) / LON_STEP))
                row_a = int(round((scenario["base_lat"] + (ROWS - 1) * LAT_STEP - lat_a) / LAT_STEP))
                col_b = int(round((lon_b - scenario["base_lon"]) / LON_STEP))
                row_b = int(round((scenario["base_lat"] + (ROWS - 1) * LAT_STEP - lat_b) / LAT_STEP))
                col = max(0, min(COLS - 1, int(round((col_a + col_b) / 2))))
                row = max(0, min(ROWS - 1, int(round((row_a + row_b) / 2))))
                cell = cell_lookup[(row, col)]
                local_risk = risk_map[cell["id"]]
                segment_risks.append(local_risk)
                level = risk_level(local_risk, 10.0, 0.0)
                segment_styles.append({
                    "coords": [[lat_a, lon_a], [lat_b, lon_b]],
                    "risk": round(local_risk, 4),
                    "level": level,
                    "color": PALETTE[level],
                    "weight": round(2.5 + local_risk * 8.5, 2),
                })
            mean_risk = sum(segment_risks) / len(segment_risks)
            corridor_frames.append({
                "id": corridor["id"],
                "risk": round(mean_risk, 4),
                "level": risk_level(mean_risk, 10.0, 0.0),
                "segment_styles": segment_styles,
            })

        village_frame = []
        for village in villages.values():
            stat = village_stats[village["name"]]
            score = clamp((stat["sum"] / stat["count"]) * 0.65 + stat["max"] * 0.35, 0.0, 1.0)
            level = risk_level(score, 9.0 + stat["hotspots"] * 0.5, 0.0)
            village_frame.append({
                "name": village["name"],
                "cells": len(village["cell_ids"]),
                "population": village["population"],
                "hotspots": stat["hotspots"],
                "score": round(score, 4),
                "level": level,
                "color": PALETTE[level],
            })
        village_frame.sort(key=lambda item: item["score"], reverse=True)

        frames.append({
            "timestamp": label,
            "summary": {
                "max_risk": max(cell["final_risk"] for cell in frame_cells),
                "mean_risk": round(sum(cell["final_risk"] for cell in frame_cells) / len(frame_cells), 4),
                "hotspot_count": sum(1 for cell in frame_cells if cell["hotspot"]),
                "high_risk_cells": sum(1 for cell in frame_cells if cell["level"] >= 4),
            },
            "cells": frame_cells,
            "corridors": corridor_frames,
            "villages": village_frame,
        })
    return frames


def build_scenario_dataset(scenario: dict) -> dict:
    cells, villages, watch_points = build_base_cells(scenario)
    corridors = build_corridors(scenario)
    frames = build_frames(cells, villages, corridors, scenario)
    return {
        "id": scenario["id"],
        "name": scenario["name"],
        "subtitle": scenario["subtitle"],
        "meta": {
            "rows": ROWS,
            "cols": COLS,
            "cell_size_km": CELL_SIZE_KM,
            "base_lat": scenario["base_lat"],
            "base_lon": scenario["base_lon"],
            "lat_step": LAT_STEP,
            "lon_step": LON_STEP,
            "note": "All terrain, place labels, corridors, weather and hazards are synthetic and generated in code.",
        },
        "cells": cells,
        "watch_points": watch_points,
        "corridors": corridors,
        "frames": frames,
    }


def build_dataset() -> dict:
    return {
        "meta": {
            "name": "Mountain Fire Warning Demo",
            "seed": SEED,
            "scenarios": [scenario["id"] for scenario in SCENARIOS],
            "note": "Public-safe synthetic wildfire warning demonstration with multiple regional storyboards.",
        },
        "scenarios": [build_scenario_dataset(scenario) for scenario in SCENARIOS],
    }


def main() -> None:
    dataset = build_dataset()
    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    json_path = data_dir / "simulated_risk_map.json"
    js_path = data_dir / "simulated_risk_map.js"
    payload = json.dumps(dataset, ensure_ascii=False, indent=2)
    json_path.write_text(payload, encoding="utf-8")
    js_path.write_text(f"window.DATASET = {payload};\n", encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {js_path}")


if __name__ == "__main__":
    main()
