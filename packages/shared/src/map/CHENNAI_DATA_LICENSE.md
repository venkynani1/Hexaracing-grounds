# chennai.map.json — data licence

`chennai.map.json` is a **Derivative Database** produced by `tools/mapbuild` from OpenStreetMap data
(extract `tamil_nadu` from download.openstreetmap.fr, snapshot 2026-11-17T00:15:43Z).

**© OpenStreetMap contributors.** Available under the **Open Database License (ODbL) 1.0**:
https://opendatacommons.org/licenses/odbl/1-0/ — attribution: https://www.openstreetmap.org/copyright

This derivative database (road centrelines, classes, lane counts, one-way flags, signal positions, verified
reference locations, generated courses) is likewise made available under ODbL 1.0. Buildings, vehicles and all
other visuals in the game are original procedural content, not OSM data.

Reproduce: `npm run map:extract` (needs the PBF in `tools/mapbuild/data/raw/`) then `npm run map:build`.
