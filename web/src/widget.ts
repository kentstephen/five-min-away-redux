/** Five Minutes Away: the map (MapLibre + deck.gl, buildings as GeoArrow polygons extruded and colored by how many
 * places reach them), the card whose sentence is the controls, and our own tooltip on hover / click.
 *
 * Traits: category, costing, minutes, resolution (page -> kernel); categories, config (JSON: ramp, vmax, counts, view,
 * plural), data (Arrow IPC stream: geoarrow.polygon per building part, fid, density int32, names utf8, rgba
 * FixedSizeList<uint8, 4>, elev float32) (kernel -> page).
 */
import * as maplibregl from "maplibre-gl";
import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";
// MapLibre 6 loads its worker as a separate module file next to the bundle; marimo serves the bundle alone, so the
// worker source is inlined and handed over as a blob URL
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?raw";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import { GeoArrowPolygonLayer } from "@geoarrow/deck.gl-layers";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import * as arrow from "apache-arrow";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import HighTable, { arrayDataFrame, sortableDataFrame } from "hightable";
import htCss from "hightable/src/HighTable.css?inline";
import { parquetReadObjects } from "hyparquet";
import css from "./widget.css?inline";

type Model = {
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
  save_changes: () => void;
  on: (ev: string, cb: (...a: unknown[]) => void) => void;
  off: (ev: string, cb: (...a: unknown[]) => void) => void;
  send: (msg: unknown) => void;
};
type Cfg = { ramp?: string[]; vmax?: number; buildings?: number; places?: number; plural?: string; minutes?: number; area?: string;
  view?: { lon: number; lat: number; zoom: number; pitch: number; bearing: number }; busy?: boolean; flat?: boolean;
  nbhd?: boolean; ntas?: Nta[] };
type Nta = { name: string; vmax: number | null; label: [number, number]; rings: [number, number][][] };
// flat mode: a footprint hovered or locked dims the others, lights the places that reach it, and once locked draws the
// routes from it to them. All page side, except the routes, which the kernel answers over the custom message channel.
type Place = [number, number, string];
type Route = { i: number; path: [number, number][]; minutes: number; meters: number; name: string };
const LIT: [number, number, number] = [217, 243, 167]; // the ramp's light end, the card's accent
const GOLD: [number, number, number] = [240, 192, 64]; // the places: a gold ring, open in the middle
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const STYLES: [string, string][] = [
  ["dark", "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json"],
  ["voyager", "https://basemaps.cartocdn.com/gl/voyager-nolabels-gl-style/style.json"],
  ["positron", "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json"],
];
const FIT = "fm-fit-on";
const NAMES_SHOWN = 14;

