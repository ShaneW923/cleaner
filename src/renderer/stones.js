// Stone map: lays cache folders out as pebbles whose area matches their size.
// Squarified treemap → each cell drawn as a rounded, slightly irregular stone.
// Pure geometry (no DOM), exposed as window.Stones.
(function () {
  // Deterministic 0..1 random from a string, so a stone keeps its shape.
  function rand(seed, n) {
    let h = 2166136261;
    const s = seed + ':' + n;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }

  // Squarified treemap (Bruls et al.). nodes: [{value,...}] sorted desc.
  function squarify(nodes, x, y, w, h) {
    const total = nodes.reduce((s, n) => s + n.value, 0);
    if (!total || w <= 0 || h <= 0) return [];
    const scale = (w * h) / total;
    const items = nodes.map((n) => ({ node: n, area: n.value * scale }));
    const out = [];
    let rect = { x, y, w, h };

    function worst(row, side) {
      const sum = row.reduce((s, r) => s + r.area, 0);
      let max = -Infinity, min = Infinity;
      for (const r of row) { max = Math.max(max, r.area); min = Math.min(min, r.area); }
      return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
    }
    function layout(row) {
      const sum = row.reduce((s, r) => s + r.area, 0);
      if (rect.w >= rect.h) {
        const cw = sum / rect.h; let cy = rect.y;
        for (const r of row) { const ch = r.area / cw; out.push({ ...r.node, x: rect.x, y: cy, w: cw, h: ch }); cy += ch; }
        rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
      } else {
        const ch = sum / rect.w; let cx = rect.x;
        for (const r of row) { const cw = r.area / ch; out.push({ ...r.node, x: cx, y: rect.y, w: cw, h: ch }); cx += cw; }
        rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
      }
    }

    let row = [];
    for (const it of items) {
      const side = Math.min(rect.w, rect.h);
      if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
      else { layout(row); row = [it]; }
    }
    if (row.length) layout(row);
    return out;
  }

  // Rounded, irregular quadrilateral inside a cell → SVG path.
  function stonePath(cell, gap, seed) {
    const x0 = cell.x + gap, y0 = cell.y + gap;
    const x1 = cell.x + cell.w - gap, y1 = cell.y + cell.h - gap;
    const w = x1 - x0, h = y1 - y0;
    if (w < 2 || h < 2) return null;
    const j = Math.min(w, h) * 0.14; // how far corners wander inward
    const pts = [
      [x0 + rand(seed, 1) * j, y0 + rand(seed, 2) * j],
      [x1 - rand(seed, 3) * j, y0 + rand(seed, 4) * j],
      [x1 - rand(seed, 5) * j, y1 - rand(seed, 6) * j],
      [x0 + rand(seed, 7) * j, y1 - rand(seed, 8) * j],
    ];
    let d = '';
    for (let i = 0; i < 4; i++) {
      const prev = pts[(i + 3) % 4], cur = pts[i], next = pts[(i + 1) % 4];
      const r = Math.min(dist(prev, cur), dist(cur, next)) * (0.28 + rand(seed, 9 + i) * 0.16);
      const a = toward(cur, prev, r), b = toward(cur, next, r);
      d += (i === 0 ? `M${a[0]},${a[1]}` : `L${a[0]},${a[1]}`) + `Q${cur[0]},${cur[1]} ${b[0]},${b[1]}`;
    }
    return d + 'Z';
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function toward(from, to, r) {
    const d = dist(from, to) || 1;
    return [from[0] + ((to[0] - from[0]) * r) / d, from[1] + ((to[1] - from[1]) * r) / d];
  }

  window.Stones = { squarify, stonePath };
})();
