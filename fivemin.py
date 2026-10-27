"""Data for Five Minutes Away: Overture places and buildings read with DuckDB, isochrones from a local Valhalla graph,
walk-shed counts on H3 cells, and the cells clipped to the neighborhoods (North Brooklyn: Greenpoint, the three
Williamsburg NTAs, Fort Greene, Clinton Hill, both Bedford-Stuyvesant NTAs and both Bushwick NTAs).

Everything read from the network is cached under data/cache/ so the notebook restarts fast.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import duckdb
import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

HERE = Path(__file__).resolve().parent
CACHE = HERE / "data" / "cache"
VALHALLA_CONFIG = HERE / "data" / "valhalla" / "valhalla.json"

RELEASE = "2026-10-21.0"
S3 = f"s3://overturemaps-us-west-2/release/{RELEASE}"

# NYC 2020 Neighborhood Tabulation Areas drawn and clipped to
NTAS = {
    "BK0101": "Greenpoint",
    "BK0102": "Williamsburg",
    "BK0103": "South Williamsburg",
    "BK0104": "East Williamsburg",
    "BK0203": "Fort Greene",
    "BK0204": "Clinton Hill",
    "BK0301": "Bedford-Stuyvesant (West)",
    "BK0302": "Bedford-Stuyvesant (East)",
    "BK0401": "Bushwick (West)",
    "BK0402": "Bushwick (East)",
}
PLACE_NAME = "North Brooklyn"
# cache file suffix: the NTA codes, so a changed neighborhood list reads a fresh box instead of reusing an old one
AREA_KEY = "nb" + str(len(NTAS))
# Places and buildings are read for the NTAs' box padded by about 1.5 km, so places just outside count toward walks inside.
PAD_LON, PAD_LAT = 0.018, 0.014

# Category name -> a node of the Overture places taxonomy. A place matches when the node is anywhere in its
# hierarchy, so "Restaurant" takes pizza_restaurant, thai_restaurant and so on, "Bar" takes cocktail_bar and dive_bar.
CATEGORIES = {
    "Coffee Shop": "coffee_shop",
    "Cafe": "cafe",
    "Restaurant": "restaurant",
    "Bar": "bar",
    "Grocery Store": "grocery_store",
    "Pharmacy": "pharmacy",
    "Bakery": "bakery",
    "Gym": "gym",
    "Laundromat": "laundromat",
    "Park": "park",
}

_con = {}
_lock = threading.Lock()


def connection() -> duckdb.DuckDBPyConnection:
    """One DuckDB connection per process with httpfs, spatial and h3 loaded; a cursor per call so threads are safe."""
    with _lock:
        if "con" not in _con:
            con = duckdb.connect()
            con.execute(
                "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; INSTALL h3 FROM community; LOAD h3; "
                "SET s3_region='us-west-2'; SET enable_object_cache=true;"
            )
            _con["con"] = con
    return _con["con"].cursor()


def _box_sql(area) -> str:
    W, S, E, N = area
    return f"bbox.xmin <= {E} AND bbox.xmax >= {W} AND bbox.ymin <= {N} AND bbox.ymax >= {S}"


def _cached_parquet(name: str, query: str, log=print) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / name
    if not out.exists():
        t = time.time()
        connection().execute(f"COPY ({query}) TO '{out}' (FORMAT PARQUET)")
        log(f"{name}: read from Overture {RELEASE} in {time.time() - t:.1f} s")
    return out


def places_path(area=None, log=print) -> Path:
    """Every Overture place in the area: id, name, category (taxonomy primary), its hierarchy, confidence, lon, lat."""
    area = area or globals()["area"](log)
    q = (
        "SELECT id, struct_extract(names, 'primary') AS name, struct_extract(taxonomy, 'primary') AS category, "
        "struct_extract(taxonomy, 'hierarchy') AS hierarchy, basic_category, confidence, "
        "ST_X(geometry) AS lon, ST_Y(geometry) AS lat "
        f"FROM read_parquet('{S3}/theme=places/type=place/*.parquet') WHERE {_box_sql(area)}"
    )
    return _cached_parquet(f"places_{AREA_KEY}.parquet", q, log)


def buildings_path(area=None, log=print) -> Path:
    """Every Overture building in the area with subtype, class, height and num_floors."""
    area = area or globals()["area"](log)
    q = (
        "SELECT id, subtype, class, height, num_floors, geometry "
        f"FROM read_parquet('{S3}/theme=buildings/type=building/*.parquet') WHERE {_box_sql(area)}"
    )
    return _cached_parquet(f"buildings_{AREA_KEY}.parquet", q, log)


def boundary(log=print) -> shapely.Geometry:
    """The NTAs in NTAS from NYC Open Data (2020 NTAs, dataset 9nt8-h7nd), dissolved into one polygon."""
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"ntas_{AREA_KEY}.geojson"
    if not out.exists():
        import urllib.parse
        import urllib.request

        where = "nta2020 in(" + ",".join(f"'{k}'" for k in NTAS) + ")"
        url = "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?" + urllib.parse.urlencode({"$where": where, "$select": "ntaname,nta2020,the_geom"})
        with urllib.request.urlopen(url, timeout=60) as r:
            out.write_bytes(r.read())
        log(f"{out.name}: read from NYC Open Data")
    fc = json.loads(out.read_text())
    got = {f["properties"]["nta2020"] for f in fc["features"]}
    if got != set(NTAS):
        out.unlink()
        raise RuntimeError(f"NTA fetch returned {sorted(got)}, wanted {sorted(NTAS)}")
    return shapely.union_all([shapely.geometry.shape(f["geometry"]) for f in fc["features"]])


_area = {}


def area(log=print) -> tuple[float, float, float, float]:
    """The read box: the NTAs' bounds padded by PAD_LON, PAD_LAT."""
    if "box" not in _area:
        W, S, E, N = boundary(log).bounds
        _area["box"] = (W - PAD_LON, S - PAD_LAT, E + PAD_LON, N + PAD_LAT)
    return _area["box"]