function render({ model, el }: { model: Model; el: HTMLElement }) {
  const sheet = document.createElement("style");
  sheet.textContent = maplibreCss + "\n" + htCss + "\n" + css;
  el.appendChild(sheet);
  if (!document.getElementById("fm-font")) {
    const l = document.createElement("link"); l.id = "fm-font"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Albert+Sans:wght@400;600&display=swap"; document.head.appendChild(l);
  }
  if (!document.getElementById("fm-fit-style")) {
    const s = document.createElement("style"); s.id = "fm-fit-style";
    const hide = ["notebook-actions-dropdown", "cell-actions-button", "drag-button", "expand-output-button", "fullscreen-output-button", "chrome-sidebar", "chrome-footer", "chrome-controls-top-right", "chrome-controls-bottom-right"];
    s.textContent = hide.map((t) => `html.${FIT} [data-testid='${t}']`).join(",") + `,html.${FIT} div[class*='top-[25vh]']{display:none!important}html.${FIT}{overflow:hidden}`;
    document.head.appendChild(s);
  }

  const root = document.createElement("div");
  root.className = "fm fit";
  root.innerHTML = `
    <div class="map"></div>
    <div class="card glass">
      <h1>Five minutes away</h1>
      <p class="q">Buildings in <span class="area">North Brooklyn</span> within a <select class="min"></select> minute
        <select class="mode"><option value="pedestrian">walk</option><option value="bicycle">bike ride</option></select>
        of a <select class="cat"></select><span>.</span></p>
      <div class="ramp"></div>
      <div class="ends"><span class="lo">1</span><span class="hi"></span></div>
      <div class="foot"><span class="n"></span><label class="res">cells <select class="resv"></select></label>
        <label class="nb"><input class="nbv" type="checkbox"> each neighborhood on its own scale</label>
        <label class="hgt">height <input class="hs" type="range" min="0" max="200" step="0.5" value="30"> <input class="hn" type="number" min="0" max="10000" step="0.5" value="30"> ×</label></div>
      <div class="keys"><span class="kx"><kbd>X</kbd> <b class="xk">notebook</b></span><span class="kf"><kbd>F</kbd> full screen</span>
        <span class="km"><kbd>M</kbd> <b class="mk">voyager</b></span><span class="ke"><kbd>E</kbd> <b class="ek">extrude</b></span><span class="kk" title="Shift with the arrow keys turns and tilts the map"><kbd>Shift</kbd> arrows turn, tilt</span><span class="busy"></span></div>
    </div>
    <div class="tip glass"></div>
    <div class="ptip glass"></div>
    <div class="side glass"><div class="head"></div><div class="ht"></div></div>
    <div class="attrib">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> © <a href="https://carto.com/" target="_blank" rel="noopener">CARTO</a>, Overture Maps</div>`;
  el.appendChild(root);
  const $ = <T extends HTMLElement = HTMLElement>(c: string) => root.querySelector(c) as T;
  const cfg = (): Cfg => { try { return JSON.parse((model.get("config") as string) || "{}"); } catch { return {}; } };

  // ---- the card
  const fill = (sel: HTMLSelectElement, opts: [string | number, string][], cur: unknown) => {
    sel.innerHTML = opts.map(([v, t]) => `<option value="${v}"${String(v) === String(cur) ? " selected" : ""}>${t}</option>`).join("");
  };
  fill($<HTMLSelectElement>(".min"), Array.from({ length: 14 }, (_, i) => [i + 2, String(i + 2)] as [number, string]), model.get("minutes"));
  fill($<HTMLSelectElement>(".resv"), [[9, "9 (~175 m)"], [10, "10 (~66 m)"], [11, "11 (~25 m)"], [12, "12 (~9 m)"]], model.get("resolution"));
  $<HTMLSelectElement>(".mode").value = model.get("costing") as string;
  const cats = () => {
    const c: string[] = JSON.parse((model.get("categories") as string) || "[]");
    fill($<HTMLSelectElement>(".cat"), c.map((n) => [n, n.toLowerCase()] as [string, string]), model.get("category"));
  };
  cats();
  const meas = document.createElement("span");
  meas.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit;font-weight:600";
  root.appendChild(meas);
  const size = (sel: HTMLSelectElement) => {
    if (CSS.supports && CSS.supports("field-sizing", "content")) return;
    meas.textContent = sel.options[sel.selectedIndex]?.text || "";
    sel.style.width = meas.getBoundingClientRect().width + 2 + "px";
  };
  root.querySelectorAll<HTMLSelectElement>("select").forEach((sel) => { size(sel); sel.addEventListener("change", () => size(sel)); });
  const bind = (c: string, key: string, num: boolean) =>
    $<HTMLSelectElement>(c).addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      model.set(key, num ? parseInt(v, 10) : v);
      model.save_changes();
      $(".busy").textContent = "working";
    });
  bind(".min", "minutes", true); bind(".mode", "costing", false); bind(".cat", "category", false); bind(".resv", "resolution", true);
  const nbv = $<HTMLInputElement>(".nbv");
  nbv.checked = !!model.get("nbhd");
  nbv.addEventListener("change", () => { model.set("nbhd", nbv.checked); model.save_changes(); $(".busy").textContent = "working"; });
  // elevation scale: the slider and the number field move together; the layer redraws, the kernel is not asked
  let elevScale = 30;
  const hs = $<HTMLInputElement>(".hs"), hn = $<HTMLInputElement>(".hn");
  const setScale = (v: number, from: HTMLInputElement) => {
    if (!Number.isFinite(v) || v < 0) return;
    elevScale = v;
    if (from !== hs) hs.value = String(Math.min(v, 200));
    if (from !== hn) hn.value = String(v);
    draw();
  };
  hs.addEventListener("input", () => setScale(parseFloat(hs.value), hs));
  hn.addEventListener("input", () => setScale(parseFloat(hn.value), hn));
  const showCfg = () => {
    const c = cfg();
    if (c.area) $(".area").textContent = c.area;
    root.classList.toggle("flat", !!c.flat && !extruded);
    if (!c.ramp) return;
    $(".ramp").style.background = `linear-gradient(90deg, ${c.ramp.join(",")})`;
    $(".hi").textContent = c.nbhd ? "the most in its neighborhood" : `${c.vmax} within reach`;
    root.classList.toggle("nbhd", !!c.nbhd);
    $(".n").textContent = `${(c.buildings || 0).toLocaleString()} buildings, ${(c.places || 0).toLocaleString()} ${c.plural}`;
    $(".busy").textContent = c.busy ? "working" : "";
  };

  // ---- the map
  maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([maplibreWorker], { type: "text/javascript" })));
  const c0 = cfg().view || { lon: -73.935, lat: 40.7, zoom: 12.3, pitch: 55, bearing: 0 };
  let styleI = 0;
  const map = new maplibregl.Map({ container: $(".map"), style: STYLES[0][1], center: [c0.lon, c0.lat], zoom: c0.zoom, pitch: c0.pitch, bearing: c0.bearing,
    attributionControl: false, maxPitch: 75 });
  map.keyboard.disable();
  const overlay = new MapLibreOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);
  new ResizeObserver(() => map.resize()).observe($(".map"));
  new ResizeObserver(() => root.style.setProperty("--card-h", `${$(".card").offsetHeight}px`)).observe($(".card"));

  let table: arrow.Table | null = null;
  let batch: arrow.RecordBatch | null = null;
  let gen = 0; // a new layer id per data load: the GeoArrow layer trips on new accessors under an old id
  let dataType = "none";
  const col = <T>(name: string, i: number): T => table!.getChild(name)!.get(i) as T;
  let places: Place[] = [];
  const loadPlaces = () => { try { places = JSON.parse((model.get("places") as string) || "[]"); } catch { places = []; } };
  loadPlaces();
  // the rows of `places` whose sheds reach a part, and the parts of a building (parts of one building sit together)
  const idsOf = (i: number): number[] => { const v = table?.getChild("ids")?.get(i) as { toArray?: () => ArrayLike<number> } | null; return v && v.toArray ? Array.from(v.toArray()) : []; };
  const partsOf = (i: number): number[] => {
    const f = col<number>("fid", i), out = [i];
    for (let j = i - 1; j >= 0 && col<number>("fid", j) === f; j--) out.unshift(j);
    for (let j = i + 1; j < table!.numRows && col<number>("fid", j) === f; j++) out.push(j);
    return out;
  };
  const ringsOf = (i: number): [number, number][][] => {
    const g = table!.getChild("geometry")!.get(i) as { length: number; get: (r: number) => { length: number; get: (k: number) => { get: (d: number) => number } } };
    const rings: [number, number][][] = [];
    for (let r = 0; r < g.length; r++) { const ring = g.get(r), pts: [number, number][] = []; for (let k = 0; k < ring.length; k++) { const q = ring.get(k); pts.push([q.get(0), q.get(1)]); } rings.push(pts); }
    return rings;
  };
  let hot: number | null = null; // the part hovered or locked, in flat mode
  let extruded = !cfg().flat; // E toggles; the flat page starts flat
  let routes: Route[] = [];
  let routesFor: number | null = null; // the fid the routes answer
  let hotPlace: number | null = null; // while locked: the place ring under the cursor (position in the building's ids)

  // ---- the tooltip: hover follows the cursor, a click pins it (click again, or Esc, releases)
  const tip = $(".tip");
  let pinned: number | null = null;
  let last: { index: number; x: number; y: number } | null = null;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
  const place = (x: number, y: number) => {
    const W = root.clientWidth, H = root.clientHeight, w = tip.offsetWidth || 280, h = tip.offsetHeight || 80;
    let left = x + 16, top = y + 16;
    if (left + w > W - 8) left = x - w - 16;
    if (top + h > H - 8) top = Math.max(8, y - h - 16);
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${top}px`;
  };
  const showTip = (index: number, x: number, y: number) => {
    if (!table) return;
    const c = cfg();
    const n = col<number>("density", index);
    const ids = idsOf(index);
    const names = places.length && ids.length ? ids.map((i) => places[i]?.[2] || "").filter(Boolean).sort((a, b) => a.localeCompare(b)) : (col<string>("names", index) || "").split(", ").filter(Boolean);
    const fid = col<number>("fid", index);
    const ni = c.ntas ? col<number>("nta", index) : -1;
    const nta = ni >= 0 && c.ntas ? c.ntas[ni] : null;
    const where = nta ? ` in ${esc(nta.name)}${c.nbhd && nta.vmax ? `, most there ${nta.vmax}` : ""}` : "";
    const rt = c.flat && pinned !== null ? (routesFor === fid && routes.length ? `${routes.length} routes drawn, ${Math.min(...routes.map((r) => r.minutes)).toFixed(0)} to ${Math.max(...routes.map((r) => r.minutes)).toFixed(0)} min` : "finding the routes") : "";
    const shown = names.slice(0, NAMES_SHOWN), more = names.length - shown.length;
    const unit = n === 1 ? (c.plural || "places").replace(/ies$/, "y").replace(/s$/, "") : c.plural || "places";
    tip.innerHTML =
      `<div class="n">${n}<small>${esc(unit)} within a ${c.minutes ?? 5} minute ${(model.get("costing") as string) === "bicycle" ? "bike ride" : "walk"}${where}</small></div>` +
      `<ul class="names">${shown.map((s) => `<li>${esc(s)}</li>`).join("")}${more > 0 ? `<li class="more">and ${more} more</li>` : ""}</ul>` +
      (rt ? `<div class="routes">${esc(rt)}</div>` : "") +
      (pinned === null ? `<div class="hint">${extruded ? "E to flatten, then click to lock" : c.flat ? "click to lock and draw the routes" : "click to keep"}</div>` : `<div class="hint">click again or Esc to release</div>`);
    if (pinned !== null) {
      // locked: everything moves to the panel on the right; the hover tooltip goes away
      hideTip();
      side.classList.add("on");
      $(".side .head").innerHTML =
        `<div class="n">${n}<small>${esc(unit)} within a ${c.minutes ?? 5} minute ${(model.get("costing") as string) === "bicycle" ? "bike ride" : "walk"}${where}</small></div>` +
        (rt ? `<div class="routes">${esc(rt)}</div>` : "") + `<div class="hint">click anywhere or Esc to release</div>`;
      return;
    }
    tip.classList.add("on");
    tip.classList.remove("pinned");
    place(x, y);
  };
  const hideTip = () => { tip.classList.remove("on", "pinned"); };
  const side = $(".side");
  let htRoot: Root | null = null;
  const showTable = async (b64: string) => {
    const bin = atob(b64), buf = new ArrayBuffer(bin.length), u = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const rows = await parquetReadObjects({ file: { byteLength: buf.byteLength, slice: (a: number, b?: number) => buf.slice(a, b) } });
    if (!htRoot) htRoot = createRoot($(".side .ht"));
    htRoot.render(createElement(HighTable, { data: sortableDataFrame(arrayDataFrame(rows)), cacheKey: "fm-places", focus: false, onError: console.error } as never));
  };
  const hideSide = () => { side.classList.remove("on"); if (htRoot) { htRoot.unmount(); htRoot = null; } };
  // the small tooltip on a place ring while a building is locked: the name, the route's minutes and distance
  const ptip = $(".ptip");
  const showPlace = (k: number, x: number, y: number) => {
    const ids = idsOf(pinned!), pl = places[ids[k]];
    if (!pl) { hidePlace(); return; }
    const r = routes.find((q) => q.i === k);
    const how = (model.get("costing") as string) === "bicycle" ? "bike ride" : "walk";
    ptip.innerHTML = `<b>${esc(pl[2] || "unnamed")}</b>` + (r ? `<span>${r.minutes.toFixed(0)} min ${how}, ${r.meters >= 1000 ? (r.meters / 1000).toFixed(1) + " km" : r.meters.toFixed(0) + " m"}</span>` : "");
    ptip.classList.add("on");
    const W = root.clientWidth, w = ptip.offsetWidth || 160;
    let left = x + 14; if (left + w > W - 8) left = x - w - 14;
    ptip.style.left = `${Math.max(8, left)}px`; ptip.style.top = `${Math.max(8, y - 34)}px`;
  };
  const hidePlace = () => ptip.classList.remove("on");

  const layers = () => {
    if (!table || !batch) return [];
    const flat = !!cfg().flat;
    const lit = flat && !extruded && hot !== null;
    const up = extruded;
    const out: unknown[] = [
      new GeoArrowPolygonLayer({
        id: `buildings-${gen}`,
        data: batch,
        getPolygon: batch.getChild("geometry")!.data[0] as never,
        getFillColor: batch.getChild("rgba")!.data[0] as never,
        getElevation: batch.getChild("elev")!.data[0] as never,
        elevationScale: up ? elevScale : 0,
        extruded: up,
        filled: true,
        // a hairline in meters, never widened to a minimum: nothing at the area view (a few hundredths of a pixel),
        // a faint edge from about zoom 16 when a building is being picked, capped at one pixel
        stroked: true,
        getLineColor: [176, 200, 190, 110],
        getLineWidth: 1.5,
        lineWidthUnits: "meters",
        lineWidthMinPixels: 0,
        lineWidthMaxPixels: 1,
        // with a building hovered or locked the rest all but vanish, so its places and routes read
        opacity: lit ? 0.06 : 0.95,
        pickable: true,
        autoHighlight: !flat,
        highlightColor: [255, 255, 255, 110],
        earcutWorkerUrl: null,
        _validate: false,
      } as never),
    ];
    const c = cfg();
    if (c.nbhd && c.ntas) {
      out.push(
        new PolygonLayer({
          id: "ntas",
          data: c.ntas,
          getPolygon: (d: Nta) => d.rings,
          filled: false,
          stroked: true,
          getLineColor: [192, 192, 192, 170], // silver, kept thin so it stays a hint
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 0.5,
          lineWidthMaxPixels: 1,
          pickable: false,
          parameters: { depthTest: false }, // drawn over the footprints, not fought for the same depth
        }),
      );
    }
    if (!lit) return out;
    const parts = partsOf(hot!);
    const rgba = (table.getChild("rgba")!.get(hot!) as { toArray: () => ArrayLike<number> }).toArray();
    out.push(
      new PolygonLayer({
        id: "hot-building",
        data: parts.map((i) => ({ rings: ringsOf(i) })),
        getPolygon: (d: { rings: [number, number][][] }) => d.rings,
        getFillColor: [rgba[0], rgba[1], rgba[2], 255],
        getLineColor: [...LIT, 255],
        lineWidthMinPixels: 1.5,
        lineWidthMaxPixels: 3,
        getLineWidth: 2,
        filled: true,
        stroked: true,
        pickable: false,
      }),
    );
    const ramp = (cfg().ramp || []).map(hex);
    const minsMax = Math.max(cfg().minutes || 10, ...routes.map((r) => r.minutes));
    const rampAt = (minutes: number): [number, number, number] => {
      if (!ramp.length) return LIT;
      // 1 = closest = light end; the slowest route stays on the lighter half so it still shows over a dark basemap
      const t = 0.45 + 0.55 * (1 - Math.min(Math.max(minutes, 0), minsMax) / minsMax);
      return ramp[Math.round(t * (ramp.length - 1))];
    };
    if (pinned !== null && routesFor === col<number>("fid", hot!) && routes.length) {
      out.push(
        new PathLayer({
          id: "routes",
          data: routes,
          getPath: (d: Route) => d.path,
          // the ramp by travel time: the shortest route is the light end, the slowest the dark end
          getColor: (d: Route) => {
            if (hotPlace !== null) return d.i === hotPlace ? [...GOLD, 255] : [...rampAt(d.minutes), 60];
            return [...rampAt(d.minutes), 230];
          },
          getWidth: (d: Route) => (d.i === hotPlace ? 7 : 4),
          widthUnits: "meters",
          widthMinPixels: 2,
          widthMaxPixels: 9,
          capRounded: true,
          jointRounded: true,
          pickable: false,
          updateTriggers: { getColor: [hotPlace, routesFor], getWidth: hotPlace },
        }),
      );
    }
    out.push(
      new ScatterplotLayer({
        id: "hot-places",
        data: idsOf(hot!).map((i) => places[i]).filter(Boolean),
        getPosition: (d: Place) => [d[0], d[1]],
        // filled at alpha 1 so the ring's inside picks too, while locked
        filled: true,
        getFillColor: (_d: Place, o: { index: number }) => (o.index === hotPlace ? [...GOLD, 70] : [0, 0, 0, 1]),
        stroked: true,
        getLineColor: [...GOLD, 255],
        getLineWidth: (_d: Place, o: { index: number }) => (o.index === hotPlace ? 3 : 2),
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 1.5,
        getRadius: 11,
        radiusUnits: "meters",
        radiusMinPixels: 3.5,
        radiusMaxPixels: 8,
        pickable: pinned !== null,
        updateTriggers: { getFillColor: hotPlace, getLineWidth: hotPlace },
      }),
    );
    return out;
  };
  type Pick = { index: number; x: number; y: number; layer?: { id: string } | null };
  const setHot = (i: number | null) => { if (i === hot) return; hot = i; if (cfg().flat) draw(); };
  const onHover = (info: Pick) => {
    if (pinned !== null) {
      const k = info.index >= 0 && info.layer?.id === "hot-places" ? info.index : null;
      if (k !== hotPlace) { hotPlace = k; draw(); }
      if (k !== null) showPlace(k, info.x, info.y); else hidePlace();
      return;
    }
    if (info.index >= 0 && info.layer && info.layer.id.startsWith("buildings-")) { last = { index: info.index, x: info.x, y: info.y }; showTip(info.index, info.x, info.y); setHot(info.index); }
    else { last = null; hideTip(); setHot(null); }
  };
  // a lock asks the kernel for the routes from that building; the answer comes back on the custom channel
  const askRoutes = (index: number) => {
    const fid = col<number>("fid", index);
    routes = []; routesFor = null;
    try { model.send({ pin: fid }); } catch (e) { console.error("five-min: could not ask for routes", e); }
  };
  const release = () => { pinned = null; routes = []; routesFor = null; hotPlace = null; hidePlace(); hideTip(); hideSide(); setHot(null); try { model.send({ pin: -1 }); } catch { /* no channel */ } };
  model.on("msg:custom", (msg: unknown) => {
    const m = msg as { pin?: number; routes?: Route[]; table?: string } | null;
    if (!m || typeof m.pin !== "number" || !table) return;
    if (pinned === null || col<number>("fid", pinned) !== m.pin) return; // an answer for a building no longer locked
    routes = m.routes || []; routesFor = m.pin;
    if (last) showTip(pinned, last.x, last.y);
    if (m.table) showTable(m.table).catch((e) => console.error("five-min: could not read the places table", e));
    draw();
  });
  const clicks: unknown[] = [];
  const onClick = (info: Pick) => {
    clicks.push({ index: info.index, layer: info.layer?.id ?? null, x: info.x, y: info.y });
    const onBuilding = info.index >= 0 && !!info.layer && info.layer.id.startsWith("buildings-");
    // any click while a building is locked releases it, nothing more; the next click picks a building
    if (pinned !== null) {
      release();
      if (onBuilding) { last = { index: info.index, x: info.x, y: info.y }; showTip(info.index, info.x, info.y); setHot(info.index); }
      return;
    }
    if (!onBuilding) return;
    if (extruded) return; // extruded is for the scale only: nothing to lock
    pinned = info.index; last = { index: info.index, x: info.x, y: info.y }; hot = info.index;
    if (cfg().flat) askRoutes(info.index);
    showTip(info.index, info.x, info.y); draw();
  };
  let lastClick = 0;
  const onClickOnce = (info: Pick) => { const now = performance.now(); if (now - lastClick < 200) return; lastClick = now; onClick(info); };
  const draw = () => overlay.setProps({ layers: layers() as never, pickingRadius: 5, onHover: onHover as never, onClick: onClickOnce as never });
  type DeckLike = { _onPointerDown: (e: unknown) => void; _onEvent: (e: unknown) => void };
  const deck = () => (overlay as unknown as { _deck?: DeckLike })._deck;
  map.on("mousedown", (e: maplibregl.MapMouseEvent) => deck()?._onPointerDown({ type: "pointerdown", offsetCenter: e.point, srcEvent: e.originalEvent }));
  map.on("click", (e: maplibregl.MapMouseEvent) => deck()?._onEvent({ type: "click", offsetCenter: e.point, tapCount: 1, srcEvent: e.originalEvent }));
  const toBytes = (raw: unknown): Uint8Array | null => {
    if (!raw) return null;
    if (raw instanceof DataView) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (typeof raw === "string") { const b = atob(raw); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
    return null;
  };
  const loadData = () => {
    const raw = model.get("data");
    dataType = raw === null || raw === undefined ? "null" : (raw as object).constructor?.name || typeof raw;
    const bytes = toBytes(raw);
    if (!bytes || bytes.byteLength === 0) { table = null; batch = null; draw(); return; }
    try {
      table = arrow.tableFromIPC(bytes);
      batch = table.batches[0] ?? null;
      gen++;
    } catch (e) {
      console.error("five-min: could not read the buildings", e); table = null; batch = null;
    }
    pinned = null; hot = null; routes = []; routesFor = null; hideTip(); hideSide();
    draw();
  };
  // the buildings may have been sent before this page existed: if none arrived, ask the kernel once
  setTimeout(() => { if (!table) { model.set("ask", String(Date.now())); model.save_changes(); } }, 2500);
  map.on("load", () => { loadData(); showCfg(); });
  model.on("change:data", loadData);
  model.on("change:places", () => { loadPlaces(); if (hot !== null) draw(); });
  model.on("change:config", () => { showCfg(); draw(); }); // the neighborhood layers follow the config, not the data
  model.on("change:categories", cats);

  // ---- the page: X fills the window / back to the notebook, Esc back, F the browser's full screen
  const st = { fit: true };
  const sizes = () => {
    root.classList.toggle("fit", st.fit);
    document.documentElement.classList.toggle(FIT, st.fit);
    $(".xk").textContent = st.fit ? "notebook" : "fill window";
    setTimeout(() => map.resize(), 30);
  };
  const fsOn = () => !!(document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement);
  const fullScreen = () => {
    if (fsOn()) { document.exitFullscreen(); return; }
    const r = root.requestFullscreen?.(); if (r && r.catch) r.catch(() => {});
  };
  const onKey = (e: KeyboardEvent) => {
    const t = e.composedPath()[0] as HTMLElement | undefined, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (e.key === "x" || e.key === "X") { st.fit = !st.fit; sizes(); }
    else if (e.key === "f" || e.key === "F") fullScreen();
    else if (e.key === "m" || e.key === "M") nextStyle();
    else if (e.key === "e" || e.key === "E") toggleExtrude();
    else if (e.shiftKey && e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (e.key === "ArrowLeft") map.easeTo({ bearing: map.getBearing() - 10, duration: 250 });
      else if (e.key === "ArrowRight") map.easeTo({ bearing: map.getBearing() + 10, duration: 250 });
      else if (e.key === "ArrowUp") map.easeTo({ pitch: Math.min(80, map.getPitch() + 10), duration: 250 });
      else if (e.key === "ArrowDown") map.easeTo({ pitch: Math.max(0, map.getPitch() - 10), duration: 250 });
    }
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = 80, dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0, dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
      map.panBy([dx, dy], { duration: 200 });
    }
    else if (e.key === "Escape") { if (pinned !== null) release(); else if (st.fit && !fsOn()) { st.fit = false; sizes(); } }
  };
  const nextStyle = () => {
    styleI = (styleI + 1) % STYLES.length;
    map.setStyle(STYLES[styleI][1]);
    $(".mk").textContent = STYLES[(styleI + 1) % STYLES.length][0];
    root.classList.toggle("light", styleI !== 0);
  };
  const toggleExtrude = () => {
    extruded = !extruded;
    if (extruded && pinned !== null) release();
    $(".ek").textContent = extruded ? "flatten" : "extrude";
    root.classList.toggle("flat", !!cfg().flat && !extruded);
    if (extruded && map.getPitch() < 20) map.easeTo({ pitch: 50, duration: 500 });
    else if (!extruded && cfg().flat) map.easeTo({ pitch: 0, duration: 500 });
    draw();
  };
  $(".ke").onclick = toggleExtrude;
  $(".ek").textContent = extruded ? "flatten" : "extrude";
  const onFs = () => setTimeout(() => map.resize(), 60);
  $(".km").onclick = nextStyle;
  $(".kx").onclick = () => { st.fit = !st.fit; sizes(); };
  $(".kf").onclick = fullScreen;
  window.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFs);
  (window as unknown as { _fm: unknown })._fm = { st, sizes, map, tableRows: () => table?.numRows ?? 0, pinned: () => pinned, hot: () => hot, nbhd: () => !!cfg().nbhd, cfg, tipText: (i: number) => { showTip(i, 100, 100); return tip.innerText; }, extruded: () => extruded, toggleExtrude, hotPlace: () => hotPlace, placePts: () => (hot === null ? [] : idsOf(hot).map((i) => places[i]).filter(Boolean)), send: (m: unknown) => model.send(m), routes: () => routes.length, places: () => places.length, scale: () => elevScale, style: () => STYLES[styleI][0], dataType: () => dataType, batch: () => batch, overlay, clicks };
  sizes();
  showCfg();

  return () => {
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFs);
    document.documentElement.classList.remove(FIT);
    try { map.remove(); } catch { /* gone */ }
  };
}

export default { render };
