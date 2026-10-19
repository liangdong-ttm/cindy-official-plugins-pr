'use strict';

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const { PassThrough } = require('node:stream');

/**
 * `spawnEntry()` 异步返回宿主子进程把手，但 Node 的 spawn() 必须同步返回。
 * 这个窄 facade 先交出稳定的 stdio/EventEmitter，宿主答复后再接通真实把手。
 */
function createDeferredChild(startPromise, options) {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let handle = null;
  let exited = false;
  let killRequested = false;
  let abortListener = null;

  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.ref = function ref() {
    return child;
  };
  child.unref = function unref() {
    return child;
  };
  child.kill = function kill() {
    if (exited) return false;
    child.killed = true;
    if (handle) return handle.kill();
    killRequested = true;
    return true;
  };

  function detachAbortListener() {
    if (abortListener && options && options.signal) {
      options.signal.removeEventListener('abort', abortListener);
    }
    abortListener = null;
  }

  function finishStreams() {
    if (!stdout.destroyed) stdout.end();
    if (!stderr.destroyed) stderr.end();
  }

  Promise.resolve(startPromise).then(function onStarted(nextHandle) {
    if (!nextHandle || !nextHandle.stdin || !nextHandle.stdout || !nextHandle.stderr) {
      throw new Error('Cindy Node 子进程把手不完整');
    }
    handle = nextHandle;
    child.pid = nextHandle.pid;

    stdin.on('data', function onStdin(chunk) {
      if (!exited) nextHandle.stdin.write(chunk);
    });
    stdin.once('end', function onStdinEnd() {
      if (!exited) nextHandle.stdin.end();
    });
    nextHandle.stdout.on('data', function onStdout(chunk) {
      stdout.write(chunk);
    });
    nextHandle.stderr.on('data', function onStderr(chunk) {
      stderr.write(chunk);
    });
    nextHandle.once('exit', function onExit(code, signal) {
      if (exited) return;
      exited = true;
      child.exitCode = code == null ? null : code;
      child.signalCode = signal || null;
      child.killed = true;
      child.emit('exit', code, signal);
    });
    nextHandle.once('close', function onClose(code, signal) {
      exited = true;
      child.exitCode = code == null ? child.exitCode : code;
      child.signalCode = signal || child.signalCode;
      child.killed = true;
      finishStreams();
      detachAbortListener();
      child.emit('close', code, signal);
    });

    if (killRequested) {
      nextHandle.kill();
      return;
    }
    queueMicrotask(function emitSpawn() {
      child.emit('spawn');
    });
  }).catch(function onStartError(error) {
    exited = true;
    child.exitCode = -1;
    child.killed = true;
    finishStreams();
    detachAbortListener();
    queueMicrotask(function emitError() {
      child.emit('error', error instanceof Error ? error : new Error(String(error)));
      child.emit('close', null, null);
    });
  });

  if (options && options.signal) {
    abortListener = function onAbort() {
      child.kill();
    };
    if (options.signal.aborted) abortListener();
    else options.signal.addEventListener('abort', abortListener, { once: true });
  }

  return child;
}

function parseJsonValues(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).flatMap(function parseLine(line) {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
}

/**
 * 官方 CLI 成功时不会主动 process.exit；Electron ParentPort 会让一次性
 * utilityProcess 继续存活。这里只识别本插件实际调用的最终 JSON 结果，
 * 让调用方在完整输出抵达后主动回收进程；中间进度绝不视为完成。
 */
function isMakerCliOutputComplete(args, output) {
  const command = Array.isArray(args) ? args[0] : undefined;
  const values = parseJsonValues(output);
  const last = values[values.length - 1];
  if (command === 'apps') return values.length === 1 && Array.isArray(last);
  if (!last || typeof last !== 'object' || Array.isArray(last)) return false;
  if (command === 'doctor') return values.length === 1;
  if (command === 'preview' && args[1] === 'status') {
    return values.length === 1 && last.protocol_version === 1 && typeof last.ok === 'boolean'
      && ((typeof last.process_alive === 'boolean' && typeof last.state === 'string')
        || (last.ok === false && last.result === 'FAIL' && typeof last.error === 'string'));
  }
  if (command === 'preview' && args[1] === 'validate') {
    return values.length === 1 && typeof last.ok === 'boolean' && !last.event
      && ['COMPLETED', 'FAIL', 'TIMEOUT', 'CANCELLED', 'UNSUPPORTED'].includes(last.result);
  }
  if (command === 'init') return last.step === 'done' && last.status === 'ok';
  if (command === 'login') {
    return Boolean(last.step === 'login'
      && last.status === 'ok'
      && last.data
      && typeof last.data.tap_auth_path === 'string');
  }
  if (command === 'pat') {
    return Boolean(last.step === 'pat'
      && last.status === 'ok'
      && last.data
      && typeof last.data.tap_auth_path === 'string');
  }
  return false;
}

/**
 * 只接管 Maker 对自身入口的 `spawn(process.execPath, ...)`。
 * 其它脚本失败关闭，避免适配器退化成任意 Node 命令执行器。
 */
function installMakerSpawnAdapter(options) {
  if (!options || typeof options.spawnEntry !== 'function') {
    throw new Error('Cindy Node childSpawn 能力不可用');
  }
  const makerEntry = path.resolve(options.makerEntry);
  const realSpawn = childProcess.spawn;

  childProcess.spawn = function spawn(command, args, spawnOptions) {
    if (command !== process.execPath) {
      return realSpawn.call(childProcess, command, args, spawnOptions);
    }
    const argv = Array.isArray(args) ? args.slice() : [];
    const script = typeof argv[0] === 'string' ? path.resolve(argv[0]) : '';
    if (script !== makerEntry) {
      return createDeferredChild(
        Promise.reject(new Error('Maker Runtime 尝试启动未声明的 Node 脚本')),
        spawnOptions,
      );
    }

    const childArgs = argv.slice(1);
    if (childArgs[0] === 'logs' && childArgs[1] === 'watch') {
      // Watcher 必须在真实 Node 下管理自己的 PID 和子 proxy。Node 不可用时
      // 原生 spawn 错误会由 Maker 降级处理，不回退 spawnEntry，避免执行 Cindy.exe。
      return realSpawn.call(
        childProcess,
        'node',
        argv,
        spawnOptions,
      );
    }
    if (
      childArgs[0] === '__maker-proxy'
      && childArgs.length === 1
      && spawnOptions
      && spawnOptions.env
      && typeof spawnOptions.env.PROXY_CONFIG === 'string'
    ) {
      // Maker proxy 原本通过环境变量收配置；childSpawn 刻意不开放任意 env，
      // 改用 Runtime 已支持的命令行 JSON 配置入口。
      childArgs.push(spawnOptions.env.PROXY_CONFIG);
    }
    return createDeferredChild(
      options.spawnEntry(options.childEntry, childArgs),
      spawnOptions,
    );
  };
  syncBuiltinESMExports();

  return function restore() {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
  };
}

module.exports = {
  createDeferredChild,
  isMakerCliOutputComplete,
  installMakerSpawnAdapter,
};
