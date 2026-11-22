#!/usr/bin/env node
// Plugin-managed Cursor seats use `cursor-agent acp` over stdio, with role
// bytes on every prompt. Only the ACP session and the bare version probe run.
import { fileURLToPath } from 'node:url';
import { runRoleProcess } from '../plugin/server/runtime/cli/role-process.ts';
import { roleDelivery } from '../plugin/server/runtime/cli/role-bundle.ts';
import { verifyInstall } from '../plugin/server/runtime/cli/package.ts';
import { acpRolePrompt } from '../plugin/server/runtime/cli/role-transport.ts';

const [role, ...args] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  verifyInstall(root);
  const delivery = roleDelivery(root, role);
  const command = args.length ? args : ['acp'];
  const versionProbe = command.length === 1 && command[0] === '--version';
  if (!versionProbe && !(command.length === 1 && command[0] === 'acp')) {
    throw new Error('SLP Cursor supports only `cursor-agent acp` over stdio and the --version probe');
  }
  const seen = new Set();
  await runRoleProcess(process.env.SLP_CURSOR_BIN || 'cursor-agent', command, {
    protocol: !versionProbe,
    preserveUnchanged: true,
    transform: message => acpRolePrompt(message, delivery, seen),
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
