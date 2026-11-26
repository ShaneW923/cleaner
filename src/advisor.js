// Decides what each cache folder is and whether cleaning it is recommended.
// Pure functions, no file system access, so the rules are easy to test.

// Caches of command-line / developer tools that aren't .app bundles.
// They're download caches: safe to remove, re-downloaded when needed.
// value: display name; BUILD_TOOLS below marks compiler caches
const TOOLS = {
  pip: 'Python pip',
  homebrew: 'Homebrew',
  'node-gyp': 'node-gyp',
  typescript: 'TypeScript',
  'claude-cli-nodejs': 'Claude Code',
  electron: 'Electron',
  flutter_engine: 'Flutter',
  'ms-playwright': 'Playwright',
  yarn: 'Yarn',
  pnpm: 'pnpm',
  'go-build': 'Go',
  cocoapods: 'CocoaPods',
  'org.carthage.carthagekit': 'Carthage',
  'org.swift.swiftpm': 'Swift Package Manager',
  'com.apple.dt.xcode': 'Xcode',
};

// macOS components whose cache folders don't start with "com.apple."
const APPLE_PLAIN = new Set([
  'geoservices', 'passkit', 'gamekit', 'cloudkit', 'animoji', 'familycircle',
  'siritts', 'askpermissiond', 'icloudmailagent', 'amsdatamigratortool',
  'jetpackcache', 'mbuseragent', 'installation', 'com.crashreporter',
]);

const BUILD_TOOLS = new Set(['node-gyp', 'typescript', 'go-build', 'com.apple.dt.xcode']);

const MB = 1000 * 1000;

function isSystem(item) {
  return item.system || APPLE_PLAIN.has(item.folder.toLowerCase());
}

// item: { folder, bytes, system, appName, appRunning }
// Chat apps may keep received images/files in their cache folder.
const CHAT_APPS = [
  'lark', 'feishu', 'wechat', 'xinwechat', 'wework', 'com.tencent.qq', 'dingtalk',
  'telegram', 'slack', 'discord', 'whatsapp', 'naver.line', 'signal', 'microsoft.teams',
  'skype', 'messenger', 'kakaotalk',
];

function isChatApp(item) {
  const hay = `${item.appBundleId || ''} ${item.appName || ''}`.toLowerCase();
  return CHAT_APPS.some((k) => (k === 'com.tencent.qq' ? hay.split(' ')[0] === k : hay.includes(k)));
}

