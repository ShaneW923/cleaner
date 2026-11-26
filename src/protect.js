// Protect list: rows the user never wants cleaned (or shown). Stored as a JSON
// array of group keys.
//
// Fails closed: if the file exists but can't be read or parsed, load() reports
// ok:false and cleaning must refuse to run — never treat a broken list as empty.
const fs = require('node:fs/promises');

async function load(file, legacyFile) {
  for (const f of [file, legacyFile].filter(Boolean)) {
    let text;
    try {
      text = await fs.readFile(f, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue; // no list yet → nothing protected
      return { ok: false, ids: [], error: '保护名单文件读不出来', detail: e.code || e.message };
    }
    try {
      const ids = JSON.parse(text);
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error('格式不对');
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, ids: [], error: '保护名单文件已损坏', detail: e.message };
    }
  }
  return { ok: true, ids: [] };
}

async function save(file, ids) {
  const clean = Array.isArray(ids) ? [...new Set(ids.filter((x) => typeof x === 'string'))] : [];
  // Write to a temp file, then rename, so a crash never leaves half a file
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2));
  await fs.rename(tmp, file);
  return clean;
}

module.exports = { load, save };
