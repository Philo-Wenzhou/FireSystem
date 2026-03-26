# FireSystem

A standalone public-facing wildfire warning demo built from synthetic terrain, synthetic villages, synthetic curved corridors, synthetic watch zones, and time-based wildfire warning playback.

## What it shows

- A landing page that opens into the warning system
- A Leaflet basemap with a default heatmap view
- Curved synthetic corridor lines with width-gradient warning rendering
- Terrain, corridor, heatmap, and risk-grid views
- Clickable warning descriptions instead of raw code-style metrics
- A right-side inspection panel and village aggregation

## Run locally

Use a local static server from the project folder:

```bash
python -m http.server 8000
```

Then open:

[http://localhost:8000](http://localhost:8000)

You can also double-click `OPEN_DEMO.bat` to start the local server and open the system in your browser.

## Privacy note

Everything in this demo is synthetic. No real line geometry, real tower data, or real operational map objects are used.
