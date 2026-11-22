# Supervisor forms a Lead in a registered Git submodule

- Status: Proposed
- Date: 2026-11-22
- Decided by: Supervisor on behalf of Human (pending independent review)
- Source: Cross-repository placement amendment for superproject workspaces with registered submodules
- Supersedes: none

## Context

`2026-10-13-supervisor-forms-cross-repo-lead.md` allowed a Supervisor to form a
Lead in a separate repository only when no checkouts of the two repositories
overlap. A Git submodule always lives inside its superproject checkout, so a
Supervisor in a superproject could not form a Lead into its registered
submodules or their linked worktrees.

## Decision

Extend Supervisor + Lead + `existing` placement to accept overlapping checkouts
when every overlap is a registered Git submodule inside a caller checkout,
verified canonically and fail-closed: non-symlink path, stage-0 `160000`
gitlink in both `HEAD` and index, matching unique `submodule.<name>.path` in
both `HEAD:.gitmodules` and the regular-file `.gitmodules`, and a regular `.git`
gitdir file resolving to `<parent-git-dir>/modules/<name>`. Linked worktrees of
that submodule inherit the submodule's main checkout via `core.worktree`. The
Lead registers in the submodule's own desk; all other nested repositories,
upward placements, spoofed/deregistered submodules, non-Supervisor callers,
Peer children, and task access remain rejected.

## Consequences

The plugin still owns this invariant and re-verifies submodule registration on
every pinned pre-create and pre-delivery check (`ROUTE_DRIFT` on deregistration).
Submodule layouts without separated `<parent-git-dir>/modules/<name>` gitdirs
(legacy embedded `.git` directories) remain rejected by design to prevent fake
`.git` spoofing; revisit only if legacy embedded submodules become a real
requirement.
