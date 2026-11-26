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
// Cards never collapse, so every ticked row stays visible. desc shows on hover.
const LEVELS = [
  { key: 'recommend', title: '推荐清理', selectAll: true,
    desc: '安装包、下载缓存、编译缓存、崩溃报告、日志，删了没有任何影响。会直接永久删除，空间马上释放' },
  { key: 'ok', title: '可以清理', selectAll: false, limit: 8,
    desc: '不会丢数据，但有一点代价，看每一项的标签。会移到废纸篓，可以放回' },
  { key: 'keep', title: '不建议', selectAll: false, limit: 8,
    desc: 'macOS 系统缓存，系统会自己管理，清理收益很小。勾选的话会移到废纸篓' },
];

// Chips shown under each name; the full sentence (item.reason) appears on hover.
// The first tag says what the folder IS; warnings and status follow.
// (Whether to delete is the group; what it costs is in the hover text.)
const TAGS = {
  installer: { label: '安装包', tone: 'type' },
  download: { label: '下载缓存', tone: 'type' },
  build: { label: '编译缓存', tone: 'type' },
  oldversion: { label: '旧版本', tone: 'type' },
  crash: { label: '崩溃报告', tone: 'type' },
  log: { label: '日志', tone: 'type' },
  web: { label: '网页缓存', tone: 'type' },
  image: { label: '图片缓存', tone: 'type' },
  network: { label: '网络缓存', tone: 'type' },
  chat: { label: '聊天缓存', tone: 'type' },
  appcache: { label: 'App 缓存', tone: 'type' },
  toolcache: { label: '工具缓存', tone: 'type' },
  model: { label: 'AI 模型', tone: 'type' },
  runtime: { label: '运行环境', tone: 'type' },
  system: { label: '系统缓存', tone: 'type' },
  // warnings
  orphan: { label: '未找到 App', tone: 'warn' },
  media: { label: '含聊天图片', tone: 'warn' },
  maybechat: { label: '可能含聊天文件', tone: 'warn' },
  // status
  running: { label: '运行中', tone: 'status' },
  partial: { label: '部分无权限', tone: 'status' },
};

const STATUS_TAGS = new Set(['running', 'partial']);

