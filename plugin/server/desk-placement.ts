// Formation-only placement. Git/common-dir and configuration pins are local;
// workspace identity comes from the connected SDK. No worktree creation/setup.
// One desk = one Git repository: placement stays in the caller's repository,
// except that a Supervisor may place a Lead in another repository's existing
// workspace; that Lead registers in, and is pinned to, the target repository.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { DeskSeatCreateInputValue } from "../shared/delegation.ts";
import type { DeskRejectionValue } from "../shared/enforcement.ts";
import type { MembershipValue } from "./desk-store.ts";
import { canonicalSha256 } from "./config-view.ts";
import { TaskRepositoryMismatchError } from "./desk-task-access.ts";
import { createTaskGitIo, type TaskGitIo, type TaskWorkspaceCreateOptions, type TaskAgentHandle } from "./desk-task-execution-host.ts";
import { TaskHostWaitExpired } from "./desk-task-host.ts";

export type FormationWorkspaceSnapshot = {
  id: string; workspaceDirectory?: string; status: string;
  archivingAt?: string | null; archivedAt?: string | null;
};
export type FormationWorkspaceHandle = {
  readonly id: string;
  refresh(options?: { requestId?: string }): Promise<FormationWorkspaceSnapshot | null>;
  agents: { create(options: TaskWorkspaceCreateOptions): Promise<TaskAgentHandle> };
};
/** Narrow structural SDK contract; intentionally no workspace.create or scripts. */
export type FormationWorkspaceApi = { workspaces: {
  ref(id: string): FormationWorkspaceHandle;
  open(input: { cwd: string; requestId?: string }): Promise<FormationWorkspaceHandle>;
} };
export type FormationSourcePin = {
  repository: string; gitCommonDir: string; head: string;
  configuration: Record<string, string | null>;
};
export type FormationTargetPin = {
  workspaceId: string; cwd: string; head: string; gitCommonDir: string;
  source: FormationSourcePin; reason: string | null;
};
type Phase = (name: string, value: unknown) => void;
type Guard = () => Promise<DeskRejectionValue | null>;
type Git = Pick<TaskGitIo, "commonDir" | "top" | "revParse" | "worktreeList">
  & Partial<Pick<TaskGitIo, "absoluteGitDir" | "lsTree" | "lsFilesStage" | "submodulePaths" | "coreWorktree">>;

export class FormationPlacementError extends Error {
  readonly code: DeskRejectionValue["code"];
  readonly workspaceId?: string;
  constructor(code: DeskRejectionValue["code"], message: string, workspaceId?: string) {
    super(message); this.code = code; this.workspaceId = workspaceId;
  }
}
export class FormationPlacementUncertain extends Error {
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly correlationKey: string;
  constructor(workspaceId: string | null, cwd: string | null, correlationKey: string) {
    super("placement observation/open is uncertain; retain identities and do not repeat effects");
    this.workspaceId = workspaceId; this.cwd = cwd; this.correlationKey = correlationKey;
  }
}

