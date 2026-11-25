// Looks inside a cache folder to estimate how much of it is images / video.
// Most app caches (Chromium-based apps, chat apps) store files without
// extensions, so besides extensions we sniff the first few KB of the
// largest files for image/video signatures. Bounded by time and file count.
const fs = require('node:fs/promises');
const path = require('node:path');

const MEDIA_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg',
]);
// Extensions we can confidently call "not media" (code, databases, app data)
const OTHER_EXT = new Set([
  'js', 'ts', 'css', 'html', 'json', 'md', 'txt', 'map', 'wasm', 'pak', 'bin', 'dat', 'db',
  'sqlite', 'sqlite-wal', 'sqlite-shm', 'db-wal', 'db-shm', 'log', 'plist', 'xml', 'zip',
  'gz', 'tar', 'whl', 'node', 'dylib', 'so', 'pyc', 'jar', 'baj', 'baf', 'ldb',
]);

// Folder names that reveal what a cache is
const CHROMIUM_DIRS = new Set(['Code Cache', 'Cache_Data', 'GPUCache', 'htmlcache', 'Service Worker']);
const INSTALLER_DIRS = new Set(['org.sparkle-project.Sparkle', 'Squirrel', 'pending-update', 'updates']);

const SNIFF_BYTES = 4096;
const SNIFF_COUNT = 1000;

// Signatures searched anywhere in the first 4 KB (Chromium's cache puts a
// header and the URL before the body, so they're not always at offset 0).
const SIGNATURES = [
  Buffer.from([0xff, 0xd8, 0xff]),             // JPEG
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),  // PNG
  Buffer.from('GIF89a'), Buffer.from('GIF87a'),
  Buffer.from('WEBPVP8'),                      // WebP (after RIFF....)
  Buffer.from('ftypisom'), Buffer.from('ftypmp4'), Buffer.from('ftypqt'),
  Buffer.from('ftypheic'), Buffer.from('ftypM4A'), Buffer.from('ftypavif'),
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),       // WebM / Matroska
  Buffer.from('ID3'),                          // MP3
];

function looksLikeMedia(buf) {
  return SIGNATURES.some((sig) => buf.indexOf(sig) !== -1);
}

async function sniff(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return looksLikeMedia(buf.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

// Returns {
//   judged: boolean,   // false → we couldn't tell (fall back to app-based guess)
//   mediaBytes, totalBytes, mediaRatio,
//   installerBytes, installerRatio,  // inside updater download folders (Sparkle…)
//   chromium,          // has Chromium web cache folders (Code Cache, Cache_Data…)
//   urlCache,          // has a macOS URL cache (Cache.db) at the top
// }
async function analyzeContents(dir, { maxFiles = 150000, timeMs = 4000 } = {}) {
  const deadline = Date.now() + timeMs;
  let mediaBytes = 0, otherBytes = 0, unknownBytes = 0, files = 0;
  let installerBytes = 0, chromium = false, urlCache = false;
  let complete = true;
  const unknown = []; // [size, path], largest kept for sniffing

  const stack = [[dir, false]]; // [path, inside an updater download folder]
  while (stack.length) {
    if (files >= maxFiles || Date.now() > deadline) { complete = false; break; }
    const [cur, inInstaller] = stack.pop();
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (CHROMIUM_DIRS.has(e.name)) chromium = true;
        stack.push([full, inInstaller || INSTALLER_DIRS.has(e.name)]);
        continue;
      }
      if (!e.isFile()) continue;
      if (cur === dir && e.name === 'Cache.db') urlCache = true;
      let size;
      try { size = (await fs.lstat(full)).size; } catch { continue; }
      files++;
      if (inInstaller) installerBytes += size;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (MEDIA_EXT.has(ext)) mediaBytes += size;
      else if (OTHER_EXT.has(ext)) otherBytes += size;
      else { unknownBytes += size; unknown.push([size, full]); }
    }
  }

  // Sniff the largest unknown files; they hold most of the bytes.
  unknown.sort((a, b) => b[0] - a[0]);
  const sample = unknown.slice(0, SNIFF_COUNT);
  let sampledBytes = 0, sampledMedia = 0;
  for (const [size, file] of sample) {
    if (Date.now() > deadline + 2000) break;
    sampledBytes += size;
    if (await sniff(file)) sampledMedia += size;
  }
  // Extrapolate from the sample to the rest of the unknown files.
  const sampleShare = unknownBytes ? sampledBytes / unknownBytes : 1;
  const estMediaUnknown = sampledBytes ? (sampledMedia / sampledBytes) * unknownBytes : 0;

  const totalBytes = mediaBytes + otherBytes + unknownBytes;
  const media = mediaBytes + estMediaUnknown;
  // Only trust the answer if we saw the whole folder and the sniffed sample
  // covers a meaningful share of the unidentified bytes.
  const judged = complete && totalBytes > 0 && (unknownBytes === 0 || sampleShare >= 0.35);
  return {
    judged,
    mediaBytes: Math.round(media),
    totalBytes,
    mediaRatio: totalBytes ? media / totalBytes : 0,
    installerBytes,
    installerRatio: totalBytes ? installerBytes / totalBytes : 0,
    chromium,
    urlCache,
    files,
    complete,
    sampleShare,
  };
}

module.exports = { analyzeContents, looksLikeMedia };
