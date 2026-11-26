import type { RuntimeError } from './types.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { agents } from './agents.ts';
import { resolveHome } from './managed-home.ts';

// An opted-in checkout keeps <cwd>/.paseo-slp/notebook.md. A checkout with no
// .paseo-slp directory reports the daemon notebook
// <home>/slp-runtime/state/notebooks/<sha256(gitCommonDir)>.md and never
// creates it. This locates notebooks through Paseo agent state: Supervisor
// agents whose cwd shares the repository's git common dir — the property that
// links a worktree back to its repository. Read-only: reports candidates with
// status and recency, never copies or mutates notebook content, and issues no
// verdict about which candidate is authoritative. defaultNotebook is always
// the daemon path.
const text = (value: unknown) => typeof value === 'string' && value ? value : null;

const supervisor = (agent: ReturnType<typeof agents>[number]) =>
  text(agent.provider)?.includes('supervisor') || /^supervisor\b/i.test(text(agent.title) ?? '');

const commonDir = (dir: string) => {
  const out = execFileSync('git', ['--no-optional-locks', '-C', dir, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
  return realpathSync(resolve(dir, out));
};

// resolveHome(): under SLP_MANAGED_RUNTIME=1 an absent home must come from
// SLP_DAEMON_HOME/PASEO_HOME or throw — never infer ~/.paseo (spec §10).
const daemonNotebook = (home: string, gitCommonDir: string) => join(home, 'slp-runtime', 'state', 'notebooks',
  `${createHash('sha256').update(gitCommonDir).digest('hex')}.md`);
const optedIn = (cwd: string) => {
  try {
    const stat = lstatSync(join(cwd, '.paseo-slp'));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
};
const notebookFile = (path: string) => {
  try { return lstatSync(path).isFile(); } catch { return false; }
};
export function notebook(repository: string, home = resolveHome()) {
  if (typeof repository !== 'string' || !isAbsolute(repository)) throw new Error('Absolute repository path required');
  const repoDir = realpathSync(repository);
  let root;
  try { root = commonDir(repoDir); } catch {
    throw new Error(`Not a git work tree: ${repoDir}`);
  }
  const gaps = [];
  const matches = [];
  for (const agent of agents(home)) {
    if (!supervisor(agent) || !agent.cwd) continue;
    let agentRoot;
    try { agentRoot = commonDir(agent.cwd); } catch (error) {
      gaps.push({ agentId: agent.id, cwd: agent.cwd, gap: text((error as RuntimeError & { stderr?: string }).stderr?.trim().split('\n')[0]) ?? 'git probe failed' });
      continue;
    }
    if (agentRoot !== root) continue;
    const repositoryNotebook = optedIn(agent.cwd);
    const path = repositoryNotebook ? join(agent.cwd, '.paseo-slp', 'notebook.md') : daemonNotebook(home, root);
    matches.push({ agentId: agent.id, title: agent.title, status: agent.status, cwd: agent.cwd, lastActivityAt: agent.lastActivityAt,
      notebook: path, notebookExists: notebookFile(path), notebookSource: repositoryNotebook ? 'repository' : 'daemon' });
  }
  matches.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return { repository: repoDir, gitCommonDir: root, defaultNotebook: daemonNotebook(home, root), notebooks: matches, ...(gaps.length ? { gaps } : {}) };
}
