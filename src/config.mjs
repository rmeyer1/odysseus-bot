import os from "node:os";
import path from "node:path";
import dotenv from 'dotenv';

dotenv.config();

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID ? String(process.env.ALLOWED_CHAT_ID) : null;

export const WORKDIR = process.env.WORKDIR; // default/fallback repo

export const CODEX_BIN = process.env.CODEX_BIN || "codex";
// Force latest Codex model by default (overrideable)
export const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.1-codex-max";

export const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 60 * 60 * 1000);
export const USE_UNSAFE_CODEX = String(process.env.USE_UNSAFE_CODEX || "1") === "1";

export const TELEGRAM_SEND_DELAY_MS = Number(process.env.TELEGRAM_SEND_DELAY_MS || 900);
export const TELEGRAM_MAX_CHARS = Number(process.env.TELEGRAM_MAX_CHARS || 3500);
export const HEARTBEAT_SEC = Number(process.env.HEARTBEAT_SEC || 25);

export const JOBS_DIR = process.env.JOBS_DIR || path.join(os.homedir(), ".codex-bot");
export const JOBS_DB_PATH = path.join(JOBS_DIR, "jobs.json");
export const JOB_LOGS_DIR = path.join(JOBS_DIR, "logs");

export const MAX_INLINE_OUTPUT_CHARS = Number(process.env.MAX_INLINE_OUTPUT_CHARS || 12000);
export const MEMORY_HIGH_MB = Number(process.env.MEMORY_HIGH_MB || 900);

// Repomix
export const REPOMIX_BIN = process.env.REPOMIX_BIN || "repomix";
export const REPOMIX_TIMEOUT_MS = Number(process.env.REPOMIX_TIMEOUT_MS || 30 * 60 * 1000);
export const REPOMIX_DEFAULT_STYLE = (process.env.REPOMIX_DEFAULT_STYLE || "xml").toLowerCase();

// Repo switching
export const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || path.join(os.homedir(), "Projects", "work");
export const CHAT_REPO_DB_PATH = path.join(JOBS_DIR, "chat-repos.json");

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
// Keep WORKDIR required as your safe default (backward compatible)
if (!WORKDIR) throw new Error("Missing WORKDIR");
