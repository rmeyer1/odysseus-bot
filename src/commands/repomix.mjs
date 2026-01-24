import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  JOB_LOGS_DIR,
  REPOMIX_BIN,
  REPOMIX_DEFAULT_STYLE,
  REPOMIX_TIMEOUT_MS,
} from "../config.mjs";
import { gzipFile, safeBaseName } from "../utils/common.mjs";

function normalizeRepomixStyle(style) {
  const s = String(style || "").toLowerCase();
  if (["xml", "markdown", "json", "plain"].includes(s)) return s;
  return "xml";
}

function extForStyle(style) {
  switch (style) {
    case "markdown":
      return "md";
    case "json":
      return "json";
    case "plain":
      return "txt";
    case "xml":
    default:
      return "xml";
  }
}

/**
 * /repomix [style] [flags...]
 *
 * Supported shorthand:
 *  - style as first token: xml|markdown|json|plain
 *  - flags: diffs, logs, compress, parsable, linenumbers
 *
 * Example:
 *  /repomix markdown diffs logs
 */
export function createRepomixCommand({ sendMessageSafe, sendDocumentSafe }) {
  return async function runRepomixCommand(chatId, rawArgs, workdir) {
    const tokens = (rawArgs || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    let style = normalizeRepomixStyle(REPOMIX_DEFAULT_STYLE);

    if (tokens.length && ["xml", "markdown", "json", "plain"].includes(tokens[0].toLowerCase())) {
      style = normalizeRepomixStyle(tokens.shift());
    }

    const flags = new Set(tokens.map((t) => t.toLowerCase()));

    const outName =
      `repomix-${new Date().toISOString().replace(/[:.]/g, "-")}-${safeBaseName(style)}.` +
      extForStyle(style);
    const outPath = path.join(JOB_LOGS_DIR, outName);

    const args = ["-o", outPath, "--style", style, "--quiet"];

    if (flags.has("diffs")) args.push("--include-diffs");
    if (flags.has("logs")) args.push("--include-logs");
    if (flags.has("compress")) args.push("--compress");
    if (flags.has("parsable")) args.push("--parsable-style");
    if (flags.has("linenumbers")) args.push("--output-show-line-numbers");

    await sendMessageSafe(
      chatId,
      `📦 Running repomix in:\n${workdir}\n\nStyle: ${style}\nOutput: ${path.basename(outPath)}`
    );

    // Run repomix (writes output to file)
    await new Promise((resolve, reject) => {
      execFile(
        REPOMIX_BIN,
        args,
        {
          cwd: workdir,
          timeout: REPOMIX_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024, // logs only; actual output is written to file
          env: process.env,
        },
        (err, stdout, stderr) => {
          if (err) {
            const msg = String((stderr || stdout || err.message || err) ?? "").trim();
            return reject(new Error(msg || "repomix failed"));
          }
          resolve();
        }
      );
    });

    if (!fs.existsSync(outPath)) {
      throw new Error(`repomix finished but output file was not found: ${outPath}`);
    }

    const stat = fs.statSync(outPath);
    const sizeMb = stat.size / (1024 * 1024);

    // Conservative threshold; Telegram limits vary by bot/API and client.
    // If it's big, gzip it first.
    if (sizeMb > 45) {
      const gzPath = `${outPath}.gz`;
      await sendMessageSafe(chatId, `📉 Output is ${sizeMb.toFixed(1)} MB — gzipping before sending…`);
      await gzipFile(outPath, gzPath);
      const gzStat = fs.statSync(gzPath);
      await sendDocumentSafe(
        chatId,
        gzPath,
        `repomix (${style}) — gzipped\nOriginal: ${sizeMb.toFixed(1)} MB\nGzip: ${(
          gzStat.size /
          (1024 * 1024)
        ).toFixed(1)} MB`
      );
      return;
    }

    await sendDocumentSafe(chatId, outPath, `repomix (${style}) — ${sizeMb.toFixed(1)} MB`);
  };
}
