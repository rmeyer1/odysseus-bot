import fs from 'node:fs';
import path from 'node:path';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CONFIG_PATH = path.resolve(process.cwd(), 'mcp.json');
let activeClients = []; // Store all connected clients

// Helper to replace ${VAR} with actual env values
function expandEnv(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{(.+?)\}/g, (_, v) => process.env[v] || '');
}

/**
 * 🧹 SANITIZER: Recursively removes fields that Gemini hates ($schema, additionalProperties)
 */
function cleanGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  // 1. Create a shallow copy so we don't mutate the original
  const clean = Array.isArray(schema) ? [...schema] : { ...schema };

  // 2. Remove forbidden keys
  delete clean.additionalProperties;
  delete clean.$schema;
  
  // 3. Recurse into known nested schema structures
  if (clean.properties) {
    for (const key in clean.properties) {
      clean.properties[key] = cleanGeminiSchema(clean.properties[key]);
    }
  }
  if (clean.items) {
    clean.items = cleanGeminiSchema(clean.items);
  }
  // Handle array-based combinators (anyOf, allOf, oneOf)
  ['anyOf', 'allOf', 'oneOf'].forEach(combinator => {
    if (clean[combinator] && Array.isArray(clean[combinator])) {
      clean[combinator] = clean[combinator].map(cleanGeminiSchema);
    }
  });

  return clean;
}

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
      // 1. Prepare Environment Variables
      const envVars = { ...process.env };
      if (settings.env) {
        for (const [k, v] of Object.entries(settings.env)) {
          envVars[k] = expandEnv(v);
        }
      }

      // 2. Setup Transport
      const transport = new StdioClientTransport({
        command: settings.command,
        args: settings.args || [],
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

  for (const { name, client } of activeClients) {
    try {
      const list = await client.listTools();
      const tools = list.tools.map(t => {
        // --- APPLY THE FIX HERE ---
        const sanitizedSchema = cleanGeminiSchema(t.inputSchema); 

        return {
          ...t,
          inputSchema: sanitizedSchema, // Use the clean version
          originalName: t.name, // Keep track of real name for execution
          name: `${name}_${t.name}`.replace(/-/g, '_'), // Sanitized for Gemini
          _client: client // Hidden reference to the client that owns this tool
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
  const tools = await getAllMcpTools();
  const toolDef = tools.find(t => t.name === geminiToolName);

  if (!toolDef) throw new Error(`Tool ${geminiToolName} not found.`);

  const result = await toolDef._client.callTool({
    name: toolDef.originalName,
    arguments: args
  });

  return result.content.map(c => c.text).join('\n');
}