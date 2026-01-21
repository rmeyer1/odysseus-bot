/**
 * Resilient Coding Telegram Bot (Job-based, rate-limit safe, Pi-friendly)
 *
 * Updates in this version:
 *  - Removed /big: every /codex runs in "big-task mode" (makeBigTaskPrompt).
 *  - Forces latest Codex model (default: gpt-5.2-codex) for every codex exec run.
 *  - Adds /repomix command: generates an AI-friendly packed repo file and sends it back.
 *
 * NEW in this version:
 *  - Dynamic repo switching per chat:
 *      /setrepo <repo-name | /absolute/path>  -> sets current repo for this chat
 *      /repo                                  -> shows current repo path for this chat
 *      /repos                                 -> lists git repos under REPOS_BASE_DIR
 *  - Each queued job stores the repo workdir it should run in (no race with switching).
 *
 * Requires:
 *  - Node 18+
 *  - npm i node-telegram-bot-api
 *  - Codex CLI installed and working: codex --version
 *  - GitHub CLI installed if you want PR operations: gh --version
 *  - Repomix installed globally if you want /repomix: npm i -g repomix
 *
 * ENV (recommended):
 *  TELEGRAM_BOT_TOKEN=...
 *  ALLOWED_CHAT_ID=123456789        (lock bot to your chat)
 *  WORKDIR=/home/admin/Projects/work/covered-call-app   (default/fallback repo)
 *
 * Optional ENV:
 *  REPOS_BASE_DIR=/home/admin/Projects/work            (for /repos and /setrepo by name)
 *  CODEX_BIN=codex
 *  CODEX_MODEL=gpt-5.2-codex        (default: gpt-5.1-codex-max as provided here)
 *  CODEX_TIMEOUT_MS=3600000         (60 min)
 *  USE_UNSAFE_CODEX=1               (bypass sandbox approvals; needed on your Pi due to Landlock)
 *  TELEGRAM_SEND_DELAY_MS=900       (throttle sends)
 *  TELEGRAM_MAX_CHARS=3500
 *  HEARTBEAT_SEC=25
 *  JOBS_DIR=/home/admin/.codex-bot
 *  MAX_INLINE_OUTPUT_CHARS=12000    (above this, send as document)
 *  MEMORY_HIGH_MB=900               (auto compress trigger threshold)
 *
 * Repomix optional ENV:
 *  REPOMIX_BIN=repomix
 *  REPOMIX_TIMEOUT_MS=1800000       (30 min)
 *  REPOMIX_DEFAULT_STYLE=xml        (xml|markdown|json|plain)
 */

import TelegramBot from "node-telegram-bot-api";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID ? String(process.env.ALLOWED_CHAT_ID) : null;

const WORKDIR = process.env.WORKDIR; // default/fallback repo

const CODEX_BIN = process.env.CODEX_BIN || "codex";
// Force latest Codex model by default (overrideable)
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.1-codex-max";

const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 60 * 60 * 1000);
const USE_UNSAFE_CODEX = String(process.env.USE_UNSAFE_CODEX || "1") === "1";

const TELEGRAM_SEND_DELAY_MS = Number(process.env.TELEGRAM_SEND_DELAY_MS || 900);
const TELEGRAM_MAX_CHARS = Number(process.env.TELEGRAM_MAX_CHARS || 3500);
const HEARTBEAT_SEC = Number(process.env.HEARTBEAT_SEC || 25);

const JOBS_DIR = process.env.JOBS_DIR || path.join(os.homedir(), ".codex-bot");
const JOBS_DB_PATH = path.join(JOBS_DIR, "jobs.json");
const JOB_LOGS_DIR = path.join(JOBS_DIR, "logs");

const MAX_INLINE_OUTPUT_CHARS = Number(process.env.MAX_INLINE_OUTPUT_CHARS || 12000);
const MEMORY_HIGH_MB = Number(process.env.MEMORY_HIGH_MB || 900);

