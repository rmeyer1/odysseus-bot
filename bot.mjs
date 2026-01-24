/**
 * Resilient Coding Telegram Bot (Job-based, rate-limit safe, Pi-friendly)
 *
 * Main entry point: init TelegramBot, wire services, start worker loop.
 */

import TelegramBot from "node-telegram-bot-api";
import { BOT_TOKEN } from "./src/config.mjs";
import { createTelegramHelpers } from "./src/utils/telegram.mjs";
import { ensureJobsDirs } from "./src/services/job-db.mjs";
import { createWorker } from "./src/services/worker.mjs";
import { createMessageHandler } from "./src/services/message-router.mjs";

ensureJobsDirs();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const { sendMessageSafe, sendDocumentSafe } = createTelegramHelpers(bot);
const { startWorkerLoop, enqueueJob } = createWorker({ sendMessageSafe, sendDocumentSafe });

bot.on("polling_error", (err) => {
  console.error("[polling_error]", err?.message || err);
});

bot.on("message", createMessageHandler({ sendMessageSafe, sendDocumentSafe, enqueueJob }));

startWorkerLoop().catch(() => {});
