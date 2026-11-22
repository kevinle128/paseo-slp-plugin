import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, json } from '../plugin/server/runtime/cli/package.ts';
import { configurationPlan } from '../plugin/server/runtime/cli/paseo-install.ts';
import { launchPlan } from '../plugin/server/runtime/cli/launch.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { createExecutableResolver } from '../plugin/server/executables.ts';
import { createLauncherBuilder } from '../plugin/server/launchers.ts';
import { assertPersistedCompatible, desiredProviderEntries } from '../plugin/server/config-transaction.ts';
import { assertProjectionShape } from '../plugin/server/journal.ts';
import { observeTaskProviders } from '../plugin/server/desk-task-runtime.ts';
import { auditCapabilities } from '../plugin/server/capabilities.ts';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { OWNED_PROVIDER_IDS } from '../plugin/shared/runtime/families.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ROLES = ['supervisor', 'lead', 'peer'];
const CURSOR_VERSION = '2026.11.22-e9042b2';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-cursor-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = join(dir, 'candidate');
  const { candidate: identity } = install(root, candidate);
  return { dir, candidate, sha: identity.sha256 };
}
const envFor = f => ({ HOME: f.dir, PATH: '/usr/bin:/bin', PASEO_HOME: join(f.dir, 'home') });
// A fake cursor-agent: answers --version, records argv, then echoes stdin.
function fakeCursor(f, marker) {
  const path = join(f.dir, 'cursor-agent');
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${CURSOR_VERSION}'; echo diagnostic >&2; exit 0; fi\necho "$@" > '${marker}'\ncat\n`, { mode: 0o755 });
  return path;
}

test('Cursor wrapper runs only `acp` (also by default) and the bare version probe', t => {
  const f = fixture(t); const marker = join(f.dir, 'spawned'); const fake = fakeCursor(f, marker);
  const run = args => spawnSync(process.execPath, [join(f.candidate, 'bin/cursor-role.mjs'), 'peer', ...args], { input: '', encoding: 'utf8', timeout: 10000, env: { ...envFor(f), SLP_CURSOR_BIN: fake } });
  const probe = run(['--version']);
  assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout, `${CURSOR_VERSION}\n`); assert.equal(probe.stderr, 'diagnostic\n');
  assert.equal(existsSync(marker), false, 'the version probe opens no session');
  for (const args of [['agent'], ['acp', '--model', 'x'], ['--version', 'extra'], ['login'], ['-p', 'task']]) {
    const out = run(args);
    assert.equal(out.status, 1, args.join(' ')); assert.match(out.stderr, /supports only `cursor-agent acp`/); assert.equal(existsSync(marker), false, args.join(' '));
  }
  for (const args of [[], ['acp']]) {
    const out = run(args);
    assert.equal(out.status, 0, out.stderr); assert.equal(readFileSync(marker, 'utf8'), 'acp\n'); rmSync(marker);
  }
});

test('Cursor ACP prompts carry role entry first, core on follow-ups, rearm on session/load, and keep other frames byte-exact', t => {
  const f = fixture(t); const fake = fakeCursor(f, join(f.dir, 'spawned'));
  const initialize = '{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }';
  const prompt = { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'task' }], untouched: 'keep' } };
  const model = '{ "jsonrpc": "2.0", "id": 3, "method": "session/set_config_option", "params": { "sessionId": "s", "configId": "model", "value": "grok-4.7" } }';
  const load = { jsonrpc: '2.0', id: 4, method: 'session/load', params: { sessionId: 's', cwd: f.dir, mcpServers: [] } };
  const input = [initialize, JSON.stringify(prompt), model, JSON.stringify(prompt), JSON.stringify(load), JSON.stringify(prompt)].join('\n');
  const out = spawnSync(process.execPath, [join(f.candidate, 'bin/cursor-role.mjs'), 'peer'], { input, encoding: 'utf8', timeout: 10000, env: { ...envFor(f), SLP_CURSOR_BIN: fake } });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines[0], initialize, 'initialize passes through byte-for-byte');
  assert.equal(lines[2], model, 'config frames pass through byte-for-byte');
  const frames = lines.map(line => JSON.parse(line));
  assert.deepEqual(frames[4], load);
  for (const i of [1, 3, 5]) {
    assert.ok(frames[i].params.prompt[0].text.startsWith('SLP role=peer\n'), `prompt ${i} starts with the role line`);
    assert.ok(frames[i].params.prompt[0].text.includes('Human authority is the ceiling'));
    assert.deepEqual(frames[i].params.prompt[1], prompt.params.prompt[0]);
    assert.equal(frames[i].params.untouched, 'keep');
  }
  assert.ok(frames[1].params.prompt[0].text.includes('Policy locators — relative to Directory;'), 'first prompt carries the entry helpers');
  assert.ok(!frames[3].params.prompt[0].text.includes('Policy locators — relative to Directory;'), 'follow-up carries the core only');
  assert.ok(frames[5].params.prompt[0].text.includes('Policy locators — relative to Directory;'), 'session/load rearms the entry');
});

