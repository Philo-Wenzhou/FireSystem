# Mountain Fire Warning Demo

A standalone public-facing wildfire warning demo built from synthetic terrain, synthetic villages, synthetic lines and synthetic watch points.

## What it shows

- A real basemap rendered with Leaflet
- Synthetic mountain risk cells with clickable detail
- Pseudo infrastructure lines colored by simulated risk
- Synthetic hotspot markers and watch-point coverage rings
- A right-side inspection panel and village-level aggregation

## Run locally

Use a local static server from the project folder:

```bash
python -m http.server 8000
```

Then open:

[http://localhost:8000](http://localhost:8000)

Do not open `index.html` directly with `file://`, because browser module loading and map assets may not render correctly in that mode.

## Privacy note

Everything in this demo is synthetic. No real line geometry, real tower data or real operational map objects are used.
