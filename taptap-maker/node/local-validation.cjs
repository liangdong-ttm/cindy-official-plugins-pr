'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const execFile = require('node:util').promisify(require('node:child_process').execFile);

const MAX_VALIDATION_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_RESULT_BYTES = 64 * 1024;

const SKILL_ROOTS = ['skills', '.installer/skills', '.agents/skills', '.codex/skills',
  '.claude/skills', '.cursor/skills', '.workbuddy/skills'];
const NUMERIC_OPTIONS = {
  screenshot_frame: ['--screenshot-frame', 1, 1000000],
  frames: ['--validate-frames', 1, 1000000],
  timeout_seconds: ['--validate-timeout', 1, 580],
  width: ['--width', 100, 4096],
  height: ['--height', 100, 4096],
};

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith('..' + path.sep));
}

async function skillStatus(root) {
  root = await fs.realpath(root);
  const sources = [];
  const installed = [];
  const conflicts = [];
  for (const directory of SKILL_ROOTS) {
    let candidate = root;
    try {
      for (const part of directory.split('/')) {
        candidate = path.join(candidate, part);
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          conflicts.push({ path: directory, reason: 'not_a_directory' });
          candidate = null;
          break;
        }
        if (!inside(root, await fs.realpath(candidate))) {
          conflicts.push({ path: directory, reason: 'outside_project' });
          candidate = null;
          break;
        }
      }
      if (!candidate) continue;
      const file = path.join(candidate, 'run-lua-validate', 'SKILL.md');
      if (!inside(root, await fs.realpath(file)) || !(await fs.stat(file)).isFile()) continue;
      await fs.access(file, require('node:fs').constants.R_OK);
      (directory === 'skills' || directory === '.installer/skills' ? sources : installed)
        .push(directory + '/run-lua-validate/SKILL.md');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        conflicts.push({ path: directory, reason: 'unreadable' });
      }
    }
  }
  return { sources, installed, conflicts, required_for_plugin_validation: false };
}

function validationArgs(args, root) {
  const allowed = new Set(['action', 'workdir', 'mode', 'entry', 'test', 'nosound',
    ...Object.keys(NUMERIC_OPTIONS)]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error('Unsupported validation parameter: ' + key);
  }
  const mode = args.mode === undefined ? 'validate' : args.mode;
  if (!['validate', 'screenshot', 'both'].includes(mode)) throw new Error('Invalid validation mode');
  if (mode === 'screenshot' && (args.frames !== undefined || args.test !== undefined)) {
    throw new Error('frames/test 仅适用于 validate 或 both 模式；截图模式请移除这两个参数。');
  }
  if (mode === 'validate' && args.screenshot_frame !== undefined) {
    throw new Error('screenshot_frame 仅适用于 screenshot 或 both 模式。');
  }
  if (mode !== 'validate' && args.screenshot_frame === undefined) {
    throw new Error('screenshot_frame is required for screenshot or both mode');
  }
  // Cindy childSpawn accepts at most 16 argv entries; keep each valued option in one entry.
  const result = ['preview', 'validate', '--target-dir=' + root, '--mode=' + mode, '--json'];
  for (const [key, [flag, min, max]] of Object.entries(NUMERIC_OPTIONS)) {
    if (args[key] === undefined) continue;
    if (!Number.isSafeInteger(args[key]) || args[key] < min || args[key] > max) {
      throw new Error(key + ' must be an integer from ' + min + ' to ' + max);
    }
    result.push(flag + '=' + String(args[key]));
  }
  for (const [key, flag] of [['entry', '--entry'], ['test', '--validate-test']]) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== 'string' || !args[key] || args[key].startsWith('-')
      || args[key].includes(String.fromCharCode(0)) || /[\\:]/.test(args[key])
      || args[key].split('/').some(part => !part || part === '.' || part === '..')
      || path.isAbsolute(args[key])) throw new Error('Invalid project-relative ' + key);
    result.push(flag + '=' + args[key]);
  }
  if (args.nosound !== undefined && typeof args.nosound !== 'boolean') {
    throw new Error('nosound must be a boolean');
  }
  if (args.nosound === true) result.push('--nosound');
  if (mode !== 'validate' && args.frames !== undefined && args.frames < args.screenshot_frame + 3) {
    throw new Error('frames must include at least three readback frames after screenshot_frame');
  }
  return result;
}