def places(category: str, area=None, log=print) -> pd.DataFrame:
    """The places of one category in the area (name, category, lon, lat), ordered by confidence."""
    node = CATEGORIES[category]
    p = places_path(area, log)
    return (
        connection()
        .sql(
            f"SELECT id, name, category, confidence, lon, lat FROM read_parquet('{p}') "
            f"WHERE list_contains(hierarchy, '{node}') ORDER BY confidence DESC"
        )
        .df()
    )


_actor = {}


def actor():
    """The Valhalla actor over the local graph (built from the BBBike New York extract into data/valhalla/tiles)."""
    with _lock:
        if "actor" not in _actor:
            import valhalla

            cfg = json.loads(VALHALLA_CONFIG.read_text())
            cfg["mjolnir"]["tile_extract"] = ""
            cfg["mjolnir"]["traffic_extract"] = ""
            for k in ("mjolnir", "loki", "thor", "odin"):
                cfg.setdefault(k, {})["logging"] = {"type": "", "long_request": 1e9}
            _actor["actor"] = valhalla.Actor(cfg)
    return _actor["actor"]


def isochrones(df: pd.DataFrame, costing: str = "pedestrian", minutes: float = 5, log=print) -> gpd.GeoDataFrame:
    """One isochrone polygon per place row (name, category kept). Places the router cannot reach are dropped."""
    a = actor()
    t = time.time()
    geoms, keep = [], []
    for i, (lon, lat) in enumerate(zip(df["lon"].to_numpy(), df["lat"].to_numpy())):
        try:
            r = a.isochrone(
                {
                    "locations": [{"lat": float(lat), "lon": float(lon)}],
                    "costing": costing,
                    "contours": [{"time": minutes}],
                    "polygons": True,
                    "denoise": 0.3,
                    "generalize": 5,
                }
            )
            g = shapely.geometry.shape(r["features"][0]["geometry"])
            if not g.is_empty:
                geoms.append(shapely.make_valid(g))
                keep.append(i)
        except Exception as e:  # a point off the graph, or outside the extract
            log(f"isochrone failed at ({lon:.5f}, {lat:.5f}): {e}")
    out = gpd.GeoDataFrame(df.iloc[keep].reset_index(drop=True), geometry=geoms, crs="EPSG:4326")
    log(f"{len(out)} of {len(df)} {costing} {minutes:g} min isochrones in {time.time() - t:.1f} s")
    return out


def _decode6(shape: str) -> list[list[float]]:
    """Valhalla's encoded polyline (precision 6) as [lon, lat] pairs."""
    out, i, lat, lon = [], 0, 0, 0
    while i < len(shape):
        for k in (0, 1):
            res, shift = 0, 0
            while True:
                b = ord(shape[i]) - 63
                i += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append([lon / 1e6, lat / 1e6])
    return out


def routes(origin: tuple[float, float], targets: pd.DataFrame, costing: str = "pedestrian", log=print) -> list[dict]:
    """The route from one point (lon, lat) to each target row (lon, lat, name): {"path": [[lon, lat], ...],
    "minutes", "meters", "name"} per target that the router can reach."""
    a = actor()
    t = time.time()
    out = []
    for lon, lat, name in zip(targets["lon"].to_numpy(), targets["lat"].to_numpy(), targets["name"].fillna("").to_numpy()):
        try:
            r = a.route({"locations": [{"lon": origin[0], "lat": origin[1]}, {"lon": float(lon), "lat": float(lat)}], "costing": costing, "units": "kilometers"})
            trip = r["trip"]
            path = [p for leg in trip["legs"] for p in _decode6(leg["shape"])]
            out.append({"path": path, "minutes": trip["summary"]["time"] / 60, "meters": trip["summary"]["length"] * 1000, "name": str(name)})
        except Exception as e:
            log(f"route to ({lon:.5f}, {lat:.5f}) failed: {e}")
    log(f"{len(out)} of {len(targets)} {costing} routes in {time.time() - t:.1f} s")
    return out