test('managed provider entries extend the host Cursor client and run the launch-set launcher; standalone publishes no Cursor', t => {
  const f = fixture(t);
  const setDir = join(f.dir, 'set');
  const launchSet = { directory: setDir, launchSetSha256: 'a'.repeat(64), launchManifestSha256: 'a'.repeat(64),
    files: OWNED_PROVIDER_IDS.map(id => ({ path: join(setDir, id), sha256: 'b'.repeat(64), mode: 0o755 })) };
  const binaries = Object.fromEntries(['codex', 'pi', 'devin', 'claude', 'opencode', 'antigravity', 'cursor']
    .map(family => [family, family === 'cursor' ? { available: true, path: '/opt/bin/cursor-agent', version: CURSOR_VERSION } : { available: false, path: null, version: null }]));
  const entries = desiredProviderEntries(launchSet, { node: { path: '/opt/node/bin/node', version: '24.0.0' }, binaries }, f.candidate, join(f.dir, 'home'), null);
  for (const role of ROLES) {
    const entry = entries[`slp-cursor-${role}`];
    assert.equal(entry.extends, 'cursor');
    assert.equal(entry.label, `SLP Cursor ${role[0].toUpperCase()}${role.slice(1)}`);
    assert.deepEqual(entry.command, [join(setDir, `slp-cursor-${role}`)]);
    assert.equal(entry.enabled, true);
    assert.equal(entry.env.SLP_CURSOR_BIN, '/opt/bin/cursor-agent');
    assert.equal(entry.env.SLP_FAMILY_BIN, undefined, 'wrapper transport, not a hook gate');
    assert.equal(Object.hasOwn(entry, 'paseoTools'), role === 'peer');
  }
  const plan = configurationPlan(f.candidate, { version: 1 });
  assert.ok(Object.keys(plan.providers).every(id => !id.startsWith('slp-cursor-')), 'a stock host rejects extends cursor');
});

test('managed Cursor launcher needs no session grant, enters `acp` and delivers role bytes', async t => {
  const f = fixture(t); const marker = join(f.dir, 'spawned'); const fake = fakeCursor(f, marker);
  const home = join(f.dir, 'home'); const stableRoot = join(home, 'slp-runtime');
  const installed = join(stableRoot, f.sha); install(root, installed);
  const binaries = Object.fromEntries(['codex', 'pi', 'devin', 'claude', 'opencode', 'antigravity', 'cursor']
    .map(id => [id, id === 'cursor' ? { available: true, path: fake, version: CURSOR_VERSION } : { available: false, path: null, version: null }]));
  const set = await createLauncherBuilder().publish({ daemonHome: home, stableRoot, operationId: 'cursor-launch', candidate: { sha256: f.sha, runtimePath: installed }, node: { path: process.execPath, version: process.versions.node, execPath: process.execPath }, binaries });
  const launcher = join(set.directory, 'slp-cursor-peer');
  const message = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [{ type: 'text', text: 'local echo fixture' }] } };
  const run = (args = []) => spawnSync(launcher, args, { input: JSON.stringify(message) + '\n', encoding: 'utf8', timeout: 10000, env: { ...envFor(f), PASEO_AGENT_ID: 'agent' } });
  const probe = run(['--version']); assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout, `${CURSOR_VERSION}\n`); assert.equal(existsSync(marker), false);
  const out = run(); assert.equal(out.status, 0, out.stderr); assert.equal(readFileSync(marker, 'utf8'), 'acp\n');
  const transformed = JSON.parse(out.stdout);
  assert.ok(transformed.params.prompt[0].text.startsWith('SLP role=peer\n'));
  assert.deepEqual(transformed.params.prompt[1], message.params.prompt[0]);
});

