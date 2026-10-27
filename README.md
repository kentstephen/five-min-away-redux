# Five minutes away, redux

Buildings in North Brooklyn colored and extruded by how many places of one kind (coffee shops, bars, ...) are within a
five minute walk. Overture places and buildings read with DuckDB, isochrones from a local Valhalla graph (pyvalhalla),
counts on H3 cells clipped to the NYC 2020 neighborhood areas, drawn with deck.gl GeoArrow layers inside a marimo notebook.

```
uv sync
cd web && npm install && npm run build && cd ..
# the Valhalla graph: an OSM extract of New York into data/valhalla/tiles
.venv/bin/valhalla_build_config --mjolnir-tile-dir $PWD/data/valhalla/tiles --mjolnir-timezone $PWD/data/valhalla/timezones.sqlite --mjolnir-admin $PWD/data/valhalla/admins.sqlite > data/valhalla/valhalla.json
.venv/lib/python3.13/site-packages/valhalla/bin/valhalla_build_tiles -c data/valhalla/valhalla.json data/osm/NewYork.osm.pbf
.venv/bin/marimo run --watch --headless --port 2745 five_min_away.py   # extruded buildings
.venv/bin/marimo run --watch --headless --port 2746 five_min_near.py   # flat footprints, hover lights the places, click draws the routes
```

Keys on the map: X notebook or fill the window, F full screen, M basemap, Shift+arrows turn and tilt. Hover a building
to see which places reach it, click to keep it.

`five_min_near.py` draws the same footprints flat. Hovering a building fades the others and lights the places whose
walk shed reaches it as points; clicking locks it and draws the route from the building to each of those places (the
walk or bike route from the local Valhalla graph), until the building is clicked again or Esc. Ten minutes is the default.
