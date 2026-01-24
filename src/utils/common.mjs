import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { CODEX_TIMEOUT_MS } from "../config.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function genJobId() {
  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function getSystemMemInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    free,
    used,
    usedPct: total ? (used / total) * 100 : 0,
  };
}

export async function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: CODEX_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        const out = (stdout || "").toString();
        const errOut = (stderr || "").toString();
        if (err) return reject(new Error((errOut || out || err.message).trim()));
        resolve((out || errOut || "").trim());
      }
    );
  });
}

export function safeBaseName(s) {
  return (
    String(s || "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "output"
  );
}

export async function gzipFile(inPath, outPath) {
  await pipeline(fs.createReadStream(inPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(outPath));
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function parseTokensUsed(output) {
  const m = output.match(/tokens used[\s:]*\n?\s*([\d,]+)/i);
  if (m?.[1]) return Number(m[1].replace(/,/g, ""));
  return null;
}
