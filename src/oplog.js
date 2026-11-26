// Operation log: one line per item we deleted, trashed, skipped or failed on.
// ~/Library/Logs/cleaner/operations.log — plain text, easy to read later.
const fs = require('node:fs/promises');
const path = require('node:path');
const { OWN_LOG_DIR } = require('./locations');

const LOG_FILE = path.join(OWN_LOG_DIR, 'operations.log');

const ACTION = { deleted: '永久删除', trashed: '移到废纸篓', skipped: '跳过', failed: '失败', command: '命令清理' };

function line(e, when) {
  const mb = (e.bytes / 1e6).toFixed(1).padStart(9);
  return `${when}  ${(ACTION[e.action] || e.action).padEnd(6, '　')}  ${mb} MB  ${e.path}${e.reason ? `  — ${e.reason}` : ''}`;
}

// entries: [{ action, bytes, path, reason? }]
async function append(entries, file = LOG_FILE) {
  if (!entries.length) return;
  const when = new Date().toISOString();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, entries.map((e) => line(e, when)).join('\n') + '\n');
}

module.exports = { append, LOG_FILE };
