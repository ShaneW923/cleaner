const $ = (id) => document.getElementById(id);

// Opened as a plain web page (not inside the Electron app) → no file access.
if (!window.cleaner) {
  document.body.innerHTML =
    '<p style="padding:40px;text-align:center">这是界面预览，不能扫描。请在项目里运行 <code>npm start</code> 打开 App。</p>';
  throw new Error('window.cleaner missing: not running inside Electron');
}

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_STONES = 28;
// Only the "recommend" card offers select-all; the others are picked one by one.
const LEVELS = [
  { key: 'recommend', title: '推荐清理', desc: '删了没有任何影响', open: true, selectAll: true },
  { key: 'ok', title: '可以清理', desc: '不会丢数据，但有一点代价，看每项的标签', open: true, selectAll: false, limit: 8 },
  { key: 'keep', title: '不建议', desc: 'macOS 系统缓存，系统会自己管理', open: false, selectAll: false, limit: 8 },
];

// Chips shown under each name; the full sentence (item.reason) appears on hover.
// The first tag is always the consequence of deleting; status tags follow.
const TAGS = {
  // 推荐清理
  noimpact: { label: '无影响', tone: 'good' },
  redownload: { label: '需要时重新下载', tone: 'good' },
  // 可以清理
  slower: { label: '打开会变慢' },
  media: { label: '含图片视频', tone: 'warn' },
  maybechat: { label: '可能含聊天文件', tone: 'warn' },
  unknown: { label: '来源不明', tone: 'warn' },
  // 不建议
  system: { label: '系统管理' },
  // status
  running: { label: '运行中', tone: 'status' },
  partial: { label: '部分无权限', tone: 'status' },
};

const state = {
  items: new Map(),   // id → item (item.trashed once moved to Trash)
  selected: new Set(),
  open: Object.fromEntries(LEVELS.map((l) => [l.key, l.open])),
  showAll: {},
  scanning: false,
  scanned: false,
  progress: { done: 0, total: 0, current: '' },
  disk: null,
  freedThisSession: 0,
  seenStones: new Set(),
  hot: null,
};

// ---------- formatting ----------
// precise: always keep one decimal, so free space visibly changes as you select
function split(bytes, precise = false) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) { bytes /= 1000; i++; }
  const num = i === 0 ? String(Math.round(bytes)) : bytes >= 100 && !precise ? bytes.toFixed(0) : bytes.toFixed(1);
  return [num, units[i]];
}
const fmt = (b) => split(b).join(' ');
const fmtPrecise = (b) => split(b, true).join(' ');
const label = (it) => it.displayName || it.appName || it.folder;
const live = () => [...state.items.values()].filter((i) => !i.trashed);
const sum = (arr) => arr.reduce((s, i) => s + i.bytes, 0);

// ---------- render: hero ----------
function renderHero() {
  const all = live();
  const rec = all.filter((i) => i.level === 'recommend');
  const selBytes = sum(all.filter((i) => state.selected.has(i.id)));
  const free = state.disk ? state.disk.free : null;
  let big = null, caption, summary = '';

  // Big number = free disk space, plus whatever is selected for cleaning.
  if (free !== null) {
    big = free + selBytes;
    caption = selBytes ? `清理所选后可用（现在 ${fmtPrecise(free)}，多出 ${fmt(selBytes)}）` : '磁盘可用空间';
  }

  if (state.scanning) {
    const { done, total, current } = state.progress;
    caption = total ? `正在扫描 ${done}/${total} · ${current}` : '正在准备…';
  } else if (!state.scanned) {
    if (free === null) caption = '扫描缓存，看看哪些能放心清理';
  } else {
    summary = state.freedThisSession
      ? `已释放 ${fmt(state.freedThisSession)}，在废纸篓里，清空后才真正腾出空间。`
      : rec.length
        ? `可以清理 ${fmt(sum(all.filter((i) => i.level !== 'keep')))}，其中 ${fmt(sum(rec))} 可以放心删除。`
        : '没有推荐清理的内容。';
  }

  document.querySelector('.big').hidden = big === null;
  if (big === null) { $('bigNum').textContent = ''; $('bigUnit').textContent = ''; }
  else { const [n, u] = split(big, true); $('bigNum').textContent = n; $('bigUnit').textContent = u; }
  $('bigCaption').textContent = caption;
  $('summary').textContent = summary;
  $('progressLine').hidden = !state.scanning;
  const { done, total } = state.progress;
  $('progressBar').style.width = total ? `${(done / total) * 100}%` : '0';
  renderDisk(sum(all), selBytes);
}