function inlineValidation(validation) {
  if (Buffer.byteLength(JSON.stringify(validation)) <= MAX_INLINE_RESULT_BYTES) return validation;
  const report = validation.report;
  const summary = {};
  for (const key of ['lua_errors', 'resource_errors', 'engine_errors', 'total_errors']) {
    if (Number.isSafeInteger(report?.summary?.[key])) summary[key] = report.summary[key];
  }
  const text = value => typeof value === 'string' ? value.slice(0, 4000) : undefined;
  // The full result stays in Runtime's archive; keep the duplicated MCP response bounded.
  return {
    ok: validation.ok, result: text(validation.result), run_id: text(validation.run_id),
    mode: text(validation.mode), error: text(validation.error),
    warnings: Array.isArray(validation.warnings) ? validation.warnings.slice(0, 20).map(text) : undefined,
    report: report && typeof report === 'object' ? {
      result: text(report.result), test_result: text(report.test_result), summary,
      frames_completed: Number.isSafeInteger(report.frames_completed) ? report.frames_completed : undefined,
    } : undefined,
    summary_only: true,
  };
}

async function assertEvidenceIgnored(root) {
  const options = { cwd: root, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 };
  try {
    await execFile('git', ['check-ignore', '-q', '--', '.maker/validation-evidence/'], options);
    // Ignore rules do not protect files that are already in Git's index.
    const tracked = await execFile('git', ['ls-files', '-z', '--', '.maker/validation-evidence'], options);
    if (tracked.stdout.length) throw new Error('Tracked validation evidence');
  } catch {
    throw new Error('无法确认验证证据不会被 Git 提交。请确保 Git 可用、项目属于 Git 工作树，'
      + '将 .maker/validation-evidence/ 加入忽略规则，并确认该目录没有已跟踪文件后再验证。');
  }
}

function withoutRuntimePaths(value) {
  if (value == null) return value;
  const privateKeys = new Set(['project_realpath', 'archive_directory', 'evidence_directory',
    'source_evidence_directory', 'log_path', 'invocation_path']);
  return JSON.parse(JSON.stringify(value, (key, item) => privateKeys.has(key) ? undefined : item));
}

async function runLocalValidation(args, runMaker, parseJsonOutput) {
  let root;
  let cliArgs;
  try {
    if (typeof args.workdir !== 'string' || !path.isAbsolute(args.workdir)) {
      throw new Error('A trusted absolute workspace is required');
    }
    root = await fs.realpath(args.workdir);
    cliArgs = validationArgs(args, root);
    // Evidence is confined to a fixed project directory; never follow a project link on writes.
    let directory = root;
    for (const part of ['.maker', 'validation-evidence']) {
      directory = path.join(directory, part);
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe validation evidence directory');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await assertEvidenceIgnored(root);
    cliArgs.push('--output-dir=' + directory);
  } catch (error) {
    return { ok: false, execution_state: 'not_executed', automatic_retry: false,
      message: error.message };
  }
  const skill = await skillStatus(root);
  let dispatched = false;
  try {
    const status = parseJsonOutput(await runMaker(['preview', 'status', '--target-dir', root, '--json'],
      undefined, { preserveExitResult: true }));
    const confirmedStopped = status && status.process_alive === false
      && ((status.ok === true && ['stopped', 'missing'].includes(status.state))
        || (status.state === 'failed' && status.supervisor_retired === true));
    if (!confirmedStopped) {
      return { ok: false, execution_state: 'not_executed', automatic_retry: false,
        message: status && typeof status.error === 'string' ? status.error
          : '本地预览仍在运行或状态未确认；未停止或接管窗口，请先核对预览状态。', skill, status: withoutRuntimePaths(status) };
    }
    dispatched = true;
    const output = await runMaker(cliArgs, undefined, {
      preserveExitResult: true, maxStdoutBytes: MAX_VALIDATION_STDOUT_BYTES,
    });
    const validation = parseJsonOutput(output);
    if (!validation || Array.isArray(validation) || typeof validation.ok !== 'boolean') {
      throw new Error('Missing final local validation result');
    }
    const evidence = [];
    if (typeof validation.archive_directory === 'string') {
      const archive = path.resolve(validation.archive_directory);
      if (inside(path.join(root, '.maker', 'validation-evidence'), archive)) {
        for (const file of ['result.json', 'validate.json', 'runtime.log', 'screenshot.png']) {
          const absolute = path.join(archive, file);
          try {
            if ((await fs.stat(absolute)).isFile()) evidence.push(path.relative(root, absolute).split(path.sep).join('/'));
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
    const inline = withoutRuntimePaths(inlineValidation(validation));
    return { ok: true, execution_state: 'executed', automatic_retry: false,
      workflow: 'taptap-maker/local-validation.md', skill, validation: inline, evidence,
      ...(inline.summary_only ? { full_result_file: evidence.find(file => file.endsWith('/result.json')) || null } : {}),
      message: '已收集本地验证结果。项目 Skill 不影响插件内置验证；COMPLETED 不等于 PASS，请检查原始报告并查看每张截图。' };
  } catch (error) {
    return { ok: false, execution_state: dispatched ? 'unknown' : 'not_executed',
      automatic_retry: false, message: error.message, skill };
  }
}

module.exports = { runLocalValidation, skillStatus };
