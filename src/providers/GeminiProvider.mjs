import fs from "node:fs";
import BaseProvider from "./BaseProvider.mjs";
import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.mjs";
import { nowIso, sleep } from "../utils/common.mjs";
import { getCodexSystemPrompt } from "../commands/codex.mjs";

const SYSTEM_PROMPT = getCodexSystemPrompt();

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

    const useSearch = shouldUseSearch(job.prompt);

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPT }],
      },
      tools: useSearch ? [{ googleSearch: {} }] : undefined,
    });

    const outStream = fs.createWriteStream(logPath, { flags: "a" });
    outStream.write(
      `== job ${job.id} ==\nstarted: ${nowIso()}\nprovider: gemini\nmodel: ${GEMINI_MODEL}\nworkdir: ${workdir}\n\n`
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

    let response = null;
    let hadChunks = false;

    if (typeof model.generateContentStream === "function") {
      const streamResult = await model.generateContentStream(job.prompt);
      for await (const chunk of streamResult.stream) {
        if (this.aborted.has(job.id)) break;
        const text = chunk.text();
        if (text) {
          hadChunks = true;
          appendText(text);
        }
      }
      response = await streamResult.response;
    } else {
      const result = await model.generateContent(job.prompt);
      response = result?.response || result;
    }

    if (this.aborted.has(job.id)) {
      outStream.write(`\n\n[bot] job aborted\n`);
      outStream.end();
      this.aborted.delete(job.id);
      return {
        combinedTail,
        exitInfo: { code: 130, signal: "aborted" },
        model: GEMINI_MODEL,
        provider: "gemini",
      };
    }

    if (!hadChunks) {
      const text = response?.text?.() || "";
      appendText(text);
    }

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
      model: GEMINI_MODEL,
      provider: "gemini",
    };
  }

  async abort(job) {
    this.aborted.add(job.id);
    await sleep(50);
    return true;
  }
}