test('Cursor launch plans require the live provider entry to state extends cursor', t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, '.paseo-slp'));
  writeFileSync(join(f.dir, '.paseo-slp/slp-routing.json'), json({ version: 1, policy: 'fixture', quotaFallback: { enabled: false, optionId: null }, options: [{ id: 'cursor-grok', provider: 'cursor', model: 'grok-4.7', roles: ['peer'], enabled: true, availability: 'ready', suitableFor: [], avoidFor: [], notes: 'Bounded Cursor fixture' }] }));
  const providers = ROLES.map(role => ({ id: `slp-cursor-${role}`, enabled: true, status: 'available', extends: 'cursor' }));
  const base = { repository: f.dir, workspaceId: 'workspace', assignment: 'Inspect only.', role: 'peer', route: { optionId: 'cursor-grok', catalogSha256: readCatalog(f.dir).sha256 } };
  const peer = launchPlan(f.candidate, { ...base, providers });
  assert.equal(peer.create.provider, 'slp-cursor-peer/grok-4.7');
  for (const extendsValue of [undefined, 'acp', 'opencode', 'codex']) {
    const wrong = providers.map(({ extends: ignored, ...p }) => extendsValue === undefined ? p : { ...p, extends: extendsValue });
    assert.throws(() => launchPlan(f.candidate, { ...base, providers: wrong }), /Unverified provider family/, String(extendsValue));
  }
});

test('task runtime backfills a missing Cursor extends from stable live config and refuses changed or missing evidence', async () => {
  const entry = { provider: 'slp-cursor-peer', enabled: true, status: 'ready' };
  const host = (configs) => {
    let reads = 0;
    return { providers: { snapshot: async () => ({ entries: [{ ...entry }] }) },
      config: { get: async () => ({ config: { providers: { 'slp-cursor-peer': configs[Math.min(reads++, configs.length - 1)] } } }) } };
  };
  const warmup = { budgetMs: 1000, pollMs: 10 };
  const stable = await observeTaskProviders(host([{ extends: 'cursor' }]), '/repo', warmup);
  assert.equal(stable.entries[0].extends, 'cursor');
  for (const configs of [[{ extends: 'cursor' }, { extends: 'acp' }], [{}]]) {
    const refused = await observeTaskProviders(host(configs), '/repo', warmup);
    assert.equal(refused.entries[0].status, 'unavailable');
    assert.equal(refused.entries[0].error, 'Cursor transport evidence is missing, changed or unavailable');
  }
});

test('the pinned config validator admits extends cursor only on owned Cursor aliases', () => {
  const entry = value => ({ extends: value, label: 'L', command: ['/bin/x'], env: {}, enabled: false });
  for (const role of ROLES) assert.doesNotThrow(() => assertPersistedCompatible({ version: 1, agents: { providers: { [`slp-cursor-${role}`]: entry('cursor') } } }));
  for (const providers of [
    { 'my-cursor': entry('cursor') },
    { 'slp-devin-peer': entry('cursor') },
    { 'slp-cursor-peer': entry('bogus') },
    { 'slp-cursor-peer': { extends: 'cursor', label: 'L' } },
  ]) {
    assert.throws(() => assertPersistedCompatible({ version: 1, agents: { providers } }), error => error.code === 'SCHEMA_LOSS', JSON.stringify(providers));
  }
});

