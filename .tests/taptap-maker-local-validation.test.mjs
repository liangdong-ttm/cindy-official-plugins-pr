import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import validationModule from '../taptap-maker/node/local-validation.cjs';
import adapter from '../taptap-maker/node/child-process-adapter.cjs';

const { runLocalValidation, skillStatus } = validationModule;
const parse = output => JSON.parse(output.stdout);
const stopped = { protocol_version: 1, ok: true, state: 'stopped', process_alive: false };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  await writeFile(path.join(root, '.gitignore'), '.maker/validation-evidence/\n');
  return realpath(root);
}

test('installed Skill is distinguished from missing original sources without changing project files', async t => {
  const root = await fixture(t);
  const installed = path.join(root, '.agents/skills/run-lua-validate');
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, 'SKILL.md'), '# Existing project validation');
  await mkdir(path.join(root, '.codex'));
  await writeFile(path.join(root, '.codex/skills'), '/workspace/.agent/skills');
  const status = await skillStatus(root);
  assert.deepEqual(status.sources, []);
  assert.deepEqual(status.installed, ['.agents/skills/run-lua-validate/SKILL.md']);
  assert.deepEqual(status.conflicts, [{ path: '.codex/skills', reason: 'not_a_directory' }]);
  assert.equal(status.required_for_plugin_validation, false);
  assert.equal(await readFile(path.join(root, '.codex/skills'), 'utf8'), '/workspace/.agent/skills');
});

test('invalid arguments cannot dispatch commands or change environment/workspace', async t => {
  const root = await fixture(t);
  for (const args of [
    { mode: 'build' }, { mode: 'both' }, { mode: 'both', screenshot_frame: 20, frames: 22 },
    { mode: 'screenshot', screenshot_frame: 20, frames: 30 },
    { mode: 'screenshot', screenshot_frame: 20, test: 'test.lua' },
    { screenshot_frame: 20 },
    { frames: 0 }, { frames: '60' }, { timeout_seconds: 581 }, { width: 99 },
    { entry: '../outside.lua' }, { entry: '--help' }, { test: 'C:/outside.lua' },
    { entry: 'folder\\outside.lua' }, { nosound: 'true' },
    { command: 'build' }, { environment: 'rnd' }, { output_dir: '../outside' },
  ]) {
    let calls = 0;
    const result = await runLocalValidation({ action: 'local_validate', workdir: root, ...args },
      async () => { calls += 1; }, parse);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.execution_state, 'not_executed');
    assert.equal(calls, 0);
  }
});

test('live, missing and unverified status never stops, refreshes or starts validation', async t => {
  const root = await fixture(t);
  for (const status of [
    { ...stopped, state: 'running', process_alive: true },
    { ok: false, process_alive: false }, { ok: true },
    { ...stopped, state: 'unknown' },
    { ...stopped, state: 'failed', ok: false, supervisor_retired: false },
  ]) {
    const calls = [];
    const result = await runLocalValidation({ workdir: root }, async args => {
      calls.push(args);
      return { stdout: JSON.stringify(status) };
    }, parse);
    assert.equal(result.execution_state, 'not_executed');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['preview', 'status']);
  }
});

test('safely retired failed sessions can validate without stopping or reviving the old preview', async t => {
  const root = await fixture(t);
  const calls = [];
  const result = await runLocalValidation({ workdir: root }, async args => {
    calls.push(args);
    return { stdout: JSON.stringify(calls.length === 1
      ? { ...stopped, state: 'failed', ok: false, supervisor_retired: true }
      : { ok: true, result: 'COMPLETED' }) };
  }, parse);
  assert.equal(result.execution_state, 'executed');
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['preview', 'status'], ['preview', 'validate']]);
});

test('missing Skill does not block validation; FAIL and partial evidence survive nonzero Runtime results', async t => {
  const root = await fixture(t);
  for (const outcome of ['COMPLETED', 'FAIL', 'TIMEOUT', 'CANCELLED']) {
    const calls = [];
    const original = { ok: outcome === 'COMPLETED', result: outcome,
      report: { result: 'FAIL', summary: { lua_errors: 1 } }, run_id: 'test-run',
      warnings: ['The original run-lua-validate Skill files are missing.'] };
    const result = await runLocalValidation({ workdir: root, mode: 'both',
      screenshot_frame: 183, frames: 263, width: 960, height: 540 }, async (args, input, options) => {
      calls.push(args);
      assert.equal(input, undefined);
      assert.equal(options.preserveExitResult, true);
      return { stdout: JSON.stringify(calls.length === 1 ? stopped : original), exitCode: 1 };
    }, parse);
    assert.equal(result.ok, true);
    assert.equal(result.execution_state, 'executed');
    assert.deepEqual(result.validation, original);
    assert.equal(result.skill.required_for_plugin_validation, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(0, 2), ['preview', 'validate']);
    assert.ok(calls[1].includes('--output-dir=' + path.join(root, '.maker/validation-evidence')));
    assert.ok(!calls.flat().some(arg => ['build', 'init', 'stop', 'install', '--env'].includes(arg)));
  }
});