function fmt(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function monthOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

// What a folder IS — shown as the row's tag. The group (推荐 / 可以 / 不建议)
// already says whether to delete; the reason says what deleting costs.
const TYPES = {
  installer: { level: 'recommend', reason: 'App 自动更新时下载的安装包，更新装好后就没用了，删了没影响' },
  download:  { level: 'recommend', reason: '开发工具下载的安装包和依赖，下次用到时自动重新下载' },
  build:     { level: 'recommend', reason: '编译时生成的中间文件，下次编译时重新生成' },
  crash:     { level: 'recommend', reason: 'App 崩溃时留下的报告，删了没影响' },
  oldversion:{ level: 'recommend', reason: 'Homebrew 升级后留下的旧版本和过期下载。由 Homebrew 自带的清理命令删除，正在用的版本不受影响' },
  log:       { level: 'recommend', reason: '运行日志，删了没影响' },
  web:       { level: 'ok', reason: '网页、图片和脚本的缓存，删了页面要重新加载，第一次打开会慢一点' },
  image:     { level: 'ok', reason: '缩略图、封面这类图片缓存，删了会重新下载' },
  network:   { level: 'ok', reason: 'App 联网时缓存的数据，删了会重新获取' },
  chat:      { level: 'ok', reason: '' }, // reason decided by the content check below
  appcache:  { level: 'ok', reason: 'App 自己的缓存，下次打开时重建，第一次会慢一点' },
  toolcache: { level: 'ok', reason: '命令行工具的缓存，删了需要时会重建' },
  model:     { level: 'ok', reason: '下载的 AI 模型，删了下次用到要重新下载，可能很大很慢' },
  runtime:   { level: 'ok', reason: '工具正在使用的运行环境，删了下次启动时会重新下载' },
  system:    { level: 'keep', reason: 'macOS 系统组件的缓存，系统会自己管理，清理收益很小' },
};

// Returns { kind, type, displayName, level, reason, tags }
//   tags[0] is the type; warning / status tags may follow:
//   orphan 未找到 App · media 含聊天图片 · maybechat 可能含聊天文件 · running · partial
// Size never changes the group (it only sorts).
function advise(item) {
  const out = adviseBase(item);
  if (item.appRunning && out.kind === 'app') {
    out.tags.push('running');
    out.reason += `。${item.appName} 正在运行，先退出再删，否则它会马上写回来`;
  }
  if (item.partial) out.tags.push('partial');
  return out;
}

function result(kind, type, displayName, extra = {}) {
  const t = TYPES[type];
  return {
    kind, type, displayName, level: t.level, reason: t.reason,
    ...extra, tags: [type, ...(extra.tags || [])],
  };
}

function detectType(item) {
  const folder = item.folder;
  const c = item.contents;
  if (/\.shipit$|updater|squirrel/i.test(folder) || (c && c.installerRatio >= 0.8)) return 'installer';
  if (/crash|sentry|breakpad/i.test(folder)) return 'crash';
  if (/^logs?$|\.log$/i.test(folder)) return 'log';
  if (item.appName && isChatApp(item)) return 'chat';
  if (c && c.chromium) return 'web';
  if (/image|thumb|avatar|artwork/i.test(folder) || (c && c.judged && c.mediaRatio >= 0.5)) return 'image';
  if (c && c.urlCache) return 'network';
  return 'appcache';
}

function adviseBase(item) {
  const folder = item.folder;
  const tool = TOOLS[folder.toLowerCase()];

  // Known locations outside ~/Library/Caches (~/.npm, ~/.nvm, ~/.cache/…)
  if (item.preset) {
    const out = result(item.appName ? 'app' : 'tool', item.preset.type, item.appName || item.preset.name);
    if (item.preset.reason) out.reason = item.preset.reason;
    return out;
  }

  if (tool) return result('tool', BUILD_TOOLS.has(folder.toLowerCase()) ? 'build' : 'download', tool);

  if (isSystem(item) && !item.appName) {
    return result('system', 'system', folder.replace(/^com\.apple\./i, ''));
  }

  const type = detectType(item);
  const c = item.contents;
  const kind = item.appName ? 'app' : 'orphan';
  const out = result(kind, type, item.appName || folder);

  if (type === 'installer' && c && c.installerBytes) {
    out.reason = `约 ${fmt(c.installerBytes)} 是 App 自动更新时下载的安装包，更新装好后就没用了，删了没影响`;
  }
  if (type === 'web' && c && c.judged && c.mediaRatio >= 0.2) {
    out.reason += `。其中约 ${fmt(c.mediaBytes)} 是网页图片`;
  }
  if (type === 'chat') {
    if (c && c.judged) {
      // B: we looked inside and can tell
      if (c.mediaRatio >= 0.3 && c.mediaBytes >= 50e6) {
        out.tags.push('media');
        out.reason = `里面约 ${fmt(c.mediaBytes)} 是图片或视频，可能有聊天原图。删了要重新下载，过期的原图可能找不回`;
      } else {
        out.reason = `检查过内容，主要是程序缓存，图片视频只占 ${Math.round(c.mediaRatio * 100)}%。删了下次打开会慢一点`;
      }
    } else {
      // A: fallback when we couldn't look inside
      out.tags.push('maybechat');
      out.reason = '聊天 App 的缓存里可能有收到的图片和文件，删了需要重新下载';
    }
  }

  if (kind === 'orphan') {
    out.tags.push('orphan');
    // The group still follows the type: crash reports or installers are
    // harmless to delete even when we can't tell which app left them.
    out.reason = '没找到对应的 App，可能是已卸载 App 的残留' +
      (item.mtimeMs ? `，最后修改于 ${monthOf(item.mtimeMs)}` : '') + `。${out.reason}`;
  }
  return out;
}

module.exports = { advise, isSystem, isChatApp, TOOLS, TYPES };
