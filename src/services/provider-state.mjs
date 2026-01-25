import fs from "node:fs";
import { PROVIDER_DB_PATH } from "../config.mjs";
import { nowIso } from "../utils/common.mjs";

const DEFAULT_PROVIDER = "codex";

export function loadProviderState() {
  try {
    if (!fs.existsSync(PROVIDER_DB_PATH)) return { byChatId: {} };
    return JSON.parse(fs.readFileSync(PROVIDER_DB_PATH, "utf8")) || { byChatId: {} };
  } catch {
    return { byChatId: {} };
  }
}

export function saveProviderState(db) {
  fs.writeFileSync(PROVIDER_DB_PATH, JSON.stringify(db, null, 2));
}

export function getChatProvider(chatId) {
  const db = loadProviderState();
  const entry = db.byChatId?.[String(chatId)];
  return entry?.provider || DEFAULT_PROVIDER;
}

export function setChatProvider(chatId, provider) {
  const db = loadProviderState();
  db.byChatId[String(chatId)] = { provider, updatedAt: nowIso() };
  saveProviderState(db);
}