test('all validation options fit the host childSpawn limit and preserve literal values', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'project with spaces=literal');
  await mkdir(root);
  await writeFile(path.join(root, '.gitignore'), '.maker/validation-evidence/\n');
  const calls = [];
  const result = await runLocalValidation({ workdir: root, mode: 'both',
    entry: 'my scripts/main=entry.lua', test: 'my tests/check=state.lua',
    screenshot_frame: 60, frames: 90, timeout_seconds: 45,
    width: 960, height: 540, nosound: true }, async args => {
    assert.ok(args.length <= 16, 'host discards childSpawn requests with more than 16 args');
    calls.push(args);
    return { stdout: JSON.stringify(args[1] === 'status' ? stopped : { ok: true, result: 'COMPLETED' }) };
  }, parse);
  assert.equal(result.execution_state, 'executed');
  assert.deepEqual(calls[1], ['preview', 'validate', '--target-dir=' + root, '--mode=both',
    '--json', '--screenshot-frame=60', '--validate-frames=90', '--validate-timeout=45',
    '--width=960', '--height=540', '--entry=my scripts/main=entry.lua',
    '--validate-test=my tests/check=state.lua', '--nosound',
    '--output-dir=' + path.join(root, '.maker/validation-evidence')]);
});

test('missing final output is unknown and is not retried', async t => {
  const root = await fixture(t);
  let calls = 0;
  const result = await runLocalValidation({ workdir: root }, async () => {
    calls += 1;
    return { stdout: calls === 1 ? JSON.stringify(stopped) : '{}' };
  }, parse);
  assert.equal(result.execution_state, 'unknown');
  assert.equal(result.automatic_retry, false);
  assert.equal(calls, 2);
});

test('validation refuses unignored or already tracked evidence before dispatch without editing Git state', async t => {
  const root = await fixture(t);
  const ignore = path.join(root, '.gitignore');
  const evidence = path.join(root, '.maker/validation-evidence/old/result.json');
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, '{}');
  for (const tracked of [false, true]) {
    await writeFile(ignore, tracked ? '.maker/validation-evidence/\n' : '');
    if (tracked) execFileSync('git', ['add', '-f', '--', '.maker/validation-evidence'], { cwd: root });
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString();
    let calls = 0;
    const result = await runLocalValidation({ workdir: root }, async () => { calls++; }, parse);
    assert.equal(result.execution_state, 'not_executed');
    assert.match(result.message, /Git/);
    assert.equal(calls, 0);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(), before);
    assert.equal(await readFile(evidence, 'utf8'), '{}');
  }
});

test('validation removes structured Runtime paths while preserving results and relative evidence', async t => {
  const root = await fixture(t);
  const archive = path.join(root, '.maker/validation-evidence/test-run');
  await mkdir(archive, { recursive: true });
  const original = { ok: false, result: 'FAIL', archive_directory: archive,
    project_realpath: '/Volumes/private/project', log_path: '/srv/private/runtime.log',
    evidence_directory: '/mnt/private/evidence', invocation_path: 'Z:/private/invocation.json',
    report: { result: 'FAIL', summary: { lua_errors: 1 } } };
  await writeFile(path.join(archive, 'result.json'), JSON.stringify(original));
  const result = await runLocalValidation({ workdir: root }, async args => ({
    stdout: JSON.stringify(args[1] === 'status' ? stopped : original),
  }), parse);
  assert.equal(result.execution_state, 'executed');
  assert.deepEqual(result.validation, { ok: false, result: 'FAIL', report: original.report });
  assert.deepEqual(result.evidence, ['.maker/validation-evidence/test-run/result.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(archive, 'result.json'), 'utf8')), original);
});

test('evidence path links and outside-project Skill links are rejected without following writes', async t => {
  const root = await fixture(t);
  const external = await fixture(t);
  await mkdir(path.join(root, '.agents'));
  await symlink(external, path.join(root, '.agents/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = await skillStatus(root);
  assert.deepEqual(status.conflicts, [{ path: '.agents/skills', reason: 'outside_project' }]);
  await symlink(external, path.join(root, '.maker'), process.platform === 'win32' ? 'junction' : 'dir');
  let dispatched = false;
  const result = await runLocalValidation({ workdir: root }, async () => { dispatched = true; }, parse);
  assert.equal(result.execution_state, 'not_executed');
  assert.equal(dispatched, false);
});

test('Electron CLI collection ignores progress and partial output and finishes only on final preview JSON', () => {
  const statusArgs = ['preview', 'status', '--json'];
  const validateArgs = ['preview', 'validate', '--json'];
  assert.equal(adapter.isMakerCliOutputComplete(statusArgs, JSON.stringify(stopped)), true);
  assert.equal(adapter.isMakerCliOutputComplete(statusArgs, JSON.stringify({ ok: true })), false);
  assert.equal(adapter.isMakerCliOutputComplete(statusArgs, JSON.stringify({
    protocol_version: 1, ok: false, result: 'FAIL', error: 'Project is not bound', artifacts: [],
  })), true);
  assert.equal(adapter.isMakerCliOutputComplete(validateArgs, '{"ok":true'), false);
  assert.equal(adapter.isMakerCliOutputComplete(validateArgs, JSON.stringify({
    event: 'validation.started', ok: true, result: 'COMPLETED',
  })), false);
  for (const result of ['COMPLETED', 'FAIL', 'TIMEOUT', 'CANCELLED', 'UNSUPPORTED']) {
    assert.equal(adapter.isMakerCliOutputComplete(validateArgs, JSON.stringify({ ok: result === 'COMPLETED', result })), true);
  }
});