function renderDisk(cacheBytes, selBytes) {
  const d = state.disk;
  $('disk').hidden = !d;
  if (!d) return;
  const used = d.total - d.free;
  const parts = {
    Used: Math.max(0, used - cacheBytes),
    Cache: cacheBytes - selBytes,
    Sel: selBytes,
    Free: d.free,
  };
  for (const [k, v] of Object.entries(parts)) {
    const pct = (v / d.total) * 100;
    // Keep tiny-but-nonzero segments visible as a sliver
    $('seg' + k).style.width = v > 0 ? `max(3px, ${pct}%)` : '0';
    $('seg' + k).dataset.w = v > 0 ? '1' : '0';
  }
  $('lgUsed').textContent = fmt(parts.Used);
  $('lgUsedName').textContent = cacheBytes ? '其他占用' : '已用';
  $('lgCache').textContent = fmt(cacheBytes);
  $('lgCacheWrap').hidden = !cacheBytes;
  $('lgSel').textContent = fmt(selBytes);
  $('lgSelWrap').hidden = !selBytes;
  $('lgFree').textContent = fmtPrecise(d.free);
  $('diskTotal').textContent = `磁盘共 ${fmt(d.total)}，已用 ${fmt(used)}（${Math.round((used / d.total) * 100)}%）`;
}

// ---------- render: grouped list ----------
function renderGroups() {
  const box = $('groups');
  box.replaceChildren();
  for (const lvl of LEVELS) {
    const list = live().filter((i) => i.level === lvl.key).sort((a, b) => b.bytes - a.bytes);
    if (!list.length) continue;
    const sel = list.filter((i) => state.selected.has(i.id));

    const g = el('div', `group ${lvl.key}`);
    const head = el('div', 'group-head');
    head.onclick = () => { state.open[lvl.key] = !state.open[lvl.key]; renderGroups(); };
    const top = el('div', 'head-top');
    top.append(el('span', `dot ${lvl.key}`), el('span', 'title', lvl.title));
    top.append(el('span', 'meta', sel.length ? `已选 ${fmt(sum(sel))} / ${fmt(sum(list))}` : `${list.length} 项 · ${fmt(sum(list))}`));
    top.append(el('span', 'fold', state.open[lvl.key] ? '收起' : '展开'));
    const bottom = el('div', 'head-bottom');
    bottom.append(el('span', 'desc', lvl.desc));
    if (lvl.selectAll) {
      const allOn = sel.length === list.length;
      const t = el('button', 'pill', allOn ? '取消全选' : '全选这组');
      t.onclick = (e) => {
        e.stopPropagation();
        list.forEach((i) => (allOn ? state.selected.delete(i.id) : state.selected.add(i.id)));
        renderAll();
      };
      bottom.append(t);
    }
    head.append(top, bottom);
    g.append(head);

    if (state.open[lvl.key]) {
      // Long groups show their biggest few until expanded, so cards stay readable.
      const limit = lvl.limit && !state.showAll[lvl.key] ? lvl.limit : Infinity;
      const ul = el('ul', 'rows');
      for (const it of list.slice(0, limit)) ul.append(row(it));
      g.append(ul);
      if (list.length > limit) {
        const more = el('button', 'more', `显示其余 ${list.length - limit} 项 · ${fmt(sum(list.slice(limit)))}`);
        more.onclick = () => { state.showAll[lvl.key] = true; renderGroups(); };
        g.append(more);
      }
    }
    box.append(g);
  }
}

function row(it) {
  const li = el('li', 'row');
  li.dataset.id = it.id;
  if (state.hot === it.id) li.classList.add('hot');

  const cb = el('input', 'check');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(it.id);
  cb.onchange = () => toggle(it.id);

  const icon = it.icon ? Object.assign(el('img'), { src: it.icon }) : el('span');

  const name = el('div', 'name');
  const tags = el('div', 'tags');
  for (const key of it.tags || []) {
    const def = TAGS[key];
    if (def) tags.append(el('span', `tag ${def.tone || ''}`, def.label));
  }
  name.append(el('div', 't', label(it)), tags);

  li.append(cb, icon, name, el('span', 'size', fmt(it.bytes)));
  li.onmouseenter = () => setHot(it.id);
  li.onmousemove = (e) => showTip(e, label(it), fmt(it.bytes), it.reason, it.path);
  li.onmouseleave = () => { setHot(null); hideTip(); };
  li.ondblclick = () => window.cleaner.reveal(it.path);
  return li;
}

