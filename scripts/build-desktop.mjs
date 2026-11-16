import { mkdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minimumFreeBytes = 3 * 1024 * 1024 * 1024;

async function availableBytes(directory) {
  try {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

async function selectBuildRoot() {
  if (process.env.INTELLIGENSICUS_BUILD_ROOT) return path.resolve(process.env.INTELLIGENSICUS_BUILD_ROOT);
  if (process.platform === 'win32') {
    for (const drive of ['F:', 'D:', 'E:']) {
      const directory = `${drive}\\Intelligensicus-DesktopBuild`;
      if (await availableBytes(`${drive}\\`) >= minimumFreeBytes) return directory;
    }
  }
  return path.join(packageRoot, 'release-work');
}

const buildRoot = await selectBuildRoot();
const outputDirectory = path.join(buildRoot, 'release');
const cacheDirectory = path.join(buildRoot, 'cache');
const temporaryDirectory = path.join(buildRoot, 'tmp');
await Promise.all([mkdir(outputDirectory, { recursive: true }), mkdir(cacheDirectory, { recursive: true }), mkdir(temporaryDirectory, { recursive: true })]);

process.env.TEMP = temporaryDirectory;
process.env.TMP = temporaryDirectory;
process.env.ELECTRON_BUILDER_CACHE = path.join(cacheDirectory, 'builder');
process.env.electron_config_cache = path.join(cacheDirectory, 'electron');

const electronDistribution = process.env.INTELLIGENSICUS_ELECTRON_DIST || path.resolve(packageRoot, '../../node_modules/electron/dist');
console.log(`Building Intelligensicus Windows installer in ${outputDirectory}`);

await build({
  projectDir: packageRoot,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: {
    directories: { output: outputDirectory },
    electronDist: electronDistribution
  }
});

console.log(`Installer output: ${outputDirectory}`);