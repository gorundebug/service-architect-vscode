'use strict';
// Bundle JS and all native targets: a VSIX built in Linux must also work on macOS/Windows.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const targets = {
  'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64',
  'linux-arm-glibc': 'linux-arm-gnueabihf', 'linux-arm64-glibc': 'linux-arm64-gnu',
  'linux-arm64-musl': 'linux-arm64-musl', 'linux-x64-glibc': 'linux-x64-gnu',
  'linux-x64-musl': 'linux-x64-musl', 'win32-arm64': 'win32-arm64-msvc', 'win32-x64': 'win32-x64-msvc',
};
async function main() {
  await fs.mkdir('bundle/native', { recursive: true });
  await esbuild.build({ entryPoints: ['extension.js'], bundle: true, platform: 'node', target: 'node22',
    outfile: 'bundle/extension.js', external: ['vscode', '@vscode/os-proxy-resolver'], format: 'cjs' });
  const facade = path.dirname(require.resolve('@vscode/os-proxy-resolver'));
  for (const file of ['platform.js', 'LICENSE.txt', 'ThirdPartyNotices.txt']) {
    await fs.copyFile(path.join(facade, file), path.join('bundle/native', file));
  }
  // Keep the licenses for the JavaScript packages embedded by esbuild.
  const modules = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8' }).trim().split(/\r?\n/).slice(1);
  const notices = [];
  for (const directory of modules) {
    for (const file of await fs.readdir(directory)) {
      if (/^(licen[cs]e|copying)(\..*)?$/i.test(file)) {
        notices.push(`\n## ${directory.split('node_modules/').at(-1)} / ${file}\n\n` + await fs.readFile(path.join(directory, file), 'utf8'));
      }
    }
  }
  await fs.writeFile('bundle/third-party-notices.txt', notices.join('\n'));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-native-packages-'));
  try {
    for (const [key, suffix] of Object.entries(targets)) {
      const metadata = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', `@vscode/os-proxy-resolver-${suffix}@0.4.0`, '--json', '--ignore-scripts', '--pack-destination', temp],
        { encoding: 'utf8' }));
      const destination = path.resolve('bundle/native', key);
      await fs.mkdir(destination, { recursive: true });
      execFileSync('tar', ['-xzf', path.join(temp, metadata[0].filename), '--strip-components=1', '-C', destination]);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
