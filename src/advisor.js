// Decides what each cache folder is and whether cleaning it is recommended.
// Pure functions, no file system access, so the rules are easy to test.

// Caches of command-line / developer tools that aren't .app bundles.
// They're download caches: safe to remove, re-downloaded when needed.
const TOOLS = {
  pip: 'Python pip',
  homebrew: 'Homebrew',
  'node-gyp': 'node-gyp（npm 编译工具）',
  typescript: 'TypeScript',
  'claude-cli-nodejs': 'Claude Code',
  electron: 'Electron 下载缓存',
  flutter_engine: 'Flutter',
  'ms-playwright': 'Playwright 浏览器',
  yarn: 'Yarn',
  pnpm: 'pnpm',
  'go-build': 'Go 编译缓存',
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

// One question decides the group: what happens if you delete it?
//   recommend 推荐清理  — nothing you'd notice
//   ok        可以清理  — no data lost, but some cost, or we're not sure
//   keep      不建议    — managed by macOS
// Size never changes the group (it only sorts). "Running" is a status tag.
//
// Returns { kind, displayName, level, reason, tags }
//   tags[0] is the consequence; 'running' / 'partial' may follow.
function advise(item) {
  const out = adviseBase(item);
  if (item.appRunning && out.kind === 'app') {
    out.tags.push('running');
    out.reason += `。${item.appName} 正在运行，先退出再删，否则它会马上写回来`;
  }
  if (item.partial) out.tags.push('partial');
  return out;
}

function adviseBase(item) {
  const folder = item.folder;
  const tool = TOOLS[folder.toLowerCase()];

  if (tool) {
    return {
      kind: 'tool', displayName: tool, level: 'recommend', tags: ['redownload'],
      reason: '开发工具的下载缓存，下次用到时会自动重新下载',
    };
  }

  if (isSystem(item) && !item.appName) {
    return {
      kind: 'system', displayName: folder.replace(/^com\.apple\./i, ''), level: 'keep', tags: ['system'],
      reason: 'macOS 系统组件的缓存，系统会自己管理，清理收益很小',
    };
  }

  if (item.appName && /\.shipit$/i.test(folder)) {
    return {
      kind: 'app', displayName: `${item.appName}（更新残留）`, level: 'recommend', tags: ['noimpact'],
      reason: 'App 自动更新时下载的安装包，更新完成后就没用了',
    };
  }

  const c = item.contents;
  const mediaNote = c && c.judged && c.mediaRatio >= 0.2
    ? `，其中约 ${fmt(c.mediaBytes)}（${Math.round(c.mediaRatio * 100)}%）是图片或视频` : '';

  if (item.appName) {
    if (isChatApp(item)) {
      // B: we looked inside and can tell
      if (c && c.judged) {
        if (c.mediaRatio >= 0.3 && c.mediaBytes >= 50e6) {
          return {
            kind: 'app', displayName: item.appName, level: 'ok', tags: ['media'],
            reason: `里面约 ${fmt(c.mediaBytes)} 是图片或视频，可能有聊天原图。删了要重新下载，过期的原图可能找不回`,
          };
        }
        return {
          kind: 'app', displayName: item.appName, level: 'ok', tags: ['slower'],
          reason: `检查过内容，主要是程序缓存，图片视频只占 ${Math.round(c.mediaRatio * 100)}%。下次打开会慢一点`,
        };
      }
      // A: fallback when we couldn't look inside
      return {
        kind: 'app', displayName: item.appName, level: 'ok', tags: ['maybechat'],
        reason: '聊天 App 的缓存里可能有收到的图片和文件，删了需要重新下载',
      };
    }
    return {
      kind: 'app', displayName: item.appName, level: 'ok', tags: ['slower'],
      reason: `不会丢数据，App 下次打开时重建，第一次会慢一点${mediaNote}`,
    };
  }

  return {
    kind: 'orphan', displayName: folder, level: 'ok', tags: ['unknown'],
    reason: `没找到对应的 App，可能是已卸载 App 的残留` +
      (item.mtimeMs ? `，最后修改于 ${monthOf(item.mtimeMs)}` : '') + mediaNote,
  };
}

module.exports = { advise, isSystem, isChatApp, TOOLS };
