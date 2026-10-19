// Exercise native scripts against fake npm/VS Code CLIs, never a user profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.test-workspace');
const windows = process.platform === 'win32';
const powershell = windows ? 'powershell.exe' : 'pwsh';
const engines = [
  { name: 'Bash', command: 'bash', extension: 'sh', prefix: [], flag: name => `--${name}` },
  { name: 'PowerShell', command: powershell, extension: 'ps1', prefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'], flag: name => `-${name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}` },
];

for (const engine of engines) {
  const available = !(windows && engine.extension === 'sh') && spawnSync(engine.command, engine.extension === 'sh' ? ['--version'] : ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], { stdio: 'ignore' }).status === 0;
  test(`${engine.name} rebuild/deploy workflows`, { skip: !available }, async t => {
    fs.mkdirSync(workspace, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(workspace, 'workflow with spaces-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const bin = path.join(fixture, 'mock bin');
    const caller = path.join(fixture, 'caller');
    const apps = path.join(fixture, 'Applications');
    const stable = path.join(apps, 'Visual Studio Code.app/Contents/Resources/app/bin/code');
    const insiders = path.join(apps, 'Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code');
    fs.mkdirSync(bin);
    fs.mkdirSync(caller);
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    for (const name of ['rebuild', 'deploy']) {
      fs.copyFileSync(path.join(root, `${name}.${engine.extension}`), path.join(fixture, `${name}.${engine.extension}`));
    }
    if (engine.extension === 'sh') {
      const script = path.join(fixture, 'deploy.sh');
      fs.writeFileSync(script, fs.readFileSync(script, 'utf8')
        .replace('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', () => stable)
        .replace('/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code', () => insiders));
    }
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'fixture-picture', version: '2.3.4' }));
    const artifact = path.join(fixture, 'fixture-picture-2.3.4.vsix');
    const log = path.join(fixture, 'calls.jsonl');
    const runner = path.join(bin, 'mock.cjs');
    fs.writeFileSync(runner, `
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ command, args, cwd: process.cwd(), cache: process.env.npm_config_cache }) + '\\n');
if (process.env.MOCK_FAIL === [command, ...args].join(' ')) process.exit(19);
if (command === 'npm' && args.join(' ') === 'run package') {
  fs.writeFileSync(process.env.MOCK_ARTIFACT, 'fake package');
}
`);
    for (const command of ['npm', 'code', 'code-insiders', 'selected code']) {
      fs.writeFileSync(path.join(bin, command), `#!/usr/bin/env node\nprocess.argv.splice(2, 0, ${JSON.stringify(command)}); require(${JSON.stringify(runner)});\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, `${command}.cmd`), `@"${process.execPath}" "${runner}" "${command}" %*\r\n`);
    }
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const invoke = (script, args = [], fail = '') => {
      fs.rmSync(log, { force: true });
      return spawnSync(engine.command, [...engine.prefix, path.join(fixture, `${script}.${engine.extension}`), ...args], {
        cwd: caller, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MOCK_LOG: log, MOCK_ARTIFACT: artifact, MOCK_FAIL: fail },
      });
    };
    const success = result => assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    const flag = engine.flag;

    await t.test('builds from another directory, using locked deps and repository cache', () => {
      success(invoke('rebuild', [flag('deps')]));
      assert.deepEqual(calls().map(c => c.args), [['ci', '--no-audit', '--no-fund'], ['test'], ['run', 'package']]);
      for (const call of calls()) {
        assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(fixture));
        assert.equal(call.cache, path.join(fixture, '.npm-cache'));
      }
    });
    await t.test('fast build still packages; explicit audit is forwarded', () => {
      success(invoke('rebuild', [flag('deps'), flag('fast'), flag('audit')]));
      assert.deepEqual(calls().map(c => c.args), [['ci', '--audit', '--no-fund'], ['run', 'package']]);
    });
    await t.test('missing dependencies trigger npm ci automatically', () => {
      fs.rmdirSync(path.join(fixture, 'node_modules'));
      success(invoke('rebuild', [flag('fast')]));
      assert.deepEqual(calls().map(c => c.args), [['ci', '--no-audit', '--no-fund'], ['run', 'package']]);
      fs.mkdirSync(path.join(fixture, 'node_modules'));
    });
    await t.test('dependency and test failures stop packaging', () => {
      assert.notEqual(invoke('rebuild', [flag('deps')], 'npm ci --no-audit --no-fund').status, 0);
      assert.equal(calls().length, 1);
      assert.notEqual(invoke('rebuild', [], 'npm test').status, 0);
      assert.deepEqual(calls().map(c => c.args), [['test']]);
      assert.notEqual(invoke('rebuild', [flag('fast')], 'npm run package').status, 0);
    });
    await t.test('selects current manifest artifact and only one CLI', () => {
      fs.writeFileSync(path.join(fixture, 'unrelated-newest-99.vsix'), 'decoy');
      success(invoke('deploy'));
      assert.deepEqual(calls().map(c => [c.command, ...c.args]), [['code', '--install-extension', artifact, '--force']]);
    });
    await t.test('preserves spaced paths and explicit directory overrides', () => {
      const selected = path.join(bin, windows ? 'selected code.cmd' : 'selected code');
      success(invoke('deploy', [path.join('..', path.basename(artifact)), flag('code'), selected,
        flag('extensions-dir'), 'extensions with spaces', flag('user-data-dir'), 'profile with spaces']));
      assert.deepEqual(calls().map(c => [c.command, ...c.args]), [['selected code', '--extensions-dir', 'extensions with spaces', '--user-data-dir', 'profile with spaces', '--install-extension', artifact, '--force']]);
      assert.equal(fs.realpathSync(calls()[0].cwd), fs.realpathSync(caller));
    });
    await t.test('dry run has no CLI side effects', () => {
      const result = invoke('deploy', [flag('dry-run'), flag('code'), 'nonexistent-code']);
      success(result);
      assert.match(result.stdout, /nonexistent-code/);
      assert.deepEqual(calls(), []);
    });
    if (engine.extension === 'sh') {
      await t.test('deploys to both available macOS apps by default', async t => {
        for (const [destination, command] of [[stable, 'code'], [insiders, 'code-insiders']]) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(path.join(bin, command), destination);
        }
        t.after(() => fs.rmSync(apps, { recursive: true, force: true }));
        const installArgs = ['--install-extension', artifact, '--force'];
        success(invoke('deploy'));
        assert.deepEqual(calls().map(c => [c.command, ...c.args]),
          ['code', 'code-insiders'].map(command => [command, ...installArgs]));

        await t.test('dry run prints both destinations without invoking either', () => {
          const result = invoke('deploy', [flag('dry-run')]);
          success(result);
          assert.equal((result.stdout.match(/\[deploy\] Command:/g) || []).length, 2);
          assert.match(result.stdout, /Insiders/);
          assert.deepEqual(calls(), []);
        });
        await t.test('explicit CLI overrides both app destinations', () => {
          success(invoke('deploy', [flag('code'), 'selected code']));
          assert.deepEqual(calls().map(c => [c.command, ...c.args]), [['selected code', ...installArgs]]);
        });
        await t.test('forwards directory overrides to both apps', () => {
          success(invoke('deploy', [flag('extensions-dir'), 'extensions with spaces', flag('user-data-dir'), 'profile with spaces']));
          const expected = ['--extensions-dir', 'extensions with spaces', '--user-data-dir', 'profile with spaces', ...installArgs];
          assert.deepEqual(calls().map(c => c.args), [expected, expected]);
        });
        await t.test('attempts both apps and reports failure if either fails', () => {
          for (const command of ['code', 'code-insiders']) {
            assert.notEqual(invoke('deploy', [], [command, ...installArgs].join(' ')).status, 0);
            assert.deepEqual(calls().map(c => c.command), ['code', 'code-insiders']);
          }
        });
        await t.test('skips either missing app without adding a PATH destination', () => {
          for (const [missing, remaining] of [[stable, 'code-insiders'], [insiders, 'code']]) {
            fs.renameSync(missing, `${missing}.disabled`);
            try {
              success(invoke('deploy'));
              assert.deepEqual(calls().map(c => [c.command, ...c.args]), [[remaining, ...installArgs]]);
            } finally {
              fs.renameSync(`${missing}.disabled`, missing);
            }
          }
        });
      });
    }
    await t.test('installation errors fail the workflow', () => {
      assert.notEqual(invoke('deploy', [], `code --install-extension ${artifact} --force`).status, 0);
      assert.equal(calls().length, 1);
    });
    await t.test('bad arguments and missing artifacts never invoke CLIs', () => {
      for (const script of ['rebuild', 'deploy']) {
        assert.notEqual(invoke(script, [flag('unknown')]).status, 0);
        assert.deepEqual(calls(), []);
      }
      fs.unlinkSync(artifact);
      assert.notEqual(invoke('deploy').status, 0);
      assert.deepEqual(calls(), []);
    });
  });
}