// Repomix
const REPOMIX_BIN = process.env.REPOMIX_BIN || "repomix";
const REPOMIX_TIMEOUT_MS = Number(process.env.REPOMIX_TIMEOUT_MS || 30 * 60 * 1000);
const REPOMIX_DEFAULT_STYLE = (process.env.REPOMIX_DEFAULT_STYLE || "xml").toLowerCase();

// Repo switching
const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || path.join(os.homedir(), "Projects", "work");
const CHAT_REPO_DB_PATH = path.join(JOBS_DIR, "chat-repos.json");

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
// Keep WORKDIR required as your safe default (backward compatible)
if (!WORKDIR) throw new Error("Missing WORKDIR");

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(JOB_LOGS_DIR, { recursive: true });

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ----------------------------- Utilities ----------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function genJobId() {
  return `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAllowed(msg) {
  if (!ALLOWED_CHAT_ID) return true;
  return String(msg?.chat?.id) === ALLOWED_CHAT_ID;
}

function chunkText(text, size = TELEGRAM_MAX_CHARS) {
  const s = text?.length ? text : "(no output)";
  const chunks = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function getSystemMemInfo() {
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

async function exec(cmd, args, opts = {}) {
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

function safeBaseName(s) {
  return (
    String(s || "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "output"
  );
}

async function gzipFile(inPath, outPath) {
  await pipeline(fs.createReadStream(inPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(outPath));
}

/**
 * Telegram send wrapper that:
 *  - throttles sends
 *  - handles 429 retry_after automatically
 *  - retries ECONNRESET-ish transient errors
 */
async function sendMessageSafe(chatId, text, opts = {}) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await sleep(TELEGRAM_SEND_DELAY_MS);

    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await bot.sendMessage(chatId, chunk, {
          disable_web_page_preview: true,
          ...opts,
        });
        break;
      } catch (e) {
        const body = e?.response?.body;
        const retryAfter = body?.parameters?.retry_after;

        if (retryAfter) {
          await sleep((Number(retryAfter) + 1) * 1000);
          continue;
        }

        const msg = String(e?.message || e);
        if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
          await sleep(1500 + attempt * 750);
          continue;
        }

        throw e;
      }
    }
  }
}

async function sendDocumentSafe(chatId, filePath, caption = "") {
  await sleep(TELEGRAM_SEND_DELAY_MS);

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await bot.sendDocument(chatId, filePath, {
        caption: caption ? caption.slice(0, 1024) : undefined,
      });
      return;
    } catch (e) {
      const body = e?.response?.body;
      const retryAfter = body?.parameters?.retry_after;

      if (retryAfter) {
        await sleep((Number(retryAfter) + 1) * 1000);
        continue;
      }

      const msg = String(e?.message || e);
      if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
        await sleep(1500 + attempt * 750);
        continue;
      }

      throw e;
    }
  }
}

/* ----------------------------- Repo Switching (per chat) ----------------------------- */

function loadChatRepos() {
  try {
    if (!fs.existsSync(CHAT_REPO_DB_PATH)) return { byChatId: {} };
    return JSON.parse(fs.readFileSync(CHAT_REPO_DB_PATH, "utf8")) || { byChatId: {} };
  } catch {
    return { byChatId: {} };
  }
}

function saveChatRepos(db) {
  fs.writeFileSync(CHAT_REPO_DB_PATH, JSON.stringify(db, null, 2));
}

function resolveRepoToWorkdir(repoToken) {
  const token = String(repoToken || "").trim();
  if (!token) return null;

  const candidates = [];

  // Allow absolute paths
  if (token.startsWith("/")) candidates.push(token);

  // Allow selecting by folder name under REPOS_BASE_DIR
  candidates.push(path.join(REPOS_BASE_DIR, token));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const gitDir = path.join(p, ".git");
        if (fs.existsSync(gitDir)) return p;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function getChatWorkdir(chatId) {
  const db = loadChatRepos();
  const entry = db.byChatId?.[String(chatId)];
  return entry?.workdir || WORKDIR;
}

function listReposUnderBaseDir() {
  const entries = fs
    .readdirSync(REPOS_BASE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(REPOS_BASE_DIR, name, ".git")))
    .sort();
  return entries;
}

/* ----------------------------- Job DB ----------------------------- */

function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_DB_PATH)) return { jobs: [] };
    const raw = fs.readFileSync(JOBS_DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.jobs) return { jobs: [] };
    return parsed;
  } catch {
    return { jobs: [] };
  }
}

function saveJobs(db) {
  fs.writeFileSync(JOBS_DB_PATH, JSON.stringify(db, null, 2));
}

function getJob(db, id) {
  return db.jobs.find((j) => j.id === id);
}

function upsertJob(db, job) {
  const idx = db.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) db.jobs[idx] = job;
  else db.jobs.push(job);
}

/* ----------------------------- Codex Runner ----------------------------- */

function buildCodexArgs(prompt, workdir) {
  const args = [];

  args.push("exec");

  // Force a known model for every invocation (unless overridden via env)
  args.push("--model", CODEX_MODEL);

  if (USE_UNSAFE_CODEX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write", "-a", "never");
  }

  args.push("-C", workdir);
  args.push(prompt);

  return args;
}

function makeBigTaskPrompt(userPrompt) {
  return [
    "You are operating in a local git repo. Follow these constraints:",
    "- Keep output concise. Do NOT paste large diffs into the chat output.",
    "- If you generate a diff, write it to a patch file instead (e.g. /tmp/changes.patch).",
    "- Use git commits and branches. Prefer small commits.",
    "- If asked to open a PR: use GitHub CLI (gh) to create it, and print the PR URL at the end.",
    "- Always finish with a short summary: files changed, commands run, what to verify next.",
    "",
    "User task:",
    userPrompt.trim(),
  ].join("\n");
}

function parseTokensUsed(output) {
  const m = output.match(/tokens used[\s:]*\n?\s*([\d,]+)/i);
  if (m?.[1]) return Number(m[1].replace(/,/g, ""));
  return null;
}

/* ----------------------------- Repomix Runner ----------------------------- */

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
async function runRepomixCommand(chatId, rawArgs, workdir) {
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
    `repomix-${new Date().toISOString().replace(/[:.]/g, "-")}-${safeBaseName(style)}.` + extForStyle(style);
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
}

/* ----------------------------- Job Queue / Worker ----------------------------- */

let workerRunning = false;

async function startWorkerLoop() {
  if (workerRunning) return;
  workerRunning = true;

  while (true) {
    try {
      const db = loadJobs();

      const next = db.jobs
        .filter((j) => j.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!next) {
        await sleep(750);
        continue;
      }

      next.status = "running";
      next.startedAt = nowIso();
      next.updatedAt = nowIso();
      next.pid = null;
      upsertJob(db, next);
      saveJobs(db);

      await runJob(next);
    } catch (e) {
      console.error("[worker] error:", e);
      await sleep(1500);
    }
  }
}

async function runJob(job) {
  const db = loadJobs();
  const j = getJob(db, job.id);
  if (!j) return;

  const chatId = j.chatId;
  const workdir = j.workdir || WORKDIR;

  const logPath = path.join(JOB_LOGS_DIR, `job-${j.id}.log.txt`);
  const metaPath = path.join(JOB_LOGS_DIR, `job-${j.id}.meta.json`);

  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        id: j.id,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        workdir,
        codexBin: CODEX_BIN,
        codexModel: CODEX_MODEL,
        unsafeBypass: USE_UNSAFE_CODEX,
        prompt: j.prompt,
      },
      null,
      2
    )
  );

  await sendMessageSafe(chatId, `🚀 Job ${j.id} started.\nWorking dir: ${workdir}\nModel: ${CODEX_MODEL}`);

  const fullPrompt = makeBigTaskPrompt(j.prompt);
  const args = buildCodexArgs(fullPrompt, workdir);

  const outStream = fs.createWriteStream(logPath, { flags: "a" });
  outStream.write(
    `== job ${j.id} ==\nstarted: ${nowIso()}\ncmd: ${CODEX_BIN} ${args
      .map((a) => JSON.stringify(a))
      .join(" ")}\n\n`
  );

  let finished = false;
  let lastHeartbeat = Date.now();

  function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  const cmdStr = [CODEX_BIN, ...args].map((a) => shellQuote(a)).join(" ");

  const child = spawn("bash", ["-lc", `script -qfc ${shellQuote(cmdStr)} /dev/null`], {
    cwd: workdir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  j.pid = child.pid;
  j.updatedAt = nowIso();
  upsertJob(db, j);
  saveJobs(db);

  const heartbeatTimer = setInterval(async () => {
    if (finished) return;
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_SEC * 1000) {
      lastHeartbeat = now;
      try {
        await sendMessageSafe(chatId, `⏳ Job ${j.id} still running…`);
      } catch {
        // ignore
      }
    }
  }, 1000);

  let combinedTail = "";
  const tailLimit = 14000;

  const onData = (data) => {
    const s = data.toString("utf8");
    outStream.write(s);

    combinedTail += s;
    if (combinedTail.length > tailLimit) {
      combinedTail = combinedTail.slice(combinedTail.length - tailLimit);
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const killTimer = setTimeout(() => {
    try {
      outStream.write(`\n\n[bot] timeout after ${CODEX_TIMEOUT_MS}ms; killing process.\n`);
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
  }, CODEX_TIMEOUT_MS);

  const exitInfo = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: 1, signal: "spawn_error", err }));
  });

  clearTimeout(killTimer);
  clearInterval(heartbeatTimer);
  finished = true;

  outStream.write(`\n\nended: ${nowIso()}\nexit: ${JSON.stringify(exitInfo)}\n`);
  outStream.end();

  const db2 = loadJobs();
  const j2 = getJob(db2, j.id);
  if (!j2) return;

  j2.finishedAt = nowIso();
  j2.updatedAt = nowIso();
  j2.exit = exitInfo;

  if (j2.status !== "canceled") {
    j2.status = exitInfo.code === 0 ? "succeeded" : "failed";
  }

  upsertJob(db2, j2);
  saveJobs(db2);

  const logText = fs.readFileSync(logPath, "utf8");
  const tokens = parseTokensUsed(logText);

  const captionLines = [
    `📄 Job ${j2.id} ${j2.status.toUpperCase()}`,
    `Model: ${CODEX_MODEL}`,
    tokens ? `Tokens used: ${tokens.toLocaleString()}` : null,
    exitInfo?.code === 0 ? "✅ Completed." : "❌ Completed with errors.",
  ].filter(Boolean);

  const tailSummary =
    `🧾 Job ${j2.id} ${j2.status.toUpperCase()}\n` +
    `Model: ${CODEX_MODEL}\n` +
    (tokens ? `Tokens used: ${tokens.toLocaleString()}\n` : "") +
    `Exit: code=${exitInfo.code} signal=${exitInfo.signal || "none"}\n\n` +
    `--- Output tail ---\n${combinedTail.trim() || "(no output)"}`;

  if (tailSummary.length <= MAX_INLINE_OUTPUT_CHARS) {
    await sendMessageSafe(chatId, tailSummary);
  } else {
    await sendMessageSafe(chatId, `🧾 Job ${j2.id} done. Output is large; sending log file…`);
  }

  if (logText.length > MAX_INLINE_OUTPUT_CHARS || j2.status !== "succeeded") {
    await sendDocumentSafe(chatId, logPath, captionLines.join("\n"));
  }

  const prUrlMatch = logText.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/g);
  if (prUrlMatch?.length) {
    const uniq = Array.from(new Set(prUrlMatch)).slice(-3);
    await sendMessageSafe(chatId, `🔗 PR link(s):\n${uniq.join("\n")}`);
  }
}

/* ----------------------------- Commands ----------------------------- */

bot.on("polling_error", (err) => {
  console.error("[polling_error]", err?.message || err);
});

bot.on("message", async (msg) => {
  try {
    if (!isAllowed(msg)) return;

    const chatId = msg.chat.id;

    const text = (msg.text || "").trim();
    if (!text) return;

    // Repo commands
    if (text === "/repo") {
      const wd = getChatWorkdir(chatId);
      return sendMessageSafe(chatId, `📌 Current repo:\n${wd}`);
    }

    if (text === "/repos") {
      try {
        const repos = listReposUnderBaseDir();
        if (!repos.length) {
          return sendMessageSafe(chatId, `No git repos found in:\n${REPOS_BASE_DIR}`);
        }
        return sendMessageSafe(chatId, `📂 Repos in ${REPOS_BASE_DIR}:\n` + repos.map((r) => `- ${r}`).join("\n"));
      } catch (e) {
        return sendMessageSafe(chatId, `❌ /repos failed:\n${String(e?.message || e)}`);
      }
    }

    if (text.startsWith("/setrepo")) {
      const token = text.replace("/setrepo", "").trim();
      if (!token) return sendMessageSafe(chatId, "Usage: /setrepo <repo-name | /absolute/path>");

      const wd = resolveRepoToWorkdir(token);
      if (!wd) {
        return sendMessageSafe(
          chatId,
          `❌ Repo not found or not a git repo.\nTried:\n- ${path.join(REPOS_BASE_DIR, token)}\n- ${token}`
        );
      }

      const db = loadChatRepos();
      db.byChatId[String(chatId)] = { repo: token, workdir: wd, updatedAt: nowIso() };
      saveChatRepos(db);

      return sendMessageSafe(chatId, `✅ Switched repo.\nWORKDIR:\n${wd}`);
    }

    if (text === "/start" || text === "/help") {
      const wd = getChatWorkdir(chatId);
      return sendMessageSafe(
        chatId,
        [
          "✅ CodeBot online (resilient mode).",
          "",
          "Repo:",
          "/repo                   - show current repo for this chat",
          "/repos                  - list git repos under REPOS_BASE_DIR",
          "/setrepo <name|path>    - set current repo for this chat",
          "",
          "Commands:",
          "/status                 - git status -sb (current repo)",
          "/diff                   - git diff (current repo)",
          "/pull                   - git pull (current repo)",
          "/codex <task>           - create job (big-task mode; runs in current repo at queue time)",
          "/repomix [style] [opts] - pack repo + send file (style: xml|markdown|json|plain; opts: diffs logs compress parsable linenumbers)",
          "/jobs                   - list recent jobs",
          "/job <id>               - show job status",
          "/last                   - show last job",
          "/cancel <id>            - cancel running job",
          "/mem                    - bot/system memory + optional auto-compress",
          "/compress               - run codex compress (or fallback summary job)",
          "",
          `Current repo: ${wd}`,
          `Default WORKDIR: ${WORKDIR}`,
          `REPOS_BASE_DIR: ${REPOS_BASE_DIR}`,
          `Codex model: ${CODEX_MODEL}`,
          `Unsafe sandbox bypass: ${USE_UNSAFE_CODEX ? "ON" : "OFF"}`,
        ].join("\n")
      );
    }

    // Git helpers (use per-chat repo)
    if (text === "/status") {
      const wd = getChatWorkdir(chatId);
      const out = await exec("git", ["status", "-sb"], { cwd: wd });
      return sendMessageSafe(chatId, out);
    }

    if (text === "/diff") {
      const wd = getChatWorkdir(chatId);
      const out = await exec("git", ["diff"], { cwd: wd });
      if (!out) return sendMessageSafe(chatId, "(no diff)");
      if (out.length > MAX_INLINE_OUTPUT_CHARS) {
        const p = path.join(JOB_LOGS_DIR, `diff-${Date.now()}.patch`);
        fs.writeFileSync(p, out);
        await sendMessageSafe(chatId, "Diff is large; sending as file…");
        return sendDocumentSafe(chatId, p, "git diff");
      }
      return sendMessageSafe(chatId, out);
    }

    if (text === "/pull") {
      const wd = getChatWorkdir(chatId);
      const out = await exec("git", ["pull"], { cwd: wd });
      return sendMessageSafe(chatId, out);
    }

    // Repomix (use per-chat repo)
    if (text === "/repomix" || text.startsWith("/repomix ")) {
      const rawArgs = text === "/repomix" ? "" : text.replace("/repomix", "");
      const wd = getChatWorkdir(chatId);
      try {
        await runRepomixCommand(chatId, rawArgs, wd);
      } catch (e) {
        return sendMessageSafe(chatId, `❌ repomix failed:\n${String(e?.message || e)}`);
      }
      return;
    }

    // Memory / compress
    if (text === "/mem") {
      const sys = getSystemMemInfo();
      let botMemMb = process.memoryUsage().rss / (1024 * 1024);
      try {
        const j = await exec("pm2", ["jlist"]);
        const arr = JSON.parse(j);
        const me = arr.find((p) => p?.pm2_env?.pm_exec_path?.includes("bot.mjs"));
        if (me?.monit?.memory) botMemMb = me.monit.memory / (1024 * 1024);
      } catch {}

      const report =
        `🧠 Memory\n` +
        `Bot RSS: ${botMemMb.toFixed(1)} MB\n` +
        `System used: ${formatBytes(sys.used)} / ${formatBytes(sys.total)} (${sys.usedPct.toFixed(1)}%)\n` +
        `System free: ${formatBytes(sys.free)}\n` +
        `Threshold: ${MEMORY_HIGH_MB} MB\n`;

      await sendMessageSafe(chatId, report);

      if (botMemMb >= MEMORY_HIGH_MB) {
        await sendMessageSafe(chatId, `⚠️ Bot memory high. Running /compress…`);
        // fall through to compress
      } else {
        return;
      }
    }

    if (text === "/compress") {
      const wd = getChatWorkdir(chatId);

      let help = "";
      try {
        help = await exec(CODEX_BIN, ["--help"], { cwd: wd });
      } catch {}

      if (/\bcompress\b/i.test(help)) {
        try {
          const out = await exec(CODEX_BIN, ["compress", "-C", wd], { cwd: wd });
          return sendMessageSafe(chatId, `✅ codex compress done.\n${out || ""}`.trim());
        } catch (e) {
          return sendMessageSafe(chatId, `❌ codex compress failed:\n${String(e.message || e)}`);
        }
      }

      const prompt =
        "Create a compact project memory summary (max 200 lines) that preserves key architecture, " +
        "important file paths, and current open work. Output as a bullet list titled 'COMPRESSED MEMORY'.";
      const id = await enqueueJob(chatId, prompt);
      return sendMessageSafe(chatId, `🗜️ Compress fallback started as job ${id}. Use /job ${id}`);
    }

    // Job listing
    if (text === "/jobs") {
      const db = loadJobs();
      const recent = db.jobs
        .filter((j) => j.chatId === chatId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10);

      if (!recent.length) return sendMessageSafe(chatId, "No jobs yet.");

      const lines = recent.map((j) => {
        const s = j.status.padEnd(9);
        const repoSuffix = j.workdir ? `  (${path.basename(j.workdir)})` : "";
        return `${j.id}  ${s}  ${j.createdAt.replace("T", " ").slice(0, 19)}${repoSuffix}`;
      });
      return sendMessageSafe(chatId, `Recent jobs:\n${lines.join("\n")}`);
    }

    if (text === "/last") {
      const db = loadJobs();
      const recent = db.jobs
        .filter((j) => j.chatId === chatId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!recent) return sendMessageSafe(chatId, "No jobs yet.");
      return sendMessageSafe(chatId, `Last job: ${recent.id}\nStatus: ${recent.status}\nUse /job ${recent.id}`);
    }

    if (text.startsWith("/job ")) {
      const id = text.replace("/job", "").trim();
      if (!id) return sendMessageSafe(chatId, "Usage: /job <id>");

      const db = loadJobs();
      const j = getJob(db, id);
      if (!j || j.chatId !== chatId) return sendMessageSafe(chatId, "Job not found.");

      const lines = [
        `Job ${j.id}`,
        `Status: ${j.status}`,
        `Repo: ${j.workdir || WORKDIR}`,
        `Created: ${j.createdAt}`,
        j.startedAt ? `Started: ${j.startedAt}` : null,
        j.finishedAt ? `Finished: ${j.finishedAt}` : null,
        j.pid ? `PID: ${j.pid}` : null,
        j.exit ? `Exit: ${JSON.stringify(j.exit)}` : null,
        "",
        `Prompt: ${j.prompt.slice(0, 600)}${j.prompt.length > 600 ? "…" : ""}`,
      ].filter(Boolean);

      const logPath = path.join(JOB_LOGS_DIR, `job-${j.id}.log.txt`);
      if (
        (j.status === "failed" || j.status === "succeeded" || j.status === "canceled") &&
        fs.existsSync(logPath)
      ) {
        await sendMessageSafe(chatId, lines.join("\n"));
        return sendDocumentSafe(chatId, logPath, `Job ${j.id} log`);
      }

      return sendMessageSafe(chatId, lines.join("\n"));
    }

    if (text.startsWith("/cancel ")) {
      const id = text.replace("/cancel", "").trim();
      if (!id) return sendMessageSafe(chatId, "Usage: /cancel <id>");

      const db = loadJobs();
      const j = getJob(db, id);
      if (!j || j.chatId !== chatId) return sendMessageSafe(chatId, "Job not found.");

      if (j.status !== "running") return sendMessageSafe(chatId, `Job ${id} is not running (status: ${j.status}).`);

      try {
        if (j.pid) process.kill(j.pid, "SIGKILL");
      } catch {}

      j.status = "canceled";
      j.updatedAt = nowIso();
      upsertJob(db, j);
      saveJobs(db);

      return sendMessageSafe(chatId, `🛑 Canceled job ${id}.`);
    }

    if (text.startsWith("/codex ")) {
      const prompt = text.replace("/codex", "").trim();
      if (!prompt) return sendMessageSafe(chatId, "Usage: /codex <task>");

      const id = await enqueueJob(chatId, prompt);
      return sendMessageSafe(chatId, `✅ Queued job ${id}. Use /job ${id} or /jobs.`);
    }

    return sendMessageSafe(chatId, "Unknown command. Try /help");
  } catch (e) {
    try {
      await sendMessageSafe(msg.chat.id, `❌ Bot error:\n${String(e?.message || e).slice(0, TELEGRAM_MAX_CHARS)}`);
    } catch {}
  }
});

async function enqueueJob(chatId, prompt, { forcedId = null } = {}) {
  const db = loadJobs();
  const id = forcedId || genJobId();

  // Capture repo at queue time so it doesn't change under a queued job
  const workdir = getChatWorkdir(chatId);

  const job = {
    id,
    chatId,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    exit: null,
    prompt,
    workdir,
  };

  upsertJob(db, job);
  saveJobs(db);

  startWorkerLoop().catch(() => {});
  return id;
}

// Start worker loop on boot
startWorkerLoop().catch(() => {});