const state = {
  items: new Map(),   // row key → row (row.cleaned = 'deleted' | 'trashed' once done)
  selected: new Set(),
  showAll: {},
  scanning: false,
  scanned: false,
  progress: { done: 0, total: 0, current: '' },
  disk: null,
  cleaning: false,
  seenStones: new Set(),
  hot: null,
  protected: new Set(), // row keys the user protected (saved on disk)
  protectError: null,   // protect list unreadable → cleaning is disabled
  lastResult: null,     // summary line after cleaning
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
const live = () => [...state.items.values()].filter((i) => !i.cleaned && !state.protected.has(i.id));
const protectedItems = () => [...state.items.values()].filter((i) => !i.cleaned && state.protected.has(i.id));
const selectedItems = () => live().filter((i) => state.selected.has(i.id));
// Recommended rows are deleted permanently (space freed now); the rest go to the Trash
const willDelete = (i) => i.level === 'recommend';
const sum = (arr) => arr.reduce((s, i) => s + i.bytes, 0);

// ---------- render: hero ----------
function renderHero() {
  const all = live();
  const rec = all.filter((i) => i.level === 'recommend');
  const sel = selectedItems();
  const freeing = sum(sel.filter(willDelete));        // freed right away
  const toTrash = sum(sel.filter((i) => !willDelete(i))); // freed when the Trash is emptied
  const free = state.disk ? state.disk.free : null;
  let caption = '', summary = '';

  // Big number is always "available space". With something selected that
  // will be deleted: small "now →" then the big "after cleaning" figure.
  const big = free === null ? null : free + freeing;
  $('bigFrom').textContent = freeing ? `${fmtPrecise(free)} →` : '';
  if (free !== null) {
    caption = freeing ? '清理后可用' : '可用空间';
    if (toTrash) caption += ` · 另有 ${fmt(toTrash)} 移到废纸篓`;
  }

  if (state.scanning) {
    const { done, total, current } = state.progress;
    caption = total ? `正在扫描 ${done}/${total} · ${current}` : '正在准备…';
  } else if (!state.scanned) {
    if (free === null) caption = '扫描缓存，看看哪些能放心清理';
  } else if (state.lastResult) {
    summary = state.lastResult;
  } else {
    summary = rec.length
      ? `可以清理 ${fmt(sum(all.filter((i) => i.level !== 'keep')))}，其中 ${fmt(sum(rec))} 可以放心删除。`
      : '没有推荐清理的内容。';
  }
  if (state.protectError) summary = `${state.protectError}。为了安全，暂时不能清理。`;

  document.querySelector('.big').hidden = big === null;
  if (big !== null) { const [n, u] = split(big, true); $('bigNum').textContent = n; $('bigUnit').textContent = u; }
  $('bigCaption').textContent = caption;
  $('summary').textContent = summary;
  $('progressLine').hidden = !state.scanning;
  const { done, total } = state.progress;
  $('progressBar').style.width = total ? `${(done / total) * 100}%` : '0';
  renderDisk(sum(all), sum(sel));
}

// One bar + one short line; each segment's figure shows on hover.
function renderDisk(cacheBytes, selBytes) {
  const d = state.disk;
  $('disk').hidden = !d;
  if (!d) return;
  const used = d.total - d.free;
  const parts = {
    Used: [Math.max(0, used - cacheBytes), cacheBytes ? '其他占用' : '已用'],
    Cache: [cacheBytes - selBytes, '缓存'],
    Sel: [selBytes, '已选'],
    Free: [d.free, '可用'],
  };
  for (const [k, [v, name]] of Object.entries(parts)) {
    const seg = $('seg' + k);
    // Keep tiny-but-nonzero segments visible as a sliver
    seg.style.width = v > 0 ? `max(3px, ${(v / d.total) * 100}%)` : '0';
    seg.dataset.w = v > 0 ? '1' : '0';
    seg.onmousemove = (e) => showTip(e, name, k === 'Free' ? fmtPrecise(v) : fmt(v), `占磁盘的 ${((v / d.total) * 100).toFixed(1)}%`);
    seg.onmouseleave = hideTip;
  }
  $('diskTotal').textContent = `共 ${fmt(d.total)} · 已用 ${Math.round((used / d.total) * 100)}%`;
}

// ---------- render: grouped list ----------
function renderGroups() {
  const box = $('groups');
  box.replaceChildren();
  for (const lvl of LEVELS) {
    const list = live().filter((i) => i.level === lvl.key).sort((a, b) => b.bytes - a.bytes);
    if (!list.length) continue;
    const nSel = list.filter((i) => state.selected.has(i.id)).length;

    const g = el('div', `group ${lvl.key}`);
    const head = el('div', 'group-head');
    if (lvl.selectAll) {
      // Tri-state: all ☑ / some ⊟ / none ☐ — clicking selects or clears the group
      const all = el('input', 'check');
      all.type = 'checkbox';
      all.checked = nSel === list.length;
      all.indeterminate = nSel > 0 && nSel < list.length;
      all.title = '全选这组';
      all.onchange = () => {
        const on = nSel < list.length;
        list.forEach((i) => (on ? state.selected.add(i.id) : state.selected.delete(i.id)));
        renderAll();
      };
      head.append(all);
    } else {
      head.append(el('span', `dot ${lvl.key}`));
    }
    const info = el('span', 'info', 'ⓘ');
    info.onmousemove = (e) => showTip(e, lvl.title, `${list.length} 项`, lvl.desc);
    info.onmouseleave = hideTip;
    head.append(el('span', 'title', lvl.title), info, el('span', 'meta', fmt(sum(list))));
    g.append(head);

    // Long groups show their biggest few; "显示其余" only ever expands
    const limit = lvl.limit && !state.showAll[lvl.key] ? lvl.limit : Infinity;
    const ul = el('ul', 'rows');
    for (const it of list.slice(0, limit)) ul.append(row(it));
    g.append(ul);
    if (list.length > limit) {
      const more = el('button', 'more', `显示其余 ${list.length - limit} 项 · ${fmt(sum(list.slice(limit)))}`);
      more.onclick = () => { state.showAll[lvl.key] = true; renderGroups(); };
      g.append(more);
    }
    box.append(g);
  }

  // Protected rows: never cleaned, left out of the map and totals
  const prot = protectedItems().sort((a, b) => b.bytes - a.bytes);
  if (prot.length) {
    const g = el('div', 'group protected');
    const head = el('div', 'group-head');
    const info = el('span', 'info', 'ⓘ');
    info.onmousemove = (e) => showTip(e, '已保护', `${prot.length} 项`, '保护的项目永远不会被清理，也不会出现在石头图和统计里');
    info.onmouseleave = hideTip;
    head.append(el('span', 'dot protected'), el('span', 'title', '已保护'), info, el('span', 'meta', fmt(sum(prot))));
    g.append(head);
    const ul = el('ul', 'rows');
    for (const it of prot) ul.append(row(it, { isProtected: true }));
    g.append(ul);
    box.append(g);
  }
}

async function setProtected(id, on) {
  on ? state.protected.add(id) : state.protected.delete(id);
  if (on) state.selected.delete(id);
  hideTip();
  renderAll();
  try {
    await window.cleaner.saveProtected([...state.protected]);
  } catch (e) {
    state.protectError = '保护名单保存失败';
    renderAll();
  }
}

function row(it, { isProtected = false } = {}) {
  const li = el('li', isProtected ? 'row is-protected' : 'row');
  li.dataset.id = it.id;
  if (state.hot === it.id) li.classList.add('hot');

  const cb = el('input', 'check');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(it.id);
  cb.disabled = isProtected;
  cb.onchange = () => toggle(it.id);

  const icon = it.icon ? Object.assign(el('img'), { src: it.icon }) : el('span');

  const name = el('div', 'name');
  const tags = el('div', 'tags');
  for (const key of it.tags || []) {
    const def = TAGS[key];
    if (def) tags.append(el('span', `tag ${def.tone || ''}`, def.label));
  }
  name.append(el('div', 't', label(it)), tags);

  // Size, swapped for a protect / unprotect button on hover
  const end = el('div', 'end');
  const act = el('button', 'row-act', isProtected ? '取消保护' : '保护');
  act.title = isProtected ? '重新出现在列表里，可以清理' : '永远不清理这一项，也不再显示';
  act.onclick = (e) => { e.stopPropagation(); setProtected(it.id, !isProtected); };
  end.append(el('span', 'size', fmt(it.bytes)), act);

  li.append(cb, icon, name, end);
  li.onmouseenter = () => setHot(it.id);
  li.onmousemove = (e) => showTip(e, label(it), fmt(it.bytes), it.reason, it.paths);
  li.onmouseleave = () => { setHot(null); hideTip(); };
  li.ondblclick = () => window.cleaner.reveal(it.paths[0]);
  return li;
}

// ---------- render: stone garden ----------
function renderGarden() {
  const svg = $('map');
  const { width, height } = svg.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();
  $('emptyGarden').hidden = state.items.size > 0 || state.scanned;
  if (!state.items.size || width < 10) return;

  // Biggest folders get their own stone; the rest gather into one "其他" stone per level.
  const all = [...state.items.values()].filter((i) => !state.protected.has(i.id)).sort((a, b) => b.bytes - a.bytes);
  const nodes = all.slice(0, MAX_STONES).map((it) => ({ value: it.bytes, it }));
  for (const lvl of LEVELS) {
    const rest = all.slice(MAX_STONES).filter((i) => i.level === lvl.key && !i.cleaned);
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
    if (cell.it && cell.it.cleaned) svg.append(sand(cell, seed));
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

  g.onmousemove = (e) => showTip(e, name, fmt(bytes), it ? it.reason : '较小的缓存合在一起，可以在左边列表里逐项选择', it && it.paths);
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
    const verb = cell.it.cleaned === 'trashed' ? '已移到废纸篓' : '已释放';
    g.append(svgEl('text', { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 + 4 }, `${verb} ${fmt(cell.it.bytes)}`));
  }
  return g;
}

// Free disk space: raked sand around an empty centre, with the figure in it.
function freeArea(cell) {
  const free = state.disk.free;
  const selBytes = sum(selectedItems().filter(willDelete));
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
function showTip(e, title, size, reason, paths) {
  const tip = $('tooltip');
  tip.replaceChildren(el('div', 'tt', `${title} · ${size}`), el('div', 'tr', reason));
  if (paths && paths.length) {
    const short = paths.map((p) => p.replace(/^\/Users\/[^/]+/, '~'));
    tip.append(el('div', 'tp', (paths.length > 1 ? `${paths.length} 个文件夹：\n` : '') + short.join('\n')));
  }
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 18 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 18;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() { $('tooltip').hidden = true; }

function renderFooter() {
  const sel = selectedItems();
  $('selectedInfo').textContent = sel.length ? `已选 ${sel.length} 项 · ${fmt(sum(sel))}` : '未选择';
  $('cleanBtn').disabled = state.scanning || state.cleaning || !sel.length || Boolean(state.protectError);
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
// Folders of the same app with the same type become one row, e.g. Chrome's
// "Google" and "com.google.Chrome" web caches. Different types stay apart
// (ChatGPT's installer is recommended, its web cache isn't).
window.cleaner.onItem((it) => {
  if (it.bytes === 0) return;
  const key = it.groupKey;
  const prev = state.items.get(key);
  if (prev) {
    // The largest folder speaks for the row (its warnings and explanation);
    // only status tags are combined across folders.
    const status = new Set([...prev.tags, ...it.tags].filter((t) => STATUS_TAGS.has(t)));
    if (it.bytes > Math.max(...Object.values(prev.pathBytes))) {
      Object.assign(prev, { reason: it.reason, tags: it.tags.slice(), icon: it.icon || prev.icon });
    }
    prev.tags = [...prev.tags.filter((t) => !STATUS_TAGS.has(t)), ...status];
    prev.bytes += it.bytes;
    prev.paths.push(it.path);
    prev.pathBytes[it.path] = it.bytes;
    prev.partial = prev.partial || it.partial;
  } else {
    state.items.set(key, { ...it, id: key, paths: [it.path], pathBytes: { [it.path]: it.bytes } });
  }
  queueRender();
});
window.cleaner.onProgress((p) => {
  if (!state.scanning) return;
  state.progress = p;
  renderHero();
});

async function startScan() {
  Object.assign(state, { scanning: true, lastResult: null, progress: { done: 0, total: 0, current: '' } });
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

// ---------- clean ----------
$('cleanBtn').onclick = () => {
  const sel = selectedItems();
  const del = sel.filter(willDelete), tr = sel.filter((i) => !willDelete(i));
  const running = sel.filter((i) => i.appRunning).map(label);
  $('confirmTitle').textContent = `清理 ${sel.length} 项？`;
  const lines = [];
  if (del.length) lines.push(['永久删除', `${del.length} 项 · ${fmt(sum(del))}`, '空间马上释放']);
  if (tr.length) lines.push(['移到废纸篓', `${tr.length} 项 · ${fmt(sum(tr))}`, '可以从废纸篓放回']);
  $('confirmList').replaceChildren(...lines.map(([a, b, c]) => {
    const li = el('li');
    li.append(el('b', '', a), el('span', '', b), el('span', 'muted', c));
    return li;
  }));
  $('confirmNote').textContent = running.length
    ? `${running.join('、')} 正在运行，会被跳过。想清理的话，先退出它们再重新扫描。` : '';
  $('confirmNote').hidden = !running.length;
  $('confirm').showModal();
};
$('confirmNo').onclick = () => $('confirm').close();
$('confirmYes').onclick = async () => {
  $('confirm').close();
  const targets = selectedItems();
  state.cleaning = true;
  renderFooter();
  $('summary').textContent = '正在清理…';
  let res;
  try {
    res = await window.cleaner.clean(targets.map((i) => i.id));
  } catch (e) {
    state.cleaning = false;
    state.lastResult = `清理出错：${e.message}`;
    renderAll();
    return;
  }

  let deleted = 0, trashed = 0;
  const skipped = [];
  for (const r of res.results) {
    const it = state.items.get(r.groupKey);
    if (!it) continue;
    if (r.action === 'deleted' || r.action === 'command') deleted += r.bytes;
    if (r.action === 'trashed') trashed += r.bytes;
    if (['deleted', 'trashed', 'command'].includes(r.action)) {
      it.paths = it.paths.filter((p) => p !== r.path);
      it.cleanedAs = r.action === 'trashed' ? 'trashed' : 'deleted';
    } else {
      skipped.push(`${label(it)}（${r.reason}）`);
    }
  }
  for (const it of targets) {
    // Every folder done → the stone turns to sand; partly done → keeps the rest
    if (!it.paths.length) { it.cleaned = it.cleanedAs; state.selected.delete(it.id); }
    else it.bytes = it.paths.reduce((s2, p) => s2 + (it.pathBytes[p] || 0), 0);
  }

  const parts = [];
  // Measured free-space change, unless something else wrote to disk meanwhile
  // and made the measurement clearly too small — then report what we deleted.
  const measuredOk = res.freedMeasured != null && res.freedMeasured >= deleted * 0.5;
  if (deleted) parts.push(measuredOk ? `已释放 ${fmt(res.freedMeasured)}（实测）` : `已删除 ${fmt(deleted)}`);
  if (trashed) parts.push(`${fmt(trashed)} 移到了废纸篓，清空废纸篓后才释放`);
  if (skipped.length) parts.push(`跳过 ${[...new Set(skipped)].length} 项：${[...new Set(skipped)].join('、')}`);
  state.lastResult = (parts.join('。') || '没有清理任何内容') + '。';
  state.disk = res.disk || state.disk;
  state.cleaning = false;
  renderAll();
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
// Protect list: if it can't be read, cleaning stays disabled (fails closed)
window.cleaner.loadProtected().then((r) => {
  state.protected = new Set(r.ids || []);
  state.protectError = r.ok ? null : r.error;
  renderAll();
});
// Show the disk overview straight away, before any scan.
window.cleaner.diskSpace().then((disk) => { state.disk = disk; renderAll(); });
