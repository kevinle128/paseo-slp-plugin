# Cursor support

SLP recognizes Cursor for saved role routing and Peer pool choices. The manager
plugin generates `slp-cursor-supervisor`, `slp-cursor-lead` and
`slp-cursor-peer` with `extends: cursor`. Each entry runs the launch-set
launcher, which enters the package's `bin/cursor-role.mjs` wrapper and starts
`cursor-agent acp` over stdio. Install and sign in to the Cursor CLI separately.

## Host requirement

`extends: cursor` selects the host's Cursor ACP client, which keeps the Cursor
model catalog (`cursor/list_available_models`), fast mode and the wait for
initial slash commands. The client runs the override `command`, so the role
wrapper stays in the path. A stock Paseo host accepts only
`claude, codex, copilot, opencode, pi, omp, acp` as `extends` and refuses the
whole provider map when one entry names another value. This build therefore
needs a Paseo host that accepts `extends: cursor`, such as the
`kevinle128/paseo` fork. Deploy that host before you activate this plugin build:
activation always writes the three Cursor entries, disabled when no
`cursor-agent` is found.

The plugin's own config validator follows the pinned host schema, with one
addition: it accepts `extends: cursor` only on the three owned Cursor IDs and
checks them under the `acp` label and command rules. Any other provider with
`extends: cursor`, and any other unknown base, still fails with `SCHEMA_LOSS`.

The standalone installer does not publish Cursor entries, so standalone
installs keep working on stock hosts.

## Executable

Resolution looks for `cursor-agent` on the daemon's `PATH`; an explicit
`binaries.cursor` selects another executable. A PATH alias is kept as the
stable path, so a CLI update that moves the alias target is followed. There is
no version gate: the probe records the first line of `cursor-agent --version`
(for example `2026.11.22-e9042b2`).

## Role delivery

The wrapper accepts only `acp` (also the default with no arguments) and a bare
`--version`. Other subcommands, including interactive and print modes, fail
before `cursor-agent` starts. The version probe passes stdout, stderr and the
exit status through without a session.

The shared ACP transform prepends role core, recovery and language
instructions to every `session/prompt`. First prompts and prompts re-armed by
`session/load`, `session/resume` or `session/fork` also carry the entry helpers
and policy locators. Other frames keep their original bytes. `agent.create`
keeps the config intact and adds only the desk handle; Cursor seats need no
session-open grant.

A live provider entry must state `extends: cursor`. A missing or different
value is refused at launch planning; desk formation reads the live config
around a fresh snapshot to supply a value the snapshot omits.

## Evidence limits

Local tests prove the wrapper bytes, the argv allowlist, provider generation
and history compatibility. The host routing of `extends: cursor`, MCP child-env
delivery, model-side role delivery and Cursor timeline shapes for supervision
capture are not proven; the supervision observer reports Cursor handbacks and
sends as unverified.
