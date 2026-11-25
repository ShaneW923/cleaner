const $ = (id) => document.getElementById(id);

// Opened as a plain web page (not inside the Electron app) → no file access.
if (!window.cleaner) {
  document.body.innerHTML =
    '<p style="padding:40px;text-align:center">这是界面预览，不能扫描。请在项目里运行 <code>npm start</code> 打开 App。</p>';
  throw new Error('window.cleaner missing: not running inside Electron');
}
const items = new Map(); // id → item
const selected = new Set();
let sortKey = 'bytes';
let scanning = false;

function fmt(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) { bytes /= 1000; i++; }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function sorted() {
  const arr = [...items.values()];
  if (sortKey === 'bytes') arr.sort((a, b) => b.bytes - a.bytes);
  else arr.sort((a, b) => label(a).localeCompare(label(b)));
  return arr;
}

function label(it) {
  return it.displayName || it.appName || it.folder;
}

const LEVEL_TEXT = { recommend: '推荐清理', ok: '可以清理', keep: '不建议' };
const KIND_TEXT = { tool: '开发工具', system: 'macOS 系统', orphan: '未找到 App' };

function render() {
  const list = $('list');
  list.replaceChildren(...sorted().map(row));
  $('empty').hidden = scanning || items.size > 0 || $('status').dataset.scanned !== '1';
  updateFooter();
}

function row(it) {
  const li = document.createElement('li');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selected.has(it.id);
  cb.onchange = () => { cb.checked ? selected.add(it.id) : selected.delete(it.id); updateFooter(); };

  let icon;
  if (it.icon) { icon = document.createElement('img'); icon.src = it.icon; }
  else { icon = document.createElement('div'); icon.className = 'noicon'; }

  const name = document.createElement('div');
  name.className = 'name';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = label(it);
  title.append(tag(LEVEL_TEXT[it.level], it.level));
  if (KIND_TEXT[it.kind]) title.append(tag(KIND_TEXT[it.kind], ''));
  if (it.appRunning) title.append(tag('运行中', 'running'));
  if (it.partial) title.append(tag('部分无权限', ''));
  const reason = document.createElement('div');
  reason.className = 'reason';
  reason.textContent = it.reason;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = it.folder;
  sub.title = it.path;
  name.append(title, reason, sub);

  const size = document.createElement('div');
  size.className = 'size';
  size.textContent = fmt(it.bytes);

  const reveal = document.createElement('button');
  reveal.className = 'reveal';
  reveal.textContent = '在访达中显示';
  reveal.onclick = () => window.cleaner.reveal(it.path);

  li.append(cb, icon, name, size, reveal);
  return li;
}

function tag(text, cls) {
  const s = document.createElement('span');
  s.className = `tag ${cls}`;
  s.textContent = text;
  return s;
}

function selectedBytes() {
  let sum = 0;
  for (const id of selected) sum += items.get(id)?.bytes || 0;
  return sum;
}

function updateFooter() {
  $('selectedInfo').textContent = `已选 ${selected.size} 项 · ${fmt(selectedBytes())}`;
  $('trashBtn').disabled = scanning || selected.size === 0;
  $('selectRecommended').disabled = scanning || ![...items.values()].some((i) => i.level === 'recommend');
  const selectable = [...items.values()].filter((i) => i.level !== 'keep');
  $('selectAll').checked = selectable.length > 0 && selectable.every((i) => selected.has(i.id));
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

window.cleaner.onItem((it) => {
  if (it.bytes === 0) return; // empty cache folders aren't worth listing in v0.1
  items.set(it.id, it);
  queueRender();
});

window.cleaner.onProgress(({ done, total, current }) => {
  if (!scanning) return;
  $('progress').max = total || 1;
  $('progress').value = done;
  $('status').textContent = `正在扫描（${done}/${total}）：${current}`;
});

async function startScan() {
  scanning = true;
  items.clear();
  selected.clear();
  $('scanBtn').hidden = true;
  $('cancelBtn').hidden = false;
  $('progress').hidden = false;
  $('status').textContent = '正在准备…';
  render();

  const res = await window.cleaner.startScan();
  scanning = false;
  $('scanBtn').hidden = false;
  $('scanBtn').textContent = '重新扫描';
  $('cancelBtn').hidden = true;
  $('progress').hidden = true;
  $('status').dataset.scanned = '1';
  const total = [...items.values()].reduce((s, i) => s + i.bytes, 0);
  const rec = [...items.values()].filter((i) => i.level === 'recommend');
  const recText = rec.length
    ? ` · 推荐清理 ${rec.length} 项，${fmt(rec.reduce((s, i) => s + i.bytes, 0))}`
    : '';
  if (!res.ok) $('status').textContent = `扫描出错：${res.error}`;
  else if (res.cancelled) $('status').textContent = `已取消 · 已找到 ${items.size} 项，共 ${fmt(total)}${recText}`;
  else $('status').textContent = `扫描完成 · ${items.size} 项，共 ${fmt(total)}${recText}`;
  render();
}

$('scanBtn').onclick = startScan;
$('cancelBtn').onclick = () => window.cleaner.cancelScan();

$('selectAll').onchange = (e) => {
  for (const it of items.values()) {
    if (it.level === 'keep') continue; // "不建议" items are never auto-selected
    e.target.checked ? selected.add(it.id) : selected.delete(it.id);
  }
  render();
};

$('selectRecommended').onclick = () => {
  selected.clear();
  for (const it of items.values()) if (it.level === 'recommend') selected.add(it.id);
  render();
};

document.querySelectorAll('.sort button').forEach((b) => {
  b.onclick = () => {
    sortKey = b.dataset.sort;
    document.querySelectorAll('.sort button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  };
});

$('trashBtn').onclick = () => {
  const sel = [...selected].map((id) => items.get(id));
  const keep = sel.filter((i) => i.level === 'keep').length;
  const running = sel.filter((i) => i.appRunning).map(label);
  $('confirmText').textContent =
    `将 ${selected.size} 项（${fmt(selectedBytes())}）移到废纸篓。` +
    (keep ? `其中 ${keep} 项是"不建议"清理的 macOS 系统缓存。` : '') +
    (running.length ? `${running.join('、')} 正在运行，建议先退出。` : '');
  $('confirm').showModal();
};
$('confirmNo').onclick = () => $('confirm').close();
$('confirmYes').onclick = async () => {
  $('confirm').close();
  const targets = [...selected].map((id) => items.get(id).path);
  const results = await window.cleaner.trash(targets);
  const failed = results.filter((r) => !r.ok);
  let freed = 0;
  for (const r of results) {
    if (!r.ok) continue;
    const it = [...items.values()].find((i) => i.path === r.path);
    if (it) { freed += it.bytes; items.delete(it.id); selected.delete(it.id); }
  }
  $('status').textContent =
    `已移到废纸篓 ${results.length - failed.length} 项，${fmt(freed)}（清空废纸篓后才会真正释放空间）` +
    (failed.length ? ` · ${failed.length} 项失败：${failed.map((f) => f.error).join('；')}` : '');
  render();
};