const CONFIG_FILES = ["slp-routing.json", "workspace-protocol.md"];
function configuration(repository: string): Record<string, string | null> {
  const pins: Record<string, string | null> = {};
  for (const name of CONFIG_FILES) {
    let fd: number;
    try { fd = openSync(join(repository, ".paseo-slp", name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { pins[name] = null; continue; }
      throw new FormationPlacementError("CAPABILITY_GAP", "placement configuration is not readable as a regular file");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("unsupported configuration");
      pins[name] = canonicalSha256(readFileSync(fd, "utf8"));
    } catch { throw new FormationPlacementError("CAPABILITY_GAP", "placement configuration exceeds its regular-file budget"); }
    finally { closeSync(fd); }
  }
  return pins;
}
function directory(value: string): string {
  try {
    if (!isAbsolute(value)) throw new Error("relative path");
    const canonical = realpathSync(value);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch { throw new FormationPlacementError("CAPABILITY_GAP", "placement requires an existing absolute checkout directory"); }
}

const SUBMODULE_CONFIG_CAP = 256 * 1024;
function safeRelativeSegments(value: string, forbidDotGit: boolean): string[] | null {
  if (!value || value.startsWith("/") || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (parts.some(part => part === "" || part === "." || part === ".." || (forbidDotGit && part === ".git"))) return null;
  return parts;
}
function realDirectoryPath(root: string, parts: string[]): string | null {
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    const stat = lstatSync(cur);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  const canonical = realpathSync(cur);
  return canonical.startsWith(`${root}/`) ? canonical : null;
}
function regularFileWithinCap(path: string, cap: number): boolean {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return false; }
  try {
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= cap;
  } catch { return false; }
  finally { closeSync(fd); }
}
function parseSubmoduleEntries(raw: string): { name: string; path: string }[] | null {
  if (Buffer.byteLength(raw) > SUBMODULE_CONFIG_CAP) return null;
  const entries: { name: string; path: string }[] = [];
  for (const record of raw.split("\0").filter(Boolean)) {
    const nl = record.indexOf("\n");
    if (nl < 0) return null;
    const key = record.slice(0, nl), value = record.slice(nl + 1);
    const match = /^submodule\.(.+)\.path$/i.exec(key);
    if (!match) continue;
    entries.push({ name: match[1], path: value });
  }
  return entries;
}
function uniqueSubmoduleName(raw: string, relPath: string): string | null {
  const entries = parseSubmoduleEntries(raw);
  if (!entries) return null;
  const matches = entries.filter(e => e.path === relPath);
  return matches.length === 1 ? matches[0].name : null;
}
function uniqueSubmodulePath(raw: string, name: string): string | null {
  const entries = parseSubmoduleEntries(raw);
  if (!entries) return null;
  const matches = entries.filter(e => e.name === name);
  return matches.length === 1 ? matches[0].path : null;
}

export function createFormationPlacement(deps: {
  repo: { gitCommonDir: string }; host: () => FormationWorkspaceApi | null; git?: Git;
  budgets?: { readMs: number; effectMs: number };
}) {
  const git = deps.git ?? createTaskGitIo();
  const budgets = deps.budgets ?? { readMs: 8000, effectMs: 20000 };
  if (!Object.values(budgets).every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid formation wait budget");
  let handle: FormationWorkspaceHandle | undefined;
  let observedProtocolRepository: string | undefined;
  const wait = async <T>(effect: boolean, operation: string, fn: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TaskHostWaitExpired(operation, effect)), effect ? budgets.effectMs : budgets.readMs);
    })]); } finally { clearTimeout(timer); }
  };
  const observeCommon = async (cwd: string) => {
    try { return await git.commonDir(cwd); }
    catch { throw new FormationPlacementError("CAPABILITY_GAP", "placement Git repository cannot be observed"); }
  };
  const common = async (cwd: string, repo = deps.repo.gitCommonDir) => {
    const actual = await observeCommon(cwd);
    if (actual !== repo) {
      throw new FormationPlacementError("CAPABILITY_GAP", `${new TaskRepositoryMismatchError(repo, actual).message.replace(/^task checkout/, "seat placement")}; only a Supervisor may place a Lead in another repository's existing workspace`);
    }
    return actual;
  };
  const head = async (cwd: string) => {
    const value = await git.revParse(cwd, "HEAD");
    if (value === null || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
      throw new FormationPlacementError("CAPABILITY_GAP", "placement requires a resolvable Git HEAD");
    }
    return value;
  };
  const mainCheckout = async (repo: string): Promise<string | null> => {
    if (basename(repo) === ".git") return dirname(repo);
    if (!git.coreWorktree || !regularFileWithinCap(join(repo, "config"), SUBMODULE_CONFIG_CAP)) return null;
    try {
      const configured = await git.coreWorktree(repo);
      return configured ? realpathSync(resolve(repo, configured)) : null;
    } catch { return null; }
  };
  const locateSource = async (start: string, repo = deps.repo.gitCommonDir) => {
    const cwd = directory(start); await common(cwd, repo);
    const top = directory(await git.top(cwd)); await common(top, repo);
    const local = configuration(top);
    // Preserve a checkout's own configuration (including protocol-only user
    // pools). A linked checkout lacking both files inherits only its same-Git
    // main checkout, never an unrelated ancestor or the user pool by accident.
    if (Object.values(local).some(value => value !== null)) return { repository: top, configuration: local, inherited: false };
    const main = await mainCheckout(repo);
    if (main !== null && top === main) return { repository: top, configuration: local, inherited: false };
    if (main !== null) {
      try {
        const repository = directory(main); await common(repository, repo);
        if (directory(await git.top(repository)) !== repository) throw new Error("not the main checkout");
        const pins = configuration(repository);
        if (Object.values(pins).some(value => value !== null)) return { repository, configuration: pins, inherited: true };
      } catch (error) { if (error instanceof FormationPlacementError && error.code === "ROUTE_DRIFT") throw error; }
    }
    throw new FormationPlacementError("CAPABILITY_GAP", "linked checkout has no trustworthy same-repository configuration source; restore the main checkout routing/protocol configuration before formation; no implicit user-pool fallback");
  };
  const sourceAt = async (start: string, repo = deps.repo.gitCommonDir): Promise<FormationSourcePin> => {
    const located = await locateSource(start, repo);
    return { repository: located.repository, gitCommonDir: repo,
      head: await head(located.repository), configuration: located.configuration };
  };
  const source = (row: MembershipValue) => sourceAt(row.createCwd);
  // A pin outside the caller's repository exists only for a Supervisor caller;
  // its source is re-located from the target workspace, never the caller.
  const pinnedSource = (row: MembershipValue, pin: FormationTargetPin) => {
    if (pin.gitCommonDir === deps.repo.gitCommonDir) return source(row);
    if (row.role !== "supervisor") throw new FormationPlacementError("CAPABILITY_GAP", "only a Supervisor may place a Lead in another repository", pin.workspaceId);
    return sourceAt(pin.cwd, pin.gitCommonDir);
  };
  const liveDirectory = async (workspaceId: string, cwd: string | null, key: string, repo: string | null = deps.repo.gitCommonDir) => {
    if (!handle || handle.id !== workspaceId) {
      const api = deps.host();
      if (!api || typeof api.workspaces?.ref !== "function") throw new FormationPlacementError("CAPABILITY_GAP", "host lacks workspace ref/refresh", workspaceId);
      handle = api.workspaces.ref(workspaceId);
    }
    if (typeof handle.refresh !== "function") throw new FormationPlacementError("CAPABILITY_GAP", "host lacks workspace refresh", workspaceId);
    const readKey = canonicalSha256([key, randomUUID()]);
    let snapshot: FormationWorkspaceSnapshot | null;
    try { snapshot = await wait(false, "workspace.refresh", () => handle!.refresh({ requestId: readKey })); }
    catch { throw new FormationPlacementUncertain(workspaceId, cwd, readKey); }
    if (!snapshot || snapshot.id !== workspaceId || handle.id !== workspaceId
      || typeof snapshot.status !== "string" || !snapshot.status
      || snapshot.archivingAt !== null || snapshot.archivedAt != null || typeof snapshot.workspaceDirectory !== "string") {
      throw new FormationPlacementError("CAPABILITY_GAP", "workspace is missing, archiving or has no exact live descriptor", workspaceId);
    }
    const actual = directory(snapshot.workspaceDirectory);
    if (repo !== null) await common(actual, repo);
    // SDK create carries workspaceId; the server resolves cwd from its registry.
    // Qualify the descriptor now, then verify the actual agent cwd after create.
    if (snapshot.workspaceDirectory !== actual || (cwd !== null && cwd !== actual)) {
      throw new FormationPlacementError("ROUTE_DRIFT", "workspace directory differs from its canonical declared cwd", workspaceId);
    }
    return actual;
  };
  const observe = async (workspaceId: string, cwd: string | null, key: string, repo = deps.repo.gitCommonDir) => {
    const actual = await liveDirectory(workspaceId, cwd, key, repo);
    return { cwd: actual, head: await head(actual) };
  };
  const checkConfiguration = async (pin: FormationSourcePin, cwd: string) => {
    const targetRoot = directory(await git.top(cwd));
    await common(targetRoot, pin.gitCommonDir);
    const target = configuration(targetRoot);
    for (const name of CONFIG_FILES) if (target[name] !== null && target[name] !== pin.configuration[name]) {
      throw new FormationPlacementError("ROUTE_DRIFT", "target routing/protocol configuration conflicts with the pinned source");
    }
  };
  const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  // Every registered checkout (main, bare or linked) of the repository at cwd.
  const checkouts = async (cwd: string) => {
    try {
      const raw = await git.worktreeList(cwd);
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("registration cap");
      const paths = raw.split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice("worktree ".length));
      if (paths.length === 0 || paths.some(path => !isAbsolute(path))) throw new Error("no registration");
      return paths.map(path => { try { return realpathSync(path); } catch { return path; } });
    } catch {
      throw new FormationPlacementError("CAPABILITY_GAP", "placement worktree registrations cannot be observed; cross-repository Lead placement fails closed");
    }
  };
  // Verify that childRoot is strictly a registered Git submodule checkout of
  // parentRoot whose common-dir matches targetCommonDir under parentGitDir/modules/<name>.
  const verifySubmoduleCheckout = async (parentRoot: string, childRoot: string, targetCommonDir: string): Promise<boolean> => {
    if (!git.absoluteGitDir || !git.lsTree || !git.lsFilesStage || !git.submodulePaths) return false;
    if (!childRoot.startsWith(`${parentRoot}/`)) return false;
    const relPath = childRoot.slice(parentRoot.length + 1);
    const relParts = safeRelativeSegments(relPath, true);
    if (!relParts) return false;
    try {
      if (realDirectoryPath(parentRoot, relParts) !== childRoot) return false;
      if (!regularFileWithinCap(join(parentRoot, ".gitmodules"), SUBMODULE_CONFIG_CAP)) return false;
      const headEntries = (await git.lsTree(parentRoot, "HEAD", relPath)).split("\0").filter(Boolean);
      if (headEntries.length !== 1 || !/^160000 commit [a-f0-9]{40}(?:[a-f0-9]{24})?\t/.test(headEntries[0])
        || headEntries[0].slice(headEntries[0].indexOf("\t") + 1) !== relPath) return false;
      const indexEntries = (await git.lsFilesStage(parentRoot, relPath)).split("\0").filter(Boolean);
      if (indexEntries.length !== 1 || !/^160000 [a-f0-9]{40}(?:[a-f0-9]{24})? 0\t/.test(indexEntries[0])
        || indexEntries[0].slice(indexEntries[0].indexOf("\t") + 1) !== relPath) return false;
      const headName = uniqueSubmoduleName(await git.submodulePaths(parentRoot, "HEAD"), relPath);
      const fileName = uniqueSubmoduleName(await git.submodulePaths(parentRoot, "file"), relPath);
      if (!headName || headName !== fileName) return false;
      const nameParts = safeRelativeSegments(headName, false);
      if (!nameParts) return false;
      const dotGitStat = lstatSync(join(childRoot, ".git"));
      if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) return false;
      const parentGitDir = await git.absoluteGitDir(parentRoot);
      const modulesRoot = realpathSync(join(parentGitDir, "modules"));
      const expectedCommonDir = realDirectoryPath(modulesRoot, nameParts);
      if (!expectedCommonDir || expectedCommonDir !== targetCommonDir) return false;
      if (await git.commonDir(childRoot) !== expectedCommonDir) return false;
      if (directory(await git.top(childRoot)) !== childRoot) return false;
      return true;
    } catch { return false; }
  };
  // An overlapping target path inside parentRoot is allowed only when it is
  // either the registered submodule checkout itself or that submodule's own
  // metadata directory under parentGitDir/modules/<name> (reported by git worktree list).
  const isRegisteredSubmodule = async (parentRoot: string, targetPath: string, targetCommonDir: string): Promise<boolean> => {
    if (await verifySubmoduleCheckout(parentRoot, targetPath, targetCommonDir)) return true;
    if (targetPath !== targetCommonDir || !git.absoluteGitDir || !git.submodulePaths) return false;
    try {
      const parentGitDir = await git.absoluteGitDir(parentRoot);
      const modulesRoot = realpathSync(join(parentGitDir, "modules"));
      if (!targetPath.startsWith(`${modulesRoot}/`)) return false;
      const name = targetPath.slice(modulesRoot.length + 1);
      const nameParts = safeRelativeSegments(name, false);
      if (!nameParts || realDirectoryPath(modulesRoot, nameParts) !== targetPath) return false;
      if (!regularFileWithinCap(join(parentRoot, ".gitmodules"), SUBMODULE_CONFIG_CAP)) return false;
      const headRel = uniqueSubmodulePath(await git.submodulePaths(parentRoot, "HEAD"), name);
      const fileRel = uniqueSubmodulePath(await git.submodulePaths(parentRoot, "file"), name);
      if (!headRel || headRel !== fileRel) return false;
      const relParts = safeRelativeSegments(headRel, true);
      if (!relParts) return false;
      const childRoot = realDirectoryPath(parentRoot, relParts);
      return childRoot !== null && await verifySubmoduleCheckout(parentRoot, childRoot, targetCommonDir);
    } catch { return false; }
  };
  // Two repositories are separate desks when no registered checkout of either
  // contains, or is contained by, a checkout of the other — except when every
  // overlapping pair is a registered Git submodule inside a caller checkout.
  const assertSeparate = async (callerCwd: string, targetCwd: string, code: DeskRejectionValue["code"], workspaceId?: string) => {
    const callerDir = directory(callerCwd), targetDir = directory(targetCwd);
    const callerTop = directory(await git.top(callerDir)), targetTop = directory(await git.top(targetDir));
    const targetCommonDir = await observeCommon(targetDir);
    const caller = [...new Set([...await checkouts(callerDir), callerTop])];
    const target = [...new Set([...await checkouts(targetDir), targetTop])];
    for (const a of caller) {
      for (const b of target) {
        if (!overlaps(a, b)) continue;
        if (await isRegisteredSubmodule(a, b, targetCommonDir)) continue;
        throw new FormationPlacementError(code, "placement repository is nested with the caller's repository; a cross-repository Lead requires separate checkouts or a registered submodule of the caller's repository", workspaceId);
      }
    }
  };
  // Supervisor + Lead + existing placement is the only combination that may
  // leave the caller's repository. Every other request, and any failed
  // classification read, keeps the caller's repo and its historical path.
  const placementRepository = async (row: MembershipValue, input: DeskSeatCreateInputValue, key: string) => {
    const placement = input.placement;
    if (placement?.kind !== "existing" || row.role !== "supervisor" || input.role !== "lead") return null;
    let start: string, repo: string;
    try {
      start = placement.cwd !== undefined ? directory(placement.cwd)
        : await liveDirectory(placement.workspaceId!, null, key, null);
      repo = await observeCommon(start);
    } catch { return null; }
    if (repo === deps.repo.gitCommonDir) return null;
    await assertSeparate(row.createCwd, start, "CAPABILITY_GAP", placement.workspaceId);
    return { repo, start };
  };
  return {
    source,
    get protocolRepository() { return observedProtocolRepository; },
    async inheritedSource(row: MembershipValue): Promise<FormationSourcePin | undefined> {
      const located = await locateSource(row.createCwd);
      observedProtocolRepository = located.repository;
      return located.inherited ? { repository: located.repository, gitCommonDir: deps.repo.gitCommonDir,
        head: await head(located.repository), configuration: located.configuration } : undefined;
    },
    async verifySource(row: MembershipValue, pin: FormationSourcePin) {
      if (canonicalSha256(await source(row)) !== canonicalSha256(pin)) {
        throw new FormationPlacementError("ROUTE_DRIFT", "inherited formation source/configuration changed");
      }
    },
    async assertCaller(row: MembershipValue) { await common(directory(row.createCwd)); },
    async verifyCaller(row: MembershipValue) {
      if (row.workspaceId === null) throw new FormationPlacementError("CAPABILITY_GAP", "caller requires its exact bound workspace");
      const cwd = directory(row.createCwd); await common(cwd);
      await liveDirectory(row.workspaceId, cwd, canonicalSha256([row.agentId, row.workspaceId, "caller-read"]));
      // No HEAD/config lease is introduced for historical omitted-placement
      // calls, including orientation in an unborn repository. No extra phase.
    },
    async resolve(row: MembershipValue, input: DeskSeatCreateInputValue, phase: Phase, guard: Guard): Promise<FormationTargetPin> {
      const placement = input.placement;
      if (!placement || placement.kind === "worktree") throw new FormationPlacementError("CAPABILITY_GAP", "only caller/existing placement can be resolved");
      if (placement.kind === "caller" && row.workspaceId === null) throw new FormationPlacementError("CAPABILITY_GAP", "caller placement requires its exact bound workspace");
      const foreign = await placementRepository(row, input, canonicalSha256([row.agentId, input.requestId, "repository-read"]));
      const repo = foreign?.repo ?? deps.repo.gitCommonDir;
      const freshSource = () => foreign ? sourceAt(foreign.start, repo) : source(row);
      const sourcePin = await freshSource();
      phase("placement-planned", { source: sourcePin, placement });
      const key = canonicalSha256([sourcePin.gitCommonDir, row.agentId, input.requestId, "workspace-open"]);
      let workspaceId = placement.kind === "caller" ? row.workspaceId : placement.workspaceId;
      const wanted = placement.kind === "caller" ? directory(row.createCwd) : placement.cwd === undefined ? null : directory(placement.cwd);
      let wantedHead: string | null = null;
      if (wanted !== null) { await common(wanted, repo); wantedHead = await head(wanted); await checkConfiguration(sourcePin, wanted); }
      if (workspaceId == null) {
        if (wanted === null) throw new FormationPlacementError("CAPABILITY_GAP", "placement has no workspace or cwd");
        const api = deps.host();
        if (!api || typeof api.workspaces?.open !== "function") throw new FormationPlacementError("CAPABILITY_GAP", "host lacks workspace open");
        const refused = await guard(); if (refused !== null) throw new FormationPlacementError(refused.code, refused.message);
        // Parent verification awaited the SDK; re-read the qualified Git
        // inputs before issuing open, without treating discovery as a lease.
        await common(wanted, repo);
        if (await head(wanted) !== wantedHead || canonicalSha256(await freshSource()) !== canonicalSha256(sourcePin)) {
          throw new FormationPlacementError("ROUTE_DRIFT", "placement changed before workspace open");
        }
        await checkConfiguration(sourcePin, wanted);
        phase("workspace-open-issued", { cwd: wanted, head: wantedHead, gitCommonDir: sourcePin.gitCommonDir, correlationKey: key });
        try { handle = await wait(true, "workspace.open", () => api.workspaces.open({ cwd: wanted, requestId: key })); }
        catch { throw new FormationPlacementUncertain(null, wanted, key); }
        if (typeof handle?.id !== "string" || !handle.id) throw new FormationPlacementUncertain(null, wanted, key);
        workspaceId = handle.id;
        phase("workspace-open-returned", { workspaceId });
      }
      const observed = await observe(workspaceId, wanted, key, repo);
      if (wantedHead !== null && observed.head !== wantedHead) throw new FormationPlacementError("ROUTE_DRIFT", "target HEAD changed during workspace resolution", workspaceId);
      await checkConfiguration(sourcePin, observed.cwd);
      const target: FormationTargetPin = { workspaceId, ...observed, gitCommonDir: repo,
        source: sourcePin, reason: placement.kind === "existing" ? placement.reason : null };
      await this.verify(row, target);
      phase("target-observed", target);
      return target;
    },
    async verify(row: MembershipValue, pin: FormationTargetPin) {
      const now = await pinnedSource(row, pin);
      if (canonicalSha256(now) !== canonicalSha256(pin.source)) throw new FormationPlacementError("ROUTE_DRIFT", "placement source/configuration changed", pin.workspaceId);
      const observed = await observe(pin.workspaceId, pin.cwd, canonicalSha256([row.agentId, pin.workspaceId, "workspace-read"]), pin.gitCommonDir);
      if (observed.head !== pin.head || pin.source.gitCommonDir !== pin.gitCommonDir) throw new FormationPlacementError("ROUTE_DRIFT", "target Git HEAD/repository changed", pin.workspaceId);
      await checkConfiguration(pin.source, observed.cwd);
      // Registrations may change while formation awaits; recheck before every
      // cross-repository effect and delivery. Same-repository pins skip this.
      if (pin.gitCommonDir !== deps.repo.gitCommonDir) await assertSeparate(row.createCwd, observed.cwd, "ROUTE_DRIFT", pin.workspaceId);
    },
    async create(pin: Pick<FormationTargetPin, "workspaceId">, options: TaskWorkspaceCreateOptions) {
      if (!handle || handle.id !== pin.workspaceId) throw new FormationPlacementError("CAPABILITY_GAP", "qualified workspace handle unavailable", pin.workspaceId);
      // Use the same refreshed SDK handle, avoiding an implicit fresh handle
      // lookup whose directory was never qualified. No atomic host/Git fence.
      return wait(true, "workspace.agent.create", () => handle!.agents.create(options));
    },
  };
}
