import marimo

__generated_with = "0.25.2"
app = marimo.App(width="full")


@app.cell
def _():
    import json
    import pathlib

    import anywidget
    import marimo as mo
    import numpy as np
    import traitlets

    import fivemin

    return anywidget, fivemin, json, mo, np, pathlib, traitlets


@app.cell
def _(anywidget, fivemin, json, mo, pathlib, traitlets):
    class FiveMap(anywidget.AnyWidget):
        """The page, flat: MapLibre + deck.gl map of the building footprints (GeoArrow polygons colored by how many
        places reach them). Hovering a building dims the others and lights the places that reach it as points; a click
        locks it and asks the kernel for the routes from the building to those places, drawn until released.
        Source in web/src, built to web/dist/widget.js (`cd web && npm run build`)."""

        _esm = pathlib.Path(__file__).parent / "web" / "dist" / "widget.js"
        # page -> kernel
        category = traitlets.Unicode("Coffee Shop").tag(sync=True)
        costing = traitlets.Unicode("pedestrian").tag(sync=True)
        minutes = traitlets.Int(10).tag(sync=True)
        resolution = traitlets.Int(11).tag(sync=True)
        ask = traitlets.Unicode("").tag(sync=True)  # the page asks for the buildings again (it rendered after they were sent)
        # kernel -> page
        categories = traitlets.Unicode("[]").tag(sync=True)
        config = traitlets.Unicode("{}").tag(sync=True)
        data = traitlets.Bytes(b"").tag(sync=True)
        places = traitlets.Unicode("[]").tag(sync=True)  # [[lon, lat, name], ...] indexed by the buildings' ids

    HOME = {"lon": -73.942, "lat": 40.706, "zoom": 12.1, "pitch": 0, "bearing": 0}
    page = mo.ui.anywidget(
        FiveMap(categories=json.dumps(list(fivemin.CATEGORIES)), config=json.dumps({"view": HOME, "area": fivemin.PLACE_NAME, "busy": True, "flat": True}))
    )
    # what the click handler routes over: the current buildings, places and costing, set by the cell that packs them
    STATE = {}

    def _on_msg(widget, content, buffers):
        """A click on the page: {"pin": fid} asks for the routes from that building to the places that reach it,
        answered with {"pin": fid, "routes": [...]} over the same channel (no trait changes, so no cells re-run)."""
        fid = int(content.get("pin", -1)) if isinstance(content, dict) else -1
        if fid < 0 or "bld" not in STATE:
            return
        bld, iso, costing = STATE["bld"], STATE["iso"], STATE["costing"]
        if fid >= len(bld):
            return
        row = bld.iloc[fid]
        c = row.geometry.representative_point()
        try:
            rts = fivemin.routes((c.x, c.y), iso.iloc[list(row["poi_ids"])], costing, log=lambda *_: None)
        except Exception:  # the router threw: answer with no routes so the page stops waiting
            rts = []
        widget.send({"pin": fid, "routes": rts})

    page.widget.on_msg(_on_msg)
    return FiveMap, HOME, STATE, page


@app.cell
def _(fivemin, page):
    # ---- places -> isochrones -> H3 cells clipped to the NTAs -> buildings scored by how many places reach them
    _v = page.value
    category, costing, minutes, resolution = _v["category"], _v["costing"], int(_v["minutes"]), int(_v["resolution"])
    pts, iso, cells, bld = fivemin.run(category, costing, minutes, resolution, log=lambda *_: None)
    return bld, category, cells, costing, iso, minutes, pts, resolution


@app.cell
def _(np):
    # CARTO Emrld remade as 50 stops (from the usgs-mrms-flood ramp): the same hue path, extended to pale sage at the
    # light end and near-black navy at the dark end. Drawn dark to light: few places within reach is dark, many is light.
    EMRLD_LIGHT_TO_DARK = ['#e9f3bf', '#d9f3a7', '#c9f0a0', '#b9ed9d', '#abea9a', '#9fe598', '#96e096', '#8fdb93', '#88d591', '#81cf8f', '#79ca8e', '#72c48c', '#6abf8b', '#64b989', '#5fb388', '#5aad86', '#56a785', '#51a183', '#4c9b82', '#469581', '#3e9080', '#378a7f', '#2f857d', '#287f7b', '#217a79', '#1b7476', '#176f73', '#156970', '#13636c', '#115d68', '#105864', '#0e5360', '#0c4d5c', '#0a4857', '#084353', '#063e4e', '#053949', '#043443', '#042f3d', '#032b38', '#032632', '#02222e', '#021d29', '#021925', '#011421', '#01101d', '#010b19', '#010715', '#010411', '#01020e']
    EMRLD = EMRLD_LIGHT_TO_DARK[::-1]

    def ramp(values, vmin, vmax, alpha=255):
        """RGBA rows for values on the ramp, vmin at the dark end, vmax at the light end."""
        stops = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5)] for h in EMRLD], dtype=float)
        t = np.clip((np.asarray(values, float) - vmin) / max(vmax - vmin, 1e-9), 0, 1) * (len(stops) - 1)
        i = np.minimum(t.astype(int), len(stops) - 2)
        f = (t - i)[:, None]
        rgb = stops[i] * (1 - f) + stops[i + 1] * f
        return np.column_stack([rgb.round().astype(np.uint8), np.full(len(rgb), alpha, np.uint8)])

    return EMRLD, ramp


@app.cell
def _(EMRLD, HOME, STATE, bld, category, costing, fivemin, iso, json, minutes, page, pts, ramp):
    # ---- push the buildings (GeoArrow) and the card's numbers to the page
    def _plural(name):
        w = name.lower()
        return w[:-1] + "ies" if w.endswith("y") else w + "s"

    VMAX = max(int(bld["poi_density"].max()) if len(bld) else 1, 5)
    STATE.update(bld=bld, iso=iso, costing=costing)
    page.widget.places = fivemin.places_json(iso)
    page.widget.data = fivemin.pack(bld, ramp(bld["poi_density"], 0, VMAX), names=False)
    page.widget.config = json.dumps(
        {"ramp": EMRLD, "vmax": VMAX, "buildings": int(len(bld)), "places": int(len(pts)), "plural": _plural(category),
         "minutes": minutes, "area": fivemin.PLACE_NAME, "view": HOME, "busy": False, "flat": True}
    )
    page
    return (VMAX,)


if __name__ == "__main__":
    app.run()
