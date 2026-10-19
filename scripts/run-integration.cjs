const path = require('node:path');
const fs = require('node:fs/promises');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const workspace = path.join(root, '.test-workspace');
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(workspace, { recursive: true });
  let executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    cachePath: path.join(root, '.vscode-test'),
  });
  // Recent macOS releases use Code; older test-electron versions still resolve Electron.
  if (process.platform === 'darwin') {
    try { await fs.access(executable); }
    catch { executable = path.join(path.dirname(executable), 'Code'); }
  }
  await runTests({
    vscodeExecutablePath: executable,
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist/test/integration.cjs'),
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
      '--user-data-dir', path.join(root, '.vscode-test/user-data'),
      '--extensions-dir', path.join(root, '.vscode-test/extensions')],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
