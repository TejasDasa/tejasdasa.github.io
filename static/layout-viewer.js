// Layout viewer: pan/zoom over per-layer mask tiles written by layout-export.
// The server renders level 0 with working CSS layer toggles; this adds
// deeper levels, pan, zoom, a scale bar and a coordinate readout.
(() => {
  "use strict";

  for (const fig of document.querySelectorAll("figure.lv")) init(fig);

  async function init(fig) {
    const base = fig.dataset.base;
    const stage = fig.querySelector(".lv-stage");
    let m;
    try {
      const res = await fetch(`${base}/manifest.json`);
      if (!res.ok) return;
      m = await res.json();
    } catch {
      return;
    }

    const [dieW, dieH] = m.die_um;
    const T = m.tile_px;
    const maxZ = m.levels.length - 1;
    const toggles = new Map([...fig.querySelectorAll(".lv-toggle")].map((t) => [t.dataset.layer, t]));

    const has = (layer, z, x, y) => {
      const lv = m.levels[z];
      const i = y * lv.cols + x;
      const nib = parseInt(layer.tiles[z][i >> 2], 16);
      return (nib & (8 >> (i & 3))) !== 0;
    };

    // Live plane, one container per layer so the CSS toggle rules apply.
    const plane = document.createElement("div");
    plane.className = "lv-plane lv-live";
    const layers = m.layers.map((l) => {
      const el = document.createElement("div");
      el.className = `lv-layer lv-l-${l.id}`;
      el.style.setProperty("--c", l.color);
      plane.append(el);
      return { l, el, tiles: new Map() }; // key "z/x/y" -> { el, z, x, y, loaded }
    });
    stage.append(plane);

    const hud = document.createElement("div");
    hud.className = "lv-hud";
    hud.innerHTML =
      '<div class="lv-buttons">' +
      '<button type="button" data-act="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-act="out" aria-label="Zoom out">−</button>' +
      '<button type="button" data-act="fit" aria-label="Fit die">fit</button></div>' +
      '<div class="lv-scale"><span class="lv-bar"></span><span class="lv-scale-label"></span></div>' +
      '<div class="lv-readout" aria-live="off"></div>' +
      '<div class="lv-hint">drag to pan · click then scroll, or pinch, to zoom</div>';
    stage.append(hud);
    stage.classList.add("lv-on");
    const bar = hud.querySelector(".lv-bar");
    const scaleLabel = hud.querySelector(".lv-scale-label");
    const readout = hud.querySelector(".lv-readout");

    // View: `scale` CSS px per µm; (cx, cy) view centre in µm, y down from the top edge.
    // scale starts at 0 so the first resize snaps to fit.
    let W = 0, H = 0, fit = 1, scale = 0, cx = dieW / 2, cy = dieH / 2;
    const maxScale = () => (m.levels[maxZ].px_per_um * 2) / (devicePixelRatio || 1);

    function clamp() {
      scale = Math.min(Math.max(scale, fit), Math.max(fit, maxScale()));
      const hw = W / 2 / scale, hh = H / 2 / scale;
      cx = hw * 2 >= dieW ? dieW / 2 : Math.min(Math.max(cx, hw), dieW - hw);
      cy = hh * 2 >= dieH ? dieH / 2 : Math.min(Math.max(cy, hh), dieH - hh);
    }

    function resize() {
      const wasFit = scale <= fit * 1.0001;
      W = stage.clientWidth;
      H = stage.clientHeight;
      fit = Math.min(W / dieW, H / dieH);
      if (wasFit) scale = fit;
      clamp();
      schedule();
    }

    let frame = 0;
    function schedule() {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
    }

    function place(el, z, x, y, x0, y0) {
      const tUm = T / m.levels[z].px_per_um;
      const l = Math.round((x * tUm - x0) * scale), r = Math.round(((x + 1) * tUm - x0) * scale);
      const t = Math.round((y * tUm - y0) * scale), b = Math.round(((y + 1) * tUm - y0) * scale);
      el.style.transform = `translate(${l}px, ${t}px)`;
      el.style.width = `${r - l}px`;
      el.style.height = `${b - t}px`;
    }

    let firstComplete = false;
    function render() {
      if (!W || !H) return;
      const dpr = devicePixelRatio || 1;
      let z = m.levels.findIndex((lv) => lv.px_per_um >= scale * dpr);
      if (z < 0) z = maxZ;
      const lv = m.levels[z];
      const tUm = T / lv.px_per_um;
      const x0 = cx - W / 2 / scale, y0 = cy - H / 2 / scale;
      const tx0 = Math.max(0, Math.floor(x0 / tUm)), ty0 = Math.max(0, Math.floor(y0 / tUm));
      const tx1 = Math.min(lv.cols - 1, Math.floor((x0 + W / scale) / tUm));
      const ty1 = Math.min(lv.rows - 1, Math.floor((y0 + H / scale) / tUm));

      let allLoaded = true;
      for (const L of layers) {
        const on = toggles.get(L.l.id)?.checked;
        const want = new Set();
        if (on) {
          for (let y = ty0; y <= ty1; y++) {
            for (let x = tx0; x <= tx1; x++) {
              if (!has(L.l, z, x, y)) continue;
              const key = `${z}/${x}/${y}`;
              want.add(key);
              if (!L.tiles.has(key)) load(L, key, z, x, y);
            }
          }
        }
        const current = [...want].every((k) => L.tiles.get(k)?.loaded);
        if (on && !current) allLoaded = false;
        for (const [key, t] of L.tiles) {
          // Keep other levels' tiles only until this level has fully arrived.
          const keep = want.has(key) || (on && !current && t.loaded && t.z !== z);
          if (!keep) {
            t.el.remove();
            t.img.onload = null;
            L.tiles.delete(key);
          } else if (t.loaded) {
            place(t.el, t.z, t.x, t.y, x0, y0);
          }
        }
      }
      if (allLoaded && !firstComplete) {
        firstComplete = true;
        fig.querySelector(".lv-static").hidden = true;
      }
      hudUpdate(z);
    }

    function load(L, key, z, x, y) {
      const url = `${base}/tiles/${L.l.id}/${z}/${x}_${y}.png?v=${fig.dataset.version}`;
      const el = document.createElement("i");
      const img = new Image();
      const t = { el, img, z, x, y, loaded: false };
      img.onload = () => {
        t.loaded = true;
        el.style.setProperty("--m", `url("${url}")`);
        L.el.append(el);
        schedule();
      };
      img.src = url;
      L.tiles.set(key, t);
    }

    function hudUpdate(z) {
      // Scale bar: the largest 1/2/5 × 10^n µm that fits in ~120 px.
      const target = 120 / scale;
      const p = Math.pow(10, Math.floor(Math.log10(target)));
      const len = [5, 2, 1].map((k) => k * p).find((v) => v <= target) || p;
      bar.style.width = `${len * scale}px`;
      scaleLabel.textContent = `${len >= 1 ? len : len.toPrecision(1)} µm · z${z}`;
    }

    function zoomAt(factor, px, py) {
      const ux = cx + (px - W / 2) / scale, uy = cy + (py - H / 2) / scale;
      scale *= factor;
      clamp();
      cx = ux - (px - W / 2) / scale;
      cy = uy - (py - H / 2) / scale;
      clamp();
      schedule();
    }

    // Pointer: one pointer pans, two pinch-zoom.
    const pointers = new Map();
    let pinch = 0;
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".lv-buttons")) return;
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinch = 0;
    });
    stage.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      const ux = cx + (e.clientX - r.left - W / 2) / scale;
      const uy = cy + (e.clientY - r.top - H / 2) / scale;
      readout.textContent = ux >= 0 && ux <= dieW && uy >= 0 && uy <= dieH
        ? `x ${ux.toFixed(2)}  y ${(dieH - uy).toFixed(2)} µm` : "";
      const p = pointers.get(e.pointerId);
      if (!p) return;
      if (pointers.size === 1) {
        cx -= (e.clientX - p.x) / scale;
        cy -= (e.clientY - p.y) / scale;
        clamp();
        schedule();
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const other = a === p ? b : a;
        const d = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (pinch) zoomAt(d / pinch, (e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top);
        pinch = d;
      }
      p.x = e.clientX;
      p.y = e.clientY;
    });
    const up = (e) => { pointers.delete(e.pointerId); pinch = 0; };
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    stage.addEventListener("pointerleave", () => { readout.textContent = ""; });

    // The wheel zooms only once the viewer has focus, so it never hijacks page scroll.
    stage.addEventListener("wheel", (e) => {
      if (document.activeElement !== stage && !e.ctrlKey) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener("dblclick", (e) => {
      const r = stage.getBoundingClientRect();
      zoomAt(e.shiftKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
    });
    stage.addEventListener("keydown", (e) => {
      const step = 64 / scale;
      const acts = {
        "+": () => zoomAt(1.5, W / 2, H / 2), "=": () => zoomAt(1.5, W / 2, H / 2),
        "-": () => zoomAt(1 / 1.5, W / 2, H / 2), "0": () => { scale = fit; clamp(); schedule(); },
        ArrowLeft: () => { cx -= step; }, ArrowRight: () => { cx += step; },
        ArrowUp: () => { cy -= step; }, ArrowDown: () => { cy += step; },
      };
      const f = acts[e.key];
      if (!f) return;
      e.preventDefault();
      f();
      clamp();
      schedule();
    });
    hud.querySelector(".lv-buttons").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "in") zoomAt(2, W / 2, H / 2);
      else if (act === "out") zoomAt(0.5, W / 2, H / 2);
      else if (act === "fit") { scale = fit; clamp(); schedule(); }
    });
    for (const t of toggles.values()) t.addEventListener("change", schedule);

    new ResizeObserver(resize).observe(stage);
    resize();
  }
})();
