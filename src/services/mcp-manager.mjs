import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

const MCP_CONFIG_PATH = path.join(process.cwd(), "mcp.json");

let started = false;
const servers = new Map();
const toolAliasMap = new Map();
const toolDecls = [];

function substituteEnvVars(input) {
  if (Array.isArray(input)) return input.map((v) => substituteEnvVars(v));
  if (input && typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = substituteEnvVars(v);
    return out;
  }
  if (typeof input === "string") {
    return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
  }
  return input;
}

function safeToolName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function addTool(serverName, tool) {
  const base = safeToolName(`${serverName}_${tool.name}`);
  let alias = base || safeToolName(tool.name) || "tool";
  let i = 2;
  while (toolAliasMap.has(alias)) {
    alias = `${base}_${i++}`;
  }

  toolAliasMap.set(alias, { serverName, toolName: tool.name });

  const parameters = tool.inputSchema || { type: "object" };

  toolDecls.push({
    name: alias,
    description: tool.description ? `[${serverName}] ${tool.description}` : `[${serverName}]`,
    parameters,
  });
}

export function loadMcpConfig() {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return null;
  const raw = fs.readFileSync(MCP_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") return parsed.mcpServers;
  return parsed;
}

export async function startMcpServers() {
  if (started) return;
  started = true;

  const config = loadMcpConfig();
  if (!config || typeof config !== "object" || !Object.keys(config).length) return;

  console.log("🔌 Found MCP servers in config.");

  const entries = Object.entries(config);
  for (const [name, cfg] of entries) {
    if (!cfg?.command) continue;

    const resolved = substituteEnvVars(cfg);
    const transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args || [],
      env: resolved.env ? { ...process.env, ...resolved.env } : process.env,
    });

    const client = new Client({ name: "odysseus-bot", version: "1.0.0" });
    await client.connect(transport);

    servers.set(name, { client });
  }

  await refreshTools();
}

async function refreshTools() {
  toolAliasMap.clear();
  toolDecls.length = 0;

  for (const [serverName, { client }] of servers.entries()) {
    try {
      const result = await client.request({ method: "tools/list" }, ListToolsResultSchema);
      const tools = result?.tools || [];
      for (const tool of tools) addTool(serverName, tool);
    } catch (e) {
      console.error(`[mcp] failed to list tools for ${serverName}:`, e?.message || e);
    }
  }
}

export async function getAllMcpTools() {
  await startMcpServers();
  return toolDecls.slice();
}

export async function executeMcpTool(alias, args) {
  const entry = toolAliasMap.get(alias);
  if (!entry) throw new Error(`Unknown MCP tool: ${alias}`);

  const server = servers.get(entry.serverName);
  if (!server) throw new Error(`MCP server not found: ${entry.serverName}`);

  const result = await server.client.request(
    {
      method: "tools/call",
      params: {
        name: entry.toolName,
        arguments: args || {},
      },
    },
    CallToolResultSchema
  );

  return {
    name: entry.toolName,
    isError: result?.isError || false,
    content: result?.content || [],
  };
}
