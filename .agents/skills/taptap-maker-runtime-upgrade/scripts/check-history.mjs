import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = path.resolve(skillRoot, '../../..');
const primaryPaths = [
  'taptap-maker',
  '.tests/taptap-maker.test.mjs',
  '.tests/taptap-maker-upgrade.test.mjs',
  '.github/maker-runtime',
  '.github/scripts/sync-maker-runtime.mjs',
  'docs/taptap-maker-maintenance.md',
  'docs/taptap-maker-maintenance.zh-CN.md',
];
const sharedPaths = [
  'README.md', 'README.zh-CN.md', 'provisioning.json',
  '.github', '.tests/plugin-contract.test.mjs',
];

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function parseCommits(output) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, ...subject] = line.split(' ');
    return { hash, subject: subject.join(' ') };
  });
}

export function findUnrecorded(commits, ledger) {
  const recorded = new Set(ledger.match(/\b[a-f0-9]{40}\b/g) || []);
  return commits.filter((commit) => !recorded.has(commit.hash));
}

export function collectHistory(root = repositoryRoot) {
  const common = ['log', '--all', '--full-history', '--reverse', '--format=%H %s'];
  const ordinary = parseCommits(git(root, [...common, '--no-merges', '--', ...primaryPaths]));
  const merges = parseCommits(git(root, [...common, '--merges', '--', ...primaryPaths]));
  const changedMerges = merges.filter((commit) => git(root, [
    'show', '--format=', '--cc', '--name-only', commit.hash, '--', ...primaryPaths,
  ]));
  const shared = parseCommits(git(root, [
    ...common, '--no-merges', '-G', 'taptap-maker|maker-runtime', '--', ...sharedPaths,
  ]));
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    shallow: git(root, ['rev-parse', '--is-shallow-repository']) === 'true',
    ordinary,
    changedMerges,
    shared,
    mergeCount: merges.length,
  };
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error('用法：node .agents/skills/taptap-maker-runtime-upgrade/scripts/check-history.mjs');
  }
  const history = collectHistory();
  const ledger = readFileSync(path.join(skillRoot, 'references/history.md'), 'utf8');
  const missing = findUnrecorded([...history.ordinary, ...history.changedMerges], ledger);
  const sharedMissing = findUnrecorded(history.shared, ledger);
  console.log(JSON.stringify({
    head: history.head,
    shallow: history.shallow,
    ordinaryCommits: history.ordinary.length,
    examinedMerges: history.mergeCount,
    combinedDiffCommits: history.changedMerges,
    unrecordedPrimary: missing,
    unrecordedSharedCandidates: sharedMissing,
    scope: primaryPaths,
    limitation: '仅检查本地可达 refs 和已配置路径；hash 已记录不证明 diff 已审查或行为通过。共享 -G 候选不覆盖所有无 Maker 字样的发布变更；需人工检查路径迁移、每父树合并差异和远端缺失历史。',
  }, null, 2));
  if (history.shallow || missing.length || sharedMissing.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error('历史清单检查失败：' + error.message + '。请检查 Git 和仓库路径后重试。');
    process.exitCode = 1;
  }
}
