import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED_CHAT_ID,
  CODEX_BIN,
  CODEX_MODEL,
  GEMINI_MODEL,
  JOB_LOGS_DIR,
  MAX_INLINE_OUTPUT_CHARS,
  MEMORY_HIGH_MB,
  REPOS_BASE_DIR,
  TELEGRAM_MAX_CHARS,
  USE_UNSAFE_CODEX,
  WORKDIR,
} from "../config.mjs";
import { createRepomixCommand } from "../commands/repomix.mjs";
import { exec, formatBytes, getSystemMemInfo } from "../utils/common.mjs";
import {
  getChatWorkdir,
  listReposUnderBaseDir,
  resolveRepoToWorkdir,
  updateChatRepo,
} from "./repo-manager.mjs";
import { getJob, loadJobs } from "./job-db.mjs";
import { getChatProvider, setChatProvider } from "./provider-state.mjs";

function isAllowed(msg) {
  if (!ALLOWED_CHAT_ID) return true;
  return String(msg?.chat?.id) === ALLOWED_CHAT_ID;
}

export function createMessageHandler({ sendMessageSafe, sendDocumentSafe, enqueueJob, cancelJob }) {
  const runRepomixCommand = createRepomixCommand({ sendMessageSafe, sendDocumentSafe });

  async function queueJob(chatId, prompt, providerOverride = null) {
    const workdir = getChatWorkdir(chatId);
    const provider = providerOverride || getChatProvider(chatId);
    const id = await enqueueJob(chatId, prompt, { workdir, provider });
    return { id, workdir, provider };
  }

  return async function onMessage(msg) {
    try {
      if (!isAllowed(msg)) return;

      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();
      if (!text) return;

      if (text === "/repo") {
        const wd = getChatWorkdir(chatId);
        return sendMessageSafe(chatId, `📌 Current repo:\n${wd}`);
      }

      if (text === "/repos") {
        try {
          const repos = listReposUnderBaseDir();
          if (!repos.length) return sendMessageSafe(chatId, `No git repos found in:\n${REPOS_BASE_DIR}`);
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

        updateChatRepo(chatId, token, wd);
        return sendMessageSafe(chatId, `✅ Switched repo.\nWORKDIR:\n${wd}`);
      }

      if (text.startsWith("/setprovider")) {
        const token = text.replace("/setprovider", "").trim().toLowerCase();
        if (!token || !["codex", "gemini"].includes(token)) {
          return sendMessageSafe(chatId, "Usage: /setprovider <codex|gemini>");
        }
        setChatProvider(chatId, token);
        return sendMessageSafe(chatId, `✅ Default provider set to: ${token}`);
      }

      if (text === "/start" || text === "/help") {
        const wd = getChatWorkdir(chatId);
        const provider = getChatProvider(chatId);
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
            "Providers:",
            "/setprovider <codex|gemini> - set default provider for this chat",
            "/ask <prompt>               - run with default provider",
            "/codex <prompt>             - force local Codex CLI",
            "/gemini <prompt>            - force Gemini API",
            "",
            "Commands:",
            "/status                 - git status -sb (current repo)",
            "/diff                   - git diff (current repo)",
            "/pull                   - git pull (current repo)",
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
            `Default provider: ${provider}`,
            `Codex model: ${CODEX_MODEL}`,
            `Gemini model: ${GEMINI_MODEL}`,
            `Unsafe sandbox bypass: ${USE_UNSAFE_CODEX ? "ON" : "OFF"}`,
          ].join("\n")
        );
      }

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
          await sendDocumentSafe(chatId, p, "git diff");
          return;
        }
        return sendMessageSafe(chatId, out);
      }

      if (text === "/pull") {
        const wd = getChatWorkdir(chatId);
        const out = await exec("git", ["pull"], { cwd: wd });
        return sendMessageSafe(chatId, out);
      }

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

        if (botMemMb < MEMORY_HIGH_MB) return;
        await sendMessageSafe(chatId, "⚠️ Bot memory high. Running /compress…");
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
        const { id } = await queueJob(chatId, prompt, "codex");
        return sendMessageSafe(chatId, `🗜️ Compress fallback started as job ${id}. Use /job ${id}`);
      }

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
          const provider = j.provider ? `  [${j.provider}]` : "";
          return `${j.id}  ${s}  ${j.createdAt.replace("T", " ").slice(0, 19)}${repoSuffix}${provider}`;
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
          `Provider: ${j.provider || "codex"}`,
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
        if ((j.status === "failed" || j.status === "succeeded" || j.status === "canceled") && fs.existsSync(logPath)) {
          await sendMessageSafe(chatId, lines.join("\n"));
          return sendDocumentSafe(chatId, logPath, `Job ${j.id} log`);
        }

        return sendMessageSafe(chatId, lines.join("\n"));
      }

      if (text.startsWith("/cancel ")) {
        const id = text.replace("/cancel", "").trim();
        if (!id) return sendMessageSafe(chatId, "Usage: /cancel <id>");

        const result = await cancelJob(chatId, id);
        if (!result.ok) {
          if (result.reason === "not_found") return sendMessageSafe(chatId, "Job not found.");
          if (result.reason === "not_running") {
            return sendMessageSafe(chatId, `Job ${id} is not running (status: ${result.status}).`);
          }
          return sendMessageSafe(chatId, "Cancel failed.");
        }

        return sendMessageSafe(chatId, `🛑 Canceled job ${id}.`);
      }

      if (text.startsWith("/codex ")) {
        const prompt = text.replace("/codex", "").trim();
        if (!prompt) return sendMessageSafe(chatId, "Usage: /codex <task>");

        const { id } = await queueJob(chatId, prompt, "codex");
        return sendMessageSafe(chatId, `✅ Queued job ${id}. Use /job ${id} or /jobs.`);
      }

      if (text.startsWith("/gemini ")) {
        const prompt = text.replace("/gemini", "").trim();
        if (!prompt) return sendMessageSafe(chatId, "Usage: /gemini <task>");

        const { id } = await queueJob(chatId, prompt, "gemini");
        return sendMessageSafe(chatId, `✅ Queued job ${id}. Use /job ${id} or /jobs.`);
      }

      if (text.startsWith("/ask ")) {
        const prompt = text.replace("/ask", "").trim();
        if (!prompt) return sendMessageSafe(chatId, "Usage: /ask <task>");

        const { id, provider } = await queueJob(chatId, prompt);
        return sendMessageSafe(chatId, `✅ Queued job ${id} via ${provider}. Use /job ${id} or /jobs.`);
      }

      if (!text.startsWith("/")) {
        const { id, provider } = await queueJob(chatId, text);
        return sendMessageSafe(chatId, `✅ Queued job ${id} via ${provider}. Use /job ${id} or /jobs.`);
      }

      return sendMessageSafe(chatId, "Unknown command. Try /help");
    } catch (e) {
      try {
        await sendMessageSafe(msg.chat.id, `❌ Bot error:\n${String(e?.message || e).slice(0, TELEGRAM_MAX_CHARS)}`);
      } catch {}
    }
  };
}
