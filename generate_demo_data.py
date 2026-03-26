from __future__ import annotations

import json
import math
import random
from pathlib import Path

SEED = 20260326
COLS = 42
ROWS = 30
TIME_LABELS = ["06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00"]

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
        "name": "Sichuan Province Public Demo",
        "subtitle": "Synthetic warning surface constrained to the public outline of Sichuan Province.",
        "country": "CHN",
        "shape_name": "Sichuan Province",
        "heat_bias": 0.3,
        "humidity_bias": -1.5,
        "rain_bias": 0.15,
        "village_names": ["West Upland", "Cloud Cedar", "Stone Basin", "Red Slope", "Watch Ridge", "South Hollow"],
        "watch_names": ["Western Watch Tower", "Central Patrol Station", "Southern Staging Hub"],
    },
    {
        "id": "queensland",
        "name": "Queensland Public Demo",
        "subtitle": "Synthetic bushfire warning surface constrained to the public outline of Queensland.",
        "country": "AUS",
        "shape_name": "Queensland",
        "heat_bias": 1.8,
        "humidity_bias": -5.0,
        "rain_bias": -0.3,
        "village_names": ["Blue Gum Ridge", "Ironbark Flat", "Dry Creek", "Sunline Range", "Coastal Watch", "South Interior"],
        "watch_names": ["North Corridor Tower", "Inland Patrol Base", "Southern Operations Hub"],
    },
    {
        "id": "newsouthwales",
        "name": "New South Wales Public Demo",
        "subtitle": "Synthetic bushfire warning surface constrained to the public outline of New South Wales.",
        "country": "AUS",
        "shape_name": "New South Wales",
        "heat_bias": 1.2,
        "humidity_bias": -3.8,
        "rain_bias": -0.15,
        "village_names": ["Ash Line", "Granite Creek", "Tableland North", "Red Gully", "Watch Coast", "South Basin"],
        "watch_names": ["Northern Lookout", "Central Patrol Base", "South Range Hub"],
    },
    {
        "id": "southaustralia",
        "name": "South Australia Public Demo",
        "subtitle": "Synthetic bushfire warning surface constrained to the public outline of South Australia.",
        "country": "AUS",
        "shape_name": "South Australia",
        "heat_bias": 2.1,
        "humidity_bias": -6.2,
        "rain_bias": -0.45,
        "village_names": ["Mallee Watch", "Saltbush Plain", "North Track", "Red Sand Rise", "Dryline Point", "Southern Sweep"],
        "watch_names": ["North Belt Tower", "Interior Patrol Base", "South Sweep Hub"],
    },
]

CORRIDOR_TEMPLATES = [
    [(0.08, 0.18), (0.18, 0.20), (0.30, 0.24), (0.42, 0.30), (0.56, 0.34), (0.70, 0.40), (0.84, 0.46)],
    [(0.12, 0.78), (0.24, 0.72), (0.38, 0.66), (0.52, 0.58), (0.66, 0.52), (0.80, 0.48), (0.90, 0.44)],
    [(0.68, 0.12), (0.66, 0.24), (0.64, 0.38), (0.66, 0.52), (0.74, 0.68), (0.82, 0.82)],
    [(0.10, 0.66), (0.24, 0.62), (0.40, 0.60), (0.56, 0.60), (0.72, 0.62), (0.88, 0.66)],
]

CORRIDOR_NAMES = ["Alpha Corridor", "Beta Corridor", "Gamma Spur", "Delta Sweep"]


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


def load_feature(country: str, shape_name: str) -> dict:
    path_map = {
        "CHN": Path(__file__).parent / "data" / "public" / "chn_adm1.geojson",
        "AUS": Path(__file__).parent / "data" / "public" / "aus_adm1.geojson",
    }
    data = json.loads(path_map[country].read_text(encoding="utf-8"))
    for feature in data["features"]:
        if feature["properties"].get("shapeName") == shape_name:
            return feature
    raise ValueError(f"Boundary not found: {country} / {shape_name}")