test('owned projections refuse extends cursor outside the Cursor family', () => {
  const owned = value => ({ present: true, value: { extends: value, label: 'L', command: ['/bin/x'], env: {}, enabled: true } });
  const projection = override => ({ providers: { ...Object.fromEntries(OWNED_PROVIDER_IDS.map(id => [id, { present: false }])), ...override }, profilesPresent: false, profiles: [], injectIntoAgents: { present: false } });
  assert.doesNotThrow(() => assertProjectionShape(projection({ 'slp-cursor-peer': owned('cursor') })));
  assert.throws(() => assertProjectionShape(projection({ 'slp-cursor-peer': owned('acp') })), /extends acp, expected cursor/);
  assert.throws(() => assertProjectionShape(projection({ 'slp-devin-peer': owned('cursor') })), /extends cursor, expected acp/);
});

test('resolver finds cursor-agent on PATH, keeps the stable alias and records its date version', async t => {
  const f = fixture(t);
  const target = join(f.dir, 'versions', CURSOR_VERSION, 'cursor-agent'); mkdirSync(join(f.dir, 'versions', CURSOR_VERSION), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const bin = join(f.dir, 'bin'); mkdirSync(bin); symlinkSync(target, join(bin, 'cursor-agent'));
  const resolver = createExecutableResolver({ env: { PATH: bin }, run: async (file, args) => ({ code: 0, stderr: '', stdout: args[0] === '-e' ? JSON.stringify({ node: process.versions.node, electron: null, execPath: process.execPath }) : `${CURSOR_VERSION}\n` }) });
  const { binaries } = await resolver.resolve({ daemonHome: join(f.dir, 'home'), stableRoot: join(f.dir, 'stable'), nodePath: process.execPath });
  assert.deepEqual(binaries.cursor, { available: true, path: join(bin, 'cursor-agent'), version: CURSOR_VERSION });
});

test('Cursor seats receive only the desk handle at agent.create and carry no grant at session open', async t => {
  const f = fixture(t);
  const binding = { candidateSha256: f.sha, payloadSha256: 'a'.repeat(64), runtimePath: f.candidate, nodePath: process.execPath, daemonHome: join(f.dir, 'home') };
  const injection = createRoleInjection({ readActiveBinding: () => binding, verifyCandidate: async () => {}, deskMint: async () => ({ handle: 'a'.repeat(64) }) });
  for (const role of ROLES) {
    const config = { provider: `slp-cursor-${role}`, cwd: f.dir, model: 'grok-4.7', systemPrompt: 'Human instructions' };
    const out = await injection.agentCreate({ request: { config, env: { KEEP: 'yes' } } });
    assert.deepEqual(out.config, config, 'ACP keeps config intact; the wrapper delivers the role');
    assert.deepEqual(out.env, { KEEP: 'yes', SLP_DESK_HANDLE: 'a'.repeat(64) });
    const open = injection.sessionOpen({ request: { provider: config.provider, cwd: f.dir, agentId: 'agent', workspaceId: 'workspace', reason: 'create', purpose: 'interactive', env: { KEEP: 'yes' } } });
    assert.equal(open?.env?.SLP_SESSION_OPEN_GRANT, undefined, 'no session-open grant for Cursor');
  }
});

test('capability audit records Cursor with no exact MCP preapproval and ACP MCP plumbing', () => {
  const { records } = auditCapabilities({ now: '2026-11-22T00:00:00.000Z', observed: { rpcDispatched: false, providersSnapshot: null, agentsList: null } });
  const rows = records.filter(r => r.family === 'cursor');
  assert.equal(rows.length, 6);
  assert.equal(rows.find(r => r.capabilityId === 'tool-policy.mcp-preapproval')?.status, 'unsupported');
  assert.equal(rows.find(r => r.capabilityId === 'mcp-servers.stdio-launch')?.status, 'supported');
});
