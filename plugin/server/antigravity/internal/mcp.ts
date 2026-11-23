import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { MCP_CHILD, MCP_ENV } from "./mcp-child.ts";
import { AntigravityError } from "./wire.ts";

const AGENT_TOOLS = [
  "read_file", "write_file", "edit_file", "run_command",
  "manage_task", "search_web", "schedule", "send_message",
  "invoke_subagent", "define_subagent", "manage_subagents", "ask_question",
] as const;

// Electron binaries (e.g. Paseo Helper) reject --eval unless ELECTRON_RUN_AS_NODE=1 is set.
function relayEnv(electron: boolean): Record<string, string> | undefined {
  return electron ? { ELECTRON_RUN_AS_NODE: "1" } : undefined;
}

export function mcpMapping(config: ProviderSessionConfig, namespace: string): Record<string, string> {
  return Object.fromEntries(Object.keys(config.mcpServers).sort().map((name, index) => [name, `slp-${namespace}-${index}`]));
}

export function mcpBinding(config: ProviderSessionConfig, namespace = "", electron = Boolean(process.versions.electron)): string {
  const names = Object.keys(config.mcpServers).sort();
  const env = relayEnv(electron);
  return createHash("sha256").update(JSON.stringify(names.length ? [mcpMapping(config, namespace), process.execPath, MCP_CHILD, ...(env ? [env] : [])] : [])).digest("hex");
}

export function mcpEnvironment(config: ProviderSessionConfig): Record<string, string> {
  for (const server of Object.values(config.mcpServers)) {
    if (server.type === "sse") throw new AntigravityError("Antigravity SLP supports stdio and Streamable HTTP MCP; legacy SSE is unsupported", "UNSUPPORTED_MCP_TRANSPORT");
  }
  const bundle = JSON.stringify({ cwd: config.cwd, servers: config.mcpServers });
  if (Buffer.byteLength(bundle) > 64 * 1024) throw new AntigravityError("Antigravity session MCP configuration exceeds 64 KiB", "MCP_CONFIG_TOO_LARGE");
  return { [MCP_ENV]: bundle };
}

/** Native conversations cache MCP declarations. Keep those declarations free
 * of per-open credentials; their inline child reads the current environment.
 * The namespace, server-name set and relay ABI must remain stable across resume. */
export class McpFiles {
  private root: string | null = null;
  private name = `slp-${randomUUID()}`;

  private readonly namespace: string;
  private readonly electron: boolean;
  constructor(namespace = randomUUID().replaceAll("-", ""), electron = Boolean(process.versions.electron)) {
    this.namespace = namespace;
    this.electron = electron;
  }

  async open(config: ProviderSessionConfig): Promise<{ directory: string; name: string } | null> {
    if (Object.keys(config.mcpServers).length === 0) return null;
    if (this.root === null) {
      this.root = await mkdtemp(join(tmpdir(), "paseo-slp-antigravity-"));
      try {
        await chmod(this.root, 0o700);
        const directory = join(this.root, ".agents", "agents");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const env = relayEnv(this.electron);
        const metadata = {
          name: this.name, description: "Paseo SLP session MCP transport", mainAgent: true, subagent: false,
          tools: AGENT_TOOLS,
          mcpServers: Object.entries(mcpMapping(config, this.namespace)).map(([logical, name]) => ({
            name, command: process.execPath, args: ["--eval", MCP_CHILD, logical], ...(env ? { env } : {}),
          })),
        };
        // JSON is valid YAML; values cannot escape the frontmatter carrier.
        const body = `---\n${JSON.stringify(metadata)}\n---\n# System Prompt\nFollow the current role instructions supplied with each user prompt.\n`;
        await writeFile(join(directory, `${this.name}.md`), body, { flag: "wx", mode: 0o600 });
      } catch (error) { await this.close(); throw error; }
    }
    return { directory: this.root, name: this.name };
  }

  async close(): Promise<void> {
    if (this.root !== null) { await rm(this.root, { recursive: true, force: true }); this.root = null; }
  }
}
