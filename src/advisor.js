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
// Returns { kind, displayName, level, reason }
//   kind:  'app' | 'tool' | 'system' | 'orphan'
//   level: 'recommend' 推荐清理 | 'ok' 可以清理 | 'keep' 不建议
function advise(item) {
  const folder = item.folder;
  const lower = folder.toLowerCase();
  const tool = TOOLS[lower];

  if (tool) {
    return {
      kind: 'tool',
      displayName: tool,
      level: item.bytes >= MB ? 'recommend' : 'ok',
      reason: '开发工具的下载缓存，删掉后需要时会自动重新下载',
    };
  }

  if (isSystem(item) && !item.appName) {
    return {
      kind: 'system',
      displayName: folder.replace(/^com\.apple\./i, ''),
      level: 'keep',
      reason: 'macOS 系统组件的缓存，系统会自己管理，清理收益很小',
    };
  }

  if (item.appName) {
    if (/\.shipit$/i.test(folder)) {
      return {
        kind: 'app',
        displayName: `${item.appName}（更新临时文件）`,
        level: item.appRunning ? 'ok' : 'recommend',
        reason: 'App 自动更新时留下的安装包，更新完成后就没用了',
      };
    }
    if (item.appRunning) {
      return {
        kind: 'app',
        displayName: item.appName,
        level: 'ok',
        reason: 'App 正在运行，建议先退出再清理，否则它可能马上又写回来',
      };
    }
    return {
      kind: 'app',
      displayName: item.appName,
      level: item.bytes >= 100 * MB ? 'recommend' : 'ok',
      reason: item.bytes >= 100 * MB
        ? '占用较大，App 下次打开时会自动重建，不会丢数据'
        : 'App 下次打开时会自动重建，不会丢数据',
    };
  }

  return {
    kind: 'orphan',
    displayName: folder,
    level: item.bytes >= MB ? 'recommend' : 'ok',
    reason: '没有找到对应的 App，可能是已卸载 App 的残留',
  };
}

module.exports = { advise, isSystem, TOOLS };
