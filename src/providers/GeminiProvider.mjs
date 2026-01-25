import fs from "node:fs";
import BaseProvider from "./BaseProvider.mjs";
import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.mjs";
import { nowIso, sleep } from "../utils/common.mjs";
import { getCodexSystemPrompt } from "../commands/codex.mjs";
import { executeMcpTool, getAllMcpTools, startMcpServers } from "../services/mcp-manager.mjs";

const SYSTEM_PROMPT = getCodexSystemPrompt();
const MAX_TOOL_LOOPS = 5; // Increased slightly for complex GitHub chains

function shouldUseSearch(prompt) {
  const p = String(prompt || "").toLowerCase();
  return /\b(latest|current|today|yesterday|news|release|version|pricing|price|score|winner|who won|documentation|docs|search|lookup|find)\b/i.test(
    p
  );
}

function extractSources(response) {
  const sources = new Set();
  const candidates = response?.candidates || [];
  for (const cand of candidates) {
    const chunks = cand?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) {
      const uri = chunk?.web?.uri || chunk?.retrievedContext?.uri || chunk?.web?.url;
      if (uri) sources.add(uri);
    }
  }
  return Array.from(sources);
}

function extractFunctionCalls(response) {
  const candidates = response?.candidates || [];
  const parts = candidates[0]?.content?.parts || [];
  const calls = [];
  for (const part of parts) {
    if (part?.functionCall?.name) {
      calls.push({
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      });
    }
  }
  return calls;
}

export default class GeminiProvider extends BaseProvider {
  constructor() {
    super();
    this.aborted = new Set();
  }

  async execute(job, context) {
    if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

    const { workdir, logPath } = context;

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    await startMcpServers();
    const mcpToolsRaw = await getAllMcpTools();
    
    // We map the tools here. 
    // Note: ensure your mcp-manager.mjs handles the schema sanitization (stripping $schema)
    const mcpToolDecls = mcpToolsRaw.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));

    const useSearch = shouldUseSearch(job.prompt);

    const tools = [];
    if (useSearch) tools.push({ googleSearch: {} });
    if (mcpToolDecls.length) tools.push({ functionDeclarations: mcpToolDecls });

    // Use the requested model, falling back to config
    const modelName = process.env.GEMINI_MODEL || GEMINI_MODEL || "gemini-1.5-pro";

    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPT }],
      },
      tools: tools.length ? tools : undefined,
    });

    const outStream = fs.createWriteStream(logPath, { flags: "a" });
    outStream.write(
      `== job ${job.id} ==\nstarted: ${nowIso()}\nprovider: gemini\nmodel: ${modelName}\nworkdir: ${workdir}\n\n`
    );

    let combinedTail = "";
    const tailLimit = 14000;

    const appendText = (text) => {
      if (!text) return;
      outStream.write(text);
      combinedTail += text;
      if (combinedTail.length > tailLimit) {
        combinedTail = combinedTail.slice(combinedTail.length - tailLimit);
      }
    };

    let contents = [{ role: "user", parts: [{ text: job.prompt }] }];
    let response = null;

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      // 1. Generate content
      const result = await model.generateContent({ contents, tools: tools.length ? tools : undefined });
      response = result?.response || result;
      if (this.aborted.has(job.id)) break;

      // 2. Check for tool calls
      const calls = extractFunctionCalls(response);
      if (!calls.length) break; // No tools called, we are done

      // 3. Log calls
      calls.forEach(c => console.log(`🛠️ Gemini calling tool: ${c.name}`));

      // 4. Add model's request to history
      contents = contents.concat([
        {
          role: "model",
          parts: calls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
        },
      ]);

      // 5. Execute tools and format responses
      const functionResponses = [];
      for (const call of calls) {
        try {
          // Execute via MCP Manager
          const rawString = await executeMcpTool(call.name, call.args);
          
          // --- FIX START: JSON PARSING ---
          // Gemini needs a structured Object (Struct), not a JSON string.
          let structuredResponse = { result: rawString };

          try {
            const trimmed = String(rawString).trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                 const parsed = JSON.parse(trimmed);
                 structuredResponse = { result: parsed };
            }
          } catch (e) {
            // parsing failed, use raw string
          }
          // --- FIX END ---

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: structuredResponse,
            },
          });
        } catch (err) {
          console.error(`Tool error (${call.name}):`, err);
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { isError: true, error: String(err?.message || err) },
            },
          });
        }
      }

      // 6. Add tool results to history
      contents = contents.concat([
        {
          role: "function",
          parts: functionResponses,
        },
      ]);
    }

    if (this.aborted.has(job.id)) {
      outStream.write(`\n\n[bot] job aborted\n`);
      outStream.end();
      this.aborted.delete(job.id);
      return {
        combinedTail,
        exitInfo: { code: 130, signal: "aborted" },
        model: modelName,
        provider: "gemini",
      };
    }

    const text = response?.text?.() || "";
    appendText(text);

    const sources = extractSources(response);
    if (sources.length) {
      const list = sources.map((s) => `- ${s}`).join("\n");
      appendText(`\n\nSources:\n${list}\n`);
    }

    outStream.write(`\n\nended: ${nowIso()}\nexit: ${JSON.stringify({ code: 0, signal: null })}\n`);
    outStream.end();

    return {
      combinedTail,
      exitInfo: { code: 0, signal: null },
      model: modelName,
      provider: "gemini",
    };
  }

  async abort(job) {
    this.aborted.add(job.id);
    await sleep(50);
    return true;
  }
}