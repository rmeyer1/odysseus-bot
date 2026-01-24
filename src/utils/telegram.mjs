import { TELEGRAM_MAX_CHARS, TELEGRAM_SEND_DELAY_MS } from "../config.mjs";
import { sleep } from "./common.mjs";

function chunkText(text, size = TELEGRAM_MAX_CHARS) {
  const s = text?.length ? text : "(no output)";
  const chunks = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}

export function createTelegramHelpers(bot) {
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

  return { sendMessageSafe, sendDocumentSafe };
}
