import fs from 'node:fs';
import path from 'node:path';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CONFIG_PATH = path.resolve(process.cwd(), 'mcp.json');
let activeClients = []; // Store all connected clients

// Helper to replace ${VAR} with actual env values
function expandEnv(value) {
  if (Array.isArray(value)) return value.map((item) => expandEnv(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  if (typeof value === 'string') {
    return value.replace(/\$\{(.+?)\}/g, (_m, v) => process.env[v] || '');
  }
  return value;
}

/**
 * 🧹 SANITIZER: Allow-list only Gemini-compatible schema fields.
 */
function cleanGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};

  if (schema.type) out.type = schema.type;
  if (schema.format) out.format = schema.format;
  if (schema.description) out.description = schema.description;
  if (schema.nullable) out.nullable = schema.nullable;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const key of Object.keys(schema.properties)) {
      out.properties[key] = cleanGeminiSchema(schema.properties[key]);
    }
  }

  if (schema.items) out.items = cleanGeminiSchema(schema.items);

  return out;
}

const toolRegistry = new Map();

export async function loadMcpConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

export async function startMcpServers() {
  if (activeClients.length > 0) return activeClients;

  const config = await loadMcpConfig();
  console.log(`🔌 Found ${Object.keys(config).length} MCP servers in config.`);

  for (const [serverName, settings] of Object.entries(config)) {
    try {
      const expandedSettings = expandEnv(settings);
      // 1. Prepare Environment Variables
      const envVars = { ...process.env, ...(expandedSettings.env || {}) };

      // 2. Setup Transport
      const transport = new StdioClientTransport({
        command: expandedSettings.command,
        args: expandedSettings.args || [],
        env: envVars
      });

      // 3. Connect Client
      const client = new Client(
        { name: "codex-bot", version: "1.0.0" },
        { capabilities: { sampling: {} } }
      );

      await client.connect(transport);
      console.log(`✅ MCP Server '${serverName}' connected.`);
      
      activeClients.push({ name: serverName, client });
    } catch (e) {
      console.error(`❌ Failed to start MCP server '${serverName}':`, e.message);
    }
  }

  return activeClients;
}

// Get all tools from ALL connected servers combined
export async function getAllMcpTools() {
  await startMcpServers();
  let allTools = [];
  toolRegistry.clear();

  for (const { name, client } of activeClients) {
    try {
      const list = await client.listTools();
      const tools = list.tools.map(t => {
        const sanitizedSchema = cleanGeminiSchema(t.inputSchema);
        const geminiName = `${name}_${t.name}`.replace(/-/g, '_');

        toolRegistry.set(geminiName, { client, toolName: t.name });

        return {
          name: geminiName,
          description: t.description || '',
          inputSchema: sanitizedSchema
        };
      });
      allTools.push(...tools);
    } catch (e) {
      console.error(`⚠️ Could not list tools for ${name}:`, e.message);
    }
  }
  return allTools;
}

// Execute a tool by finding the right client
export async function executeMcpTool(geminiToolName, args) {
  if (!toolRegistry.size) await getAllMcpTools();
  const entry = toolRegistry.get(geminiToolName);

  if (!entry) throw new Error(`Tool ${geminiToolName} not found.`);

  const result = await entry.client.callTool({
    name: entry.toolName,
    arguments: args
  });

  return result.content.map(c => c.text).join('\n');
}
