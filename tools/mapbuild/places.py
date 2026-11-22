"""
Extract named PLACES (suburbs, neighbourhoods, localities, villages, towns) inside the Chennai bbox from an OSM PBF.
Used for in-game area names and roadside place-name boards. Data © OpenStreetMap contributors, ODbL 1.0.

Usage: python3 tools/mapbuild/places.py tools/mapbuild/data/raw/tamil_nadu.osm.pbf tools/mapbuild/data/raw/chennai-places.json
"""
import json
import sys

import osmium

BBOX = (12.58, 80.05, 13.12, 80.32)  # must match extract.py
KINDS = {'city', 'town', 'suburb', 'quarter', 'neighbourhood', 'village', 'locality', 'hamlet'}


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.places = []

    def node(self, n):
        p = n.tags.get('place')
        if p not in KINDS or not n.location.valid():
            return
        lat, lon = n.location.lat, n.location.lon
        s, w, no, e = BBOX
        if not (s <= lat <= no and w <= lon <= e):
            return
        name = n.tags.get('name:en') or n.tags.get('name')
        if not name:
            return
        self.places.append({'osm': f'n{n.id}', 'name': name, 'kind': p, 'lat': round(lat, 7), 'lon': round(lon, 7)})


def main():
    h = H()
    h.apply_file(sys.argv[1])
    with open(sys.argv[2], 'w') as f:
        json.dump({'license': 'ODbL 1.0 — © OpenStreetMap contributors', 'bbox': BBOX, 'places': h.places}, f, separators=(',', ':'))
    print(f'places={len(h.places)}')


if __name__ == '__main__':
    main()