// ---------- render: stone garden ----------
function renderGarden() {
  const svg = $('map');
  const { width, height } = svg.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  $('emptyGarden').hidden = state.items.size > 0;
  if (!state.items.size || width < 10) return;

  // Biggest folders get their own stone; the rest gather into one "其他" stone per level.
  const all = [...state.items.values()].sort((a, b) => b.bytes - a.bytes);
  const nodes = all.slice(0, MAX_STONES).map((it) => ({ value: it.bytes, it }));
  for (const lvl of LEVELS) {
    const rest = all.slice(MAX_STONES).filter((i) => i.level === lvl.key && !i.trashed);
    if (rest.length) nodes.push({ value: sum(rest), other: { level: lvl.key, count: rest.length, bytes: sum(rest) } });
  }
  nodes.sort((a, b) => b.value - a.value);

  // Free space gets its own column on the right. It isn't drawn to scale —
  // at 10x+ the cache total it would shrink every stone to a dot.
  let mapW = width;
  if (state.disk) {
    const freeW = Math.max(170, Math.round(width * 0.24));
    mapW = width - freeW;
    svg.append(freeArea({ x: mapW, y: 0, w: freeW, h: height }));
  }

  for (const cell of window.Stones.squarify(nodes, 0, 0, mapW, height)) {
    const seed = cell.it ? cell.it.id : 'other-' + cell.other.level;
    const d = window.Stones.stonePath(cell, 5, seed);
    if (!d) continue;
    if (cell.it && cell.it.trashed) svg.append(sand(cell, seed));
    else svg.append(stone(cell, d, seed));
  }
}

function stone(cell, d, seed) {
  const it = cell.it;
  const level = it ? it.level : cell.other.level;
  const g = svgEl('g', { class: `stone ${level}` });
  if (!it) g.classList.add('other');
  if (it && state.selected.has(it.id)) g.classList.add('selected');
  if (it && state.hot === it.id) g.classList.add('hot');
  if (!state.seenStones.has(seed)) { g.classList.add('new'); state.seenStones.add(seed); }
  g.dataset.id = it ? it.id : '';

  const ringD = window.Stones.stonePath(cell, 1.5, seed);
  if (ringD) g.append(svgEl('path', { d: ringD, class: 'ring' }));
  g.append(svgEl('path', { d, class: 'body' }));

  const name = it ? label(it) : `其他 ${cell.other.count} 项`;
  const bytes = it ? it.bytes : cell.other.bytes;
  const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
  if (cell.w > 70 && cell.h > 44) {
    g.append(svgEl('text', { x: cx, y: cy - 2 }, clip(name, cell.w)));
    g.append(svgEl('text', { x: cx, y: cy + 15, class: 'size' }, fmt(bytes)));
  } else if (cell.w > 64 && cell.h > 26) {
    g.append(svgEl('text', { x: cx, y: cy + 4, class: 'size' }, fmt(bytes)));
  }

  g.onmousemove = (e) => showTip(e, name, fmt(bytes), it ? it.reason : '较小的缓存合在一起，可以在左边列表里逐项选择');
  g.onmouseleave = () => { hideTip(); if (it) setHot(null); };
  if (it) {
    g.onmouseenter = () => setHot(it.id);
    g.onclick = () => toggle(it.id);
  }
  return g;
}

// A cleaned stone leaves raked sand: concentric outlines of its old shape.
function sand(cell, seed) {
  const g = svgEl('g', { class: 'sand' });
  const inner = svgEl('g', { class: state.seenStones.has('sand-' + seed) ? '' : 'appear' });
  state.seenStones.add('sand-' + seed);
  const steps = Math.max(2, Math.min(6, Math.floor(Math.min(cell.w, cell.h) / 18)));
  for (let k = 0; k < steps; k++) {
    const inset = 5 + k * (Math.min(cell.w, cell.h) / 2 - 8) / steps;
    const d = window.Stones.stonePath(cell, inset, seed);
    if (d) inner.append(svgEl('path', { d }));
  }
  g.append(inner);
  if (cell.w > 70 && cell.h > 30) {
    g.append(svgEl('text', { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 + 4 }, `已释放 ${fmt(cell.it.bytes)}`));
  }
  return g;
}

// Free disk space: raked sand around an empty centre, with the figure in it.
function freeArea(cell) {
  const free = state.disk.free;
  const selBytes = sum(live().filter((i) => state.selected.has(i.id)));
  const g = svgEl('g', { class: 'free-area' });
  const seed = 'free-space';
  const steps = 7;
  for (let k = 0; k < steps; k++) {
    const inset = 5 + k * (Math.min(cell.w, cell.h) / 2 - 64) / steps; // leave room for the figure
    const d = window.Stones.stonePath(cell, inset, seed);
    if (d) g.append(svgEl('path', { d, class: k === 0 ? 'edge' : 'rake' }));
  }
  const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
  g.append(svgEl('text', { x: cx, y: cy - 14, class: 'free-label' }, '可用'));
  g.append(svgEl('text', { x: cx, y: cy + 14, class: 'free-num' }, fmtPrecise(free)));
  if (selBytes) g.append(svgEl('text', { x: cx, y: cy + 36, class: 'free-after' }, `清理后 +${fmt(selBytes)}`));
  const ratio = Math.round(free / Math.max(1, sum(live())));
  g.onmousemove = (e) => showTip(e, '磁盘可用空间', fmt(free),
    `磁盘共 ${fmt(state.disk.total)}。这一块不按比例画，实际约是缓存总量的 ${ratio} 倍`);
  g.onmouseleave = hideTip;
  return g;
}