def polygon_rings(geometry: dict) -> list[list[tuple[float, float]]]:
    if geometry["type"] == "Polygon":
        return [[(lon, lat) for lon, lat in ring] for ring in geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        rings = []
        for poly in geometry["coordinates"]:
            rings.extend([[(lon, lat) for lon, lat in ring] for ring in poly])
        return rings
    raise ValueError(f"Unsupported geometry type: {geometry['type']}")


def exterior_rings(geometry: dict) -> list[list[tuple[float, float]]]:
    if geometry["type"] == "Polygon":
        return [[(lon, lat) for lon, lat in geometry["coordinates"][0]]]
    if geometry["type"] == "MultiPolygon":
        return [[(lon, lat) for lon, lat in poly[0]] for poly in geometry["coordinates"]]
    raise ValueError(f"Unsupported geometry type: {geometry['type']}")


def point_in_ring(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        intersects = ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi)
        if intersects:
            inside = not inside
        j = i
    return inside


def point_in_geometry(point: tuple[float, float], geometry: dict) -> bool:
    if geometry["type"] == "Polygon":
        rings = [[(lon, lat) for lon, lat in ring] for ring in geometry["coordinates"]]
        if not point_in_ring(point, rings[0]):
            return False
        for hole in rings[1:]:
            if point_in_ring(point, hole):
                return False
        return True
    if geometry["type"] == "MultiPolygon":
        for poly in geometry["coordinates"]:
            rings = [[(lon, lat) for lon, lat in ring] for ring in poly]
            if point_in_ring(point, rings[0]):
                blocked = any(point_in_ring(point, hole) for hole in rings[1:])
                if not blocked:
                    return True
        return False
    return False


def geometry_bounds(geometry: dict) -> tuple[float, float, float, float]:
    coords = []
    if geometry["type"] == "Polygon":
        for ring in geometry["coordinates"]:
            coords.extend(ring)
    else:
        for poly in geometry["coordinates"]:
            for ring in poly:
                coords.extend(ring)
    lons = [p[0] for p in coords]
    lats = [p[1] for p in coords]
    return min(lons), min(lats), max(lons), max(lats)


def geometry_centroid(geometry: dict) -> tuple[float, float]:
    exteriors = exterior_rings(geometry)
    pts = [pt for ring in exteriors for pt in ring]
    lon = sum(p[0] for p in pts) / len(pts)
    lat = sum(p[1] for p in pts) / len(pts)
    return lat, lon


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


def nearest_cell(cells: list[dict], lon: float, lat: float) -> dict:
    return min(cells, key=lambda cell: (cell["lon"] - lon) ** 2 + (cell["lat"] - lat) ** 2)


def build_base_cells(scenario: dict, geometry: dict) -> tuple[list[dict], dict[str, dict]]:
    rng = random.Random(SEED + sum(ord(ch) for ch in scenario["id"]))
    min_lon, min_lat, max_lon, max_lat = geometry_bounds(geometry)
    lon_step = (max_lon - min_lon) / COLS
    lat_step = (max_lat - min_lat) / ROWS
    cells = []
    villages: dict[str, dict] = {}
    elevation_grid = {}

    for row in range(ROWS):
        for col in range(COLS):
            lon = min_lon + (col + 0.5) * lon_step
            lat = max_lat - (row + 0.5) * lat_step
            if not point_in_geometry((lon, lat), geometry):
                continue
            x = col / max(COLS - 1, 1)
            y = row / max(ROWS - 1, 1)
            ridge_1 = 980 * math.exp(-((x - 0.28) ** 2 / 0.012 + (y - 0.38) ** 2 / 0.08))
            ridge_2 = 760 * math.exp(-((x - 0.72) ** 2 / 0.018 + (y - 0.60) ** 2 / 0.05))
            ridge_3 = 420 * math.exp(-((x - 0.52) ** 2 / 0.05 + (y - 0.18) ** 2 / 0.03))
            waves = 220 * math.sin(x * 6.4) + 140 * math.cos(y * 7.2) + 110 * math.sin((x + y) * 9.0)
            noise = rng.uniform(-35, 35)
            elevation_grid[(row, col)] = max(280.0, 1500.0 + ridge_1 + ridge_2 + ridge_3 + waves + noise + scenario["heat_bias"] * 55)

    def elev_at(r: int, c: int) -> float:
        if (r, c) in elevation_grid:
            return elevation_grid[(r, c)]
        nearest = min(elevation_grid.keys(), key=lambda rc: (rc[0] - r) ** 2 + (rc[1] - c) ** 2)
        return elevation_grid[nearest]

    for (row, col), elevation in elevation_grid.items():
        left = elev_at(row, max(col - 1, 0))
        right = elev_at(row, min(col + 1, COLS - 1))
        up = elev_at(max(row - 1, 0), col)
        down = elev_at(min(row + 1, ROWS - 1), col)
        dzdx = (right - left) / (2 * 900)
        dzdy = (down - up) / (2 * 900)
        slope_deg = math.degrees(math.atan(math.sqrt(dzdx * dzdx + dzdy * dzdy) * 7.5))
        aspect_deg = (math.degrees(math.atan2(dzdy, -dzdx)) + 360.0) % 360.0
        ridge_exposure = 0.5 + 0.5 * math.sin((col / COLS) * math.pi * 2.4)
        valley_channel = 0.5 + 0.5 * math.cos((row / ROWS) * math.pi * 1.6)
        wind_ms = clamp(4.2 + ridge_exposure * 4.2 + slope_deg / 18 + rng.uniform(-0.8, 0.8), 1.2, 14.0)
        humidity = clamp(64 - ridge_exposure * 16 - slope_deg * 0.25 + valley_channel * 6 + scenario["humidity_bias"] + rng.uniform(-3.0, 3.0), 18, 88)
        temp_c = clamp(23 - elevation / 480 + ridge_exposure * 2.4 + scenario["heat_bias"] + rng.uniform(-1.0, 1.0), 8, 34)
        rain_mm = clamp(max(0.0, 1.2 - ridge_exposure * 0.8 + valley_channel * 0.7 + scenario["rain_bias"] + rng.uniform(-0.4, 0.4)), 0.0, 4.8)
        dryness_bias = clamp((100 - humidity) / 100 + wind_ms / 20, 0.0, 1.0)
        veg_code, veg_label, veg_color, p0, mc_ref, kw, fuel_base, dfmc_key = choose_vegetation(elevation, slope_deg, dryness_bias)
        clearance_distance = clamp(2.2 + (1 - dryness_bias) * 4.0 + valley_channel * 1.3 + rng.uniform(-0.7, 0.7), 0.7, 7.8)
        patrol_access = clamp(8.7 - slope_deg / 8.5 - ridge_exposure * 2.2 + rng.uniform(-0.6, 0.6), 2.8, 9.4)
        lon = min_lon + (col + 0.5) * lon_step
        lat = max_lat - (row + 0.5) * lat_step
        x_band = min(col * 3 // COLS, 2)
        y_band = min(row * 2 // ROWS, 1)
        village = scenario["village_names"][y_band * 3 + x_band]
        cell = {
            "id": f"{scenario['id'].upper()}_C{row:02d}_{col:02d}",
            "col": col,
            "row": row,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "elevation_m": round(elevation, 1),
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
            "village": village,
        }
        cells.append(cell)
        villages.setdefault(village, {"name": village, "cell_ids": [], "population": rng.randint(1200, 4200)})["cell_ids"].append(cell["id"])

    return cells, villages


def build_watch_points(scenario: dict, cells: list[dict]) -> list[dict]:
    min_lon = min(cell["lon"] for cell in cells)
    max_lon = max(cell["lon"] for cell in cells)
    min_lat = min(cell["lat"] for cell in cells)
    max_lat = max(cell["lat"] for cell in cells)
    templates = [(0.18, 0.24, 6.1), (0.50, 0.48, 5.4), (0.78, 0.74, 5.9)]
    points = []
    for idx, (fx, fy, cover) in enumerate(templates):
        lon = min_lon + (max_lon - min_lon) * fx
        lat = max_lat - (max_lat - min_lat) * fy
        snap = nearest_cell(cells, lon, lat)
        points.append({
            "name": scenario["watch_names"][idx],
            "lat": snap["lat"],
            "lon": snap["lon"],
            "coverage_km": cover,
        })
    return points


def build_corridors(scenario: dict, cells: list[dict]) -> list[dict]:
    min_lon = min(cell["lon"] for cell in cells)
    max_lon = max(cell["lon"] for cell in cells)
    min_lat = min(cell["lat"] for cell in cells)
    max_lat = max(cell["lat"] for cell in cells)
    corridors = []
    for idx, template in enumerate(CORRIDOR_TEMPLATES):
        snapped = []
        anchors = []
        for fx, fy in template:
            lon = min_lon + (max_lon - min_lon) * fx
            lat = max_lat - (max_lat - min_lat) * fy
            snap = nearest_cell(cells, lon, lat)
            anchors.append([snap["col"], snap["row"]])
            snapped.append((snap["lat"], snap["lon"]))
        smooth_latlon = catmull_rom(snapped, 10)
        geometry = [[pt[1], pt[0]] for pt in smooth_latlon]
        corridors.append({
            "id": f"{scenario['shape_name']} {CORRIDOR_NAMES[idx]}",
            "geometry": {"type": "LineString", "coordinates": geometry},
            "anchors": anchors,
        })
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
            segment_styles = []
            segment_risks = []
            for i in range(len(corridor["geometry"]["coordinates"]) - 1):
                lon_a, lat_a = corridor["geometry"]["coordinates"][i]
                lon_b, lat_b = corridor["geometry"]["coordinates"][i + 1]
                mid = nearest_cell(cells, (lon_a + lon_b) / 2, (lat_a + lat_b) / 2)
                local_risk = risk_map[mid["id"]]
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
    feature = load_feature(scenario["country"], scenario["shape_name"])
    geometry = feature["geometry"]
    cells, villages = build_base_cells(scenario, geometry)
    watch_points = build_watch_points(scenario, cells)
    corridors = build_corridors(scenario, cells)
    frames = build_frames(cells, villages, corridors, scenario)
    center_lat, center_lon = geometry_centroid(geometry)
    min_lon, min_lat, max_lon, max_lat = geometry_bounds(geometry)
    lat_step = (max_lat - min_lat) / ROWS
    lon_step = (max_lon - min_lon) / COLS
    return {
        "id": scenario["id"],
        "name": scenario["name"],
        "subtitle": scenario["subtitle"],
        "shape_name": scenario["shape_name"],
        "boundary": feature,
        "meta": {
            "rows": ROWS,
            "cols": COLS,
            "cell_size_km": 0.8,
            "base_lat": center_lat,
            "base_lon": center_lon,
            "lat_step": lat_step,
            "lon_step": lon_step,
            "bbox": [min_lon, min_lat, max_lon, max_lat],
            "note": "All weather, risk, corridors, villages and warning values are synthetic. Administrative outlines come from public geoBoundaries data.",
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
            "note": "Public-safe synthetic wildfire warning demonstration constrained by public administrative boundaries.",
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