def h3_density(iso: gpd.GeoDataFrame, resolution: int = 11, clip: shapely.Geometry | None = None, log=print) -> gpd.GeoDataFrame:
    """H3 cells covered by the isochrones: how many places reach each cell (poi_density) and which (poi_names, and
    poi_ids: row indexes into `iso`).
    With `clip`, cells are cut to that polygon the way the old UDF overlaid the Bushwick boundary."""
    t = time.time()
    df = pd.DataFrame({"pid": np.arange(len(iso), dtype=np.int32), "name": iso["name"].fillna("").to_numpy(), "wkt": shapely.to_wkt(iso.geometry.to_numpy())})
    con = connection()
    con.register("iso", df)
    clip_sql = ""
    if clip is not None:
        con.register("clip", pd.DataFrame({"wkt": [shapely.to_wkt(clip)]}))
        clip_sql = (
            ", ST_AsWKB(ST_Intersection(ST_GeomFromText(h3_cell_to_boundary_wkt(hex)), (SELECT ST_GeomFromText(wkt) FROM clip))) AS geom "
            "FROM cells WHERE ST_Intersects(ST_GeomFromText(h3_cell_to_boundary_wkt(hex)), (SELECT ST_GeomFromText(wkt) FROM clip))"
        )
    else:
        clip_sql = ", ST_AsWKB(ST_GeomFromText(h3_cell_to_boundary_wkt(hex))) AS geom FROM cells"
    q = f"""
    WITH to_cells AS (
      SELECT unnest(h3_polygon_wkt_to_cells(wkt, {resolution})) AS hex, pid, name FROM iso
    ), cells AS (
      SELECT hex, count(*)::INTEGER AS poi_density, string_agg(DISTINCT name, ', ' ORDER BY name) AS poi_names,
             list(DISTINCT pid) AS poi_ids
      FROM to_cells GROUP BY hex
    )
    SELECT h3_h3_to_string(hex) AS hex, poi_density, poi_names, poi_ids {clip_sql}
    """
    t_ = con.sql(q).to_arrow_table()
    con.unregister("iso")
    geom = shapely.from_wkb(t_.column("geom").to_pylist())
    out = gpd.GeoDataFrame(t_.drop_columns(["geom"]).to_pandas(), geometry=geom, crs="EPSG:4326")
    out = out[~out.geometry.is_empty].reset_index(drop=True)
    log(f"{len(out)} H3 cells at res {resolution} in {time.time() - t:.1f} s")
    return out


def buildings_scored(cells: gpd.GeoDataFrame, names: pd.Series | None = None, area=None, log=print) -> gpd.GeoDataFrame:
    """Buildings that touch a cell, each with the union of the places over the cells it touches: poi_ids (row indexes
    into the isochrone frame), poi_names, and poi_density = how many distinct places that is."""
    t = time.time()
    p = buildings_path(area, log)
    con = connection()
    con.register("cells", pd.DataFrame({"hex": cells["hex"], "poi_ids": cells["poi_ids"], "wkt": shapely.to_wkt(cells.geometry.to_numpy())}))
    q = f"""
    WITH c AS (SELECT hex, poi_ids, ST_GeomFromText(wkt) AS g FROM cells),
    b AS (SELECT id, subtype, class, height, num_floors, geometry AS g FROM read_parquet('{p}')),
    j AS (
      SELECT b.id, any_value(b.subtype) AS subtype, any_value(b.class) AS class, any_value(b.height) AS height,
             any_value(b.num_floors) AS num_floors, any_value(b.g) AS g,
             list_sort(list_distinct(flatten(list(c.poi_ids)))) AS poi_ids
      FROM b JOIN c ON ST_Intersects(b.g, c.g) GROUP BY b.id
    )
    SELECT id, subtype, class, height, num_floors, poi_ids, len(poi_ids)::INTEGER AS poi_density, ST_AsWKB(g) AS geom FROM j
    """
    t_ = con.sql(q).to_arrow_table()
    con.unregister("cells")
    geom = shapely.from_wkb(t_.column("geom").to_pylist())
    out = gpd.GeoDataFrame(t_.drop_columns(["geom"]).to_pandas(), geometry=geom, crs="EPSG:4326")
    nm = names.fillna("").to_numpy(object) if names is not None else None
    out["poi_names"] = [", ".join(sorted({str(nm[i]) for i in ids} - {""})) if nm is not None else "" for ids in out["poi_ids"]]
    log(f"{len(out)} buildings scored in {time.time() - t:.1f} s")
    return out


