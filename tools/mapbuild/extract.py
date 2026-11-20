"""
Extract the Chennai corridor road network + reference features from an OpenStreetMap PBF.
Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).

Usage: python3 tools/mapbuild/extract.py tools/mapbuild/data/raw/tamil_nadu.osm.pbf tools/mapbuild/data/chennai-extract.json
"""
import json
import re
import sys

import osmium

BBOX = (12.58, 80.05, 13.12, 80.32)  # south, west, north, east — Chennai Central … Mahabalipuram, Tambaram … coast
CLASSES = {
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
}
# Named features used to VERIFY start locations and the destination (matched case-insensitively).
FEATURE_PATTERNS = {
    'hexaware': re.compile(r'hexaware', re.I),
    'sipcot': re.compile(r'sipcot', re.I),
    'chennai_central': re.compile(r'(puratchi thalaivar dr\.? m\.? ?g\.? ?ramachandran central|chennai central)', re.I),
    'guindy': re.compile(r'^guindy', re.I),
    'velachery': re.compile(r'^velachery', re.I),
    'tambaram': re.compile(r'^tambaram', re.I),
    'thiruvanmiyur': re.compile(r'^thiruvanmiyur', re.I),
    'kelambakkam': re.compile(r'^kelambakkam', re.I),
    'mahabalipuram': re.compile(r'^(mahabalipuram|mamallapuram)', re.I),
    'siruseri': re.compile(r'^siruseri', re.I),
}
KEEP_FEATURE_TAGS = ('place', 'railway', 'office', 'landuse', 'amenity', 'building', 'public_transport', 'highway', 'tourism', 'historic')


def inside(lat, lon):
    s, w, n, e = BBOX
    return s <= lat <= n and w <= lon <= e


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []
        self.signals = []
        self.features = []
        self.fuel = []

    def node(self, n):
        if not n.location.valid() or not inside(n.location.lat, n.location.lon):
            return
        tags = n.tags
        if tags.get('highway') == 'traffic_signals':
            self.signals.append([round(n.location.lat, 7), round(n.location.lon, 7)])
        if tags.get('amenity') == 'fuel':
            self.fuel.append({'osm': f'n{n.id}', 'lat': round(n.location.lat, 7), 'lon': round(n.location.lon, 7)})
        self._feature('n', n.id, tags, n.location.lat, n.location.lon)

    def way(self, w):
        tags = w.tags
        hw = tags.get('highway')
        try:
            coords = [(nd.lat, nd.lon, nd.ref) for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not coords:
            return
        if hw in CLASSES and any(inside(la, lo) for la, lo, _ in coords):
            if tags.get('area') == 'yes':
                return
            self.ways.append({
                'id': w.id,
                'hw': hw,
                'name': tags.get('name:en') or tags.get('name') or '',
                'ref': tags.get('ref') or '',
                'oneway': tags.get('oneway') in ('yes', '1', 'true') or hw in ('motorway',) or tags.get('junction') == 'roundabout',
                'lanes': tags.get('lanes') or '',
                'maxspeed': tags.get('maxspeed') or '',
                'bridge': tags.get('bridge') == 'yes',
                'nodes': [[ref, round(la, 7), round(lo, 7)] for la, lo, ref in coords],
            })
        else:
            lat = sum(c[0] for c in coords) / len(coords)
            lon = sum(c[1] for c in coords) / len(coords)
            if inside(lat, lon):
                self._feature('w', w.id, tags, lat, lon)
                if tags.get('amenity') == 'fuel':
                    self.fuel.append({'osm': f'w{w.id}', 'lat': round(lat, 7), 'lon': round(lon, 7)})

    def _feature(self, kind, oid, tags, lat, lon):
        name = tags.get('name:en') or tags.get('name')
        if not name:
            return
        for key, pat in FEATURE_PATTERNS.items():
            if pat.search(name) or (tags.get('name') and pat.search(tags.get('name'))):
                kept = {k: tags.get(k) for k in KEEP_FEATURE_TAGS if tags.get(k)}
                self.features.append({'key': key, 'osm': f'{kind}{oid}', 'name': name, 'tags': kept, 'lat': round(lat, 7), 'lon': round(lon, 7)})


def main():
    src, out = sys.argv[1], sys.argv[2]
    h = Handler()
    h.apply_file(src, locations=True, idx='flex_mem')
    data = {
        'source': 'OpenStreetMap extract tamil_nadu (download.openstreetmap.fr)',
        'license': 'ODbL 1.0 — © OpenStreetMap contributors',
        'bbox': BBOX,
        'ways': h.ways,
        'signals': h.signals,
        'features': h.features,
        # Fuel station LOCATIONS only (no brand names are used in the game).
        'fuel': h.fuel,
    }
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print(f'ways={len(h.ways)} signals={len(h.signals)} features={len(h.features)} fuel={len(h.fuel)}')


if __name__ == '__main__':
    main()