function clip(text, width) {
  const max = Math.max(3, Math.floor((width - 16) / 12));
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ---------- interaction ----------
function toggle(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  renderAll();
}

function setHot(id) {
  state.hot = id;
  document.querySelectorAll('.row.hot, .stone.hot').forEach((n) => n.classList.remove('hot'));
  if (!id) return;
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.add('hot'));
}

// One floating tooltip for the whole window (list rows and stones).
function showTip(e, title, size, reason, path) {
  const tip = $('tooltip');
  tip.replaceChildren(el('div', 'tt', `${title} · ${size}`), el('div', 'tr', reason));
  if (path) tip.append(el('div', 'tp', path.replace(/^\/Users\/[^/]+/, '~')));
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 18 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() { $('tooltip').hidden = true; }

function renderFooter() {
  const sel = [...state.selected].map((id) => state.items.get(id)).filter(Boolean);
  $('selectedInfo').textContent = sel.length ? `已选 ${sel.length} 项 · ${fmt(sum(sel))}` : '未选择';
  $('trashBtn').disabled = state.scanning || !sel.length;
}

function renderAll() {
  renderHero();
  renderGroups();
  renderGarden();
  renderFooter();
}

let queued = false;
function queueRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; renderAll(); });
}

// ---------- scanning ----------
window.cleaner.onItem((it) => {
  if (it.bytes === 0) return;
  state.items.set(it.id, it);
  queueRender();
});
window.cleaner.onProgress((p) => {
  if (!state.scanning) return;
  state.progress = p;
  renderHero();
});

async function startScan() {
  Object.assign(state, { scanning: true, freedThisSession: 0, progress: { done: 0, total: 0, current: '' } });
  state.items.clear();
  state.selected.clear();
  state.seenStones.clear();
  $('scanBtn').hidden = true;
  $('cancelBtn').hidden = false;
  renderAll();

  const [res, disk] = await Promise.all([window.cleaner.startScan(), window.cleaner.diskSpace()]);
  Object.assign(state, { scanning: false, scanned: true, disk });
  $('scanBtn').hidden = false;
  $('scanBtn').textContent = '重新扫描';
  $('cancelBtn').hidden = true;
  renderAll();
  if (!res.ok) $('summary').textContent = `扫描出错：${res.error}`;
  else if (res.cancelled) $('summary').textContent = '扫描已停止，下面是已经找到的部分。';
}

$('scanBtn').onclick = startScan;
$('bigScanBtn').onclick = startScan;
$('cancelBtn').onclick = () => window.cleaner.cancelScan();

// ---------- trash ----------
$('trashBtn').onclick = () => {
  const sel = [...state.selected].map((id) => state.items.get(id));
  const keep = sel.filter((i) => i.level === 'keep').length;
  const running = sel.filter((i) => i.appRunning).map(label);
  $('confirmTitle').textContent = `把 ${sel.length} 项（${fmt(sum(sel))}）移到废纸篓？`;
  $('confirmText').textContent =
    [keep ? `其中 ${keep} 项是不建议清理的 macOS 系统缓存。` : '',
     running.length ? `${running.join('、')} 正在运行，建议先退出。` : '']
      .join(' ').trim() || '这些都是缓存，App 需要时会自己重建。';
  $('confirm').showModal();
};
$('confirmNo').onclick = () => $('confirm').close();
$('confirmYes').onclick = async () => {
  $('confirm').close();
  const targets = [...state.selected].map((id) => state.items.get(id));
  const results = await window.cleaner.trash(targets.map((i) => i.path));
  const failed = [];
  results.forEach((r, k) => {
    const it = targets[k];
    if (r.ok) { it.trashed = true; state.freedThisSession += it.bytes; state.selected.delete(it.id); }
    else failed.push(`${label(it)}：${r.error}`);
  });
  state.disk = (await window.cleaner.diskSpace()) || state.disk;
  renderAll();
  if (failed.length) $('summary').textContent += ` ${failed.length} 项没有移动：${failed.join('；')}`;
};

// ---------- helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

new ResizeObserver(() => renderGarden()).observe($('garden'));
renderAll();
// Show the disk overview straight away, before any scan.
window.cleaner.diskSpace().then((disk) => { state.disk = disk; renderAll(); });