def run(category="Coffee Shop", costing="pedestrian", minutes=5, resolution=11, log=print):
    """The whole chain: places -> isochrones -> cells clipped to the NTAs -> scored buildings. The last few results are
    kept, so asking again with the same knobs (the page reloading, a click) costs nothing."""
    return _run(category, costing, int(minutes), int(resolution))


import functools


@functools.lru_cache(maxsize=6)
def _run(category, costing, minutes, resolution, log=print):
    pts = places(category, log=log)
    iso = isochrones(pts, costing, minutes, log)
    cells = h3_density(iso, resolution, boundary(log), log)
    bld = buildings_scored(cells, iso["name"], log=log)
    return pts, iso, cells, bld


if __name__ == "__main__":
    import sys

    cat = sys.argv[1] if len(sys.argv) > 1 else "Coffee Shop"
    t0 = time.time()
    pts, iso, cells, bld = run(cat)
    print(f"{cat}: {len(pts)} places, {len(iso)} isochrones, {len(cells)} cells, {len(bld)} buildings in {time.time() - t0:.1f} s")
    print(bld[["poi_density"]].describe().T)
    print(bld.head(3)[["subtype", "class", "poi_density", "poi_names"]])


def pack(bld: gpd.GeoDataFrame, rgba: np.ndarray, names: bool = True) -> bytes:
    """Arrow IPC stream for the page: a geoarrow.polygon per building part (its exterior ring), `fid` the building's row,
    `density`, `names`, `ids` (list<int32>: rows of the places frame whose sheds reach it), `rgba` (4 x uint8 per part)
    and `elev` (float32, the density)."""
    import pyarrow as pa

    geoms = bld.geometry.to_numpy()
    if len(geoms) == 0:
        parts, fid = np.array([], dtype=object), np.array([], np.int64)
    else:
        parts, fid = shapely.get_parts(geoms, return_index=True)
    rings = shapely.get_exterior_ring(parts)
    coords = shapely.get_coordinates(rings)
    ring_off = np.concatenate([[0], np.cumsum(shapely.get_num_coordinates(rings))]).astype(np.int32)
    xy = pa.FixedSizeListArray.from_arrays(pa.array(coords.ravel(), pa.float64()), type=pa.list_(pa.field("xy", pa.float64(), nullable=False), 2))
    ring = pa.ListArray.from_arrays(pa.array(ring_off, pa.int32()), xy, type=pa.list_(pa.field("vertices", xy.type, nullable=False)))
    poly = pa.ListArray.from_arrays(pa.array(np.arange(len(rings) + 1, dtype=np.int32), pa.int32()), ring, type=pa.list_(pa.field("rings", ring.type, nullable=False)))
    dens = bld["poi_density"].to_numpy(np.int32)[fid]
    idl = bld["poi_ids"].to_numpy(object)[fid] if "poi_ids" in bld else [[] for _ in fid]
    ids = pa.array([list(map(int, v)) for v in idl], pa.list_(pa.int32()))
    # with names=False the page builds the names from `ids` and places_json, which is far smaller than a string per part
    names_ = bld["poi_names"].fillna("").to_numpy(object)[fid] if names else np.full(len(fid), "", object)
    col = pa.FixedSizeListArray.from_arrays(pa.array(np.asarray(rgba, np.uint8)[fid].ravel(), pa.uint8()), 4)
    schema = pa.schema(
        [
            pa.field("geometry", poly.type, metadata={b"ARROW:extension:name": b"geoarrow.polygon"}),
            pa.field("fid", pa.int32()),
            pa.field("density", pa.int32()),
            pa.field("names", pa.string()),
            pa.field("ids", ids.type),
            pa.field("rgba", col.type),
            pa.field("elev", pa.float32()),
        ]
    )
    batch = pa.record_batch([poly, pa.array(fid.astype(np.int32), pa.int32()), pa.array(dens, pa.int32()), pa.array(names_, pa.string()), ids, col, pa.array(dens.astype(np.float32), pa.float32())], schema=schema)
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, schema) as wr:
        wr.write_batch(batch)
    return sink.getvalue().to_pybytes()


def places_json(iso: pd.DataFrame) -> str:
    """The places as the page needs them for lighting points: [[lon, lat, name], ...] in `poi_ids` order."""
    return json.dumps([[round(float(x), 6), round(float(y), 6), str(n)] for x, y, n in zip(iso["lon"], iso["lat"], iso["name"].fillna(""))])
