import fs from "node:fs";
import path from "node:path";
import { CHAT_REPO_DB_PATH, REPOS_BASE_DIR, WORKDIR } from "../config.mjs";
import { nowIso } from "../utils/common.mjs";

export function loadChatRepos() {
  try {
    if (!fs.existsSync(CHAT_REPO_DB_PATH)) return { byChatId: {} };
    return JSON.parse(fs.readFileSync(CHAT_REPO_DB_PATH, "utf8")) || { byChatId: {} };
  } catch {
    return { byChatId: {} };
  }
}

export function saveChatRepos(db) {
  fs.writeFileSync(CHAT_REPO_DB_PATH, JSON.stringify(db, null, 2));
}

export function resolveRepoToWorkdir(repoToken) {
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

export function getChatWorkdir(chatId) {
  const db = loadChatRepos();
  const entry = db.byChatId?.[String(chatId)];
  return entry?.workdir || WORKDIR;
}

export function listReposUnderBaseDir() {
  const entries = fs
    .readdirSync(REPOS_BASE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(REPOS_BASE_DIR, name, ".git")))
    .sort();
  return entries;
}

export function updateChatRepo(chatId, token, workdir) {
  const db = loadChatRepos();
  db.byChatId[String(chatId)] = { repo: token, workdir, updatedAt: nowIso() };
  saveChatRepos(db);
}
