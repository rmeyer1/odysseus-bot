import fs from "node:fs";
import path from "node:path";
import {
  CODEX_BIN,
  CODEX_MODEL,
  GEMINI_MODEL,
  JOB_LOGS_DIR,
  MAX_INLINE_OUTPUT_CHARS,
  USE_UNSAFE_CODEX,
  WORKDIR,
} from "../config.mjs";
import { createProviderManager } from "../providers/index.mjs";
import { getJob, loadJobs, saveJobs, upsertJob } from "./job-db.mjs";
import { genJobId, nowIso, parseTokensUsed, sleep } from "../utils/common.mjs";

let workerRunning = false;

export function createWorker({ sendMessageSafe, sendDocumentSafe }) {
  const providerManager = createProviderManager({ sendMessageSafe });

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
    const providerName = (j.provider || "codex").toLowerCase();

    const logPath = path.join(JOB_LOGS_DIR, `job-${j.id}.log.txt`);
    const metaPath = path.join(JOB_LOGS_DIR, `job-${j.id}.meta.json`);

    const meta = {
      id: j.id,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      workdir,
      provider: providerName,
      prompt: j.prompt,
    };

    if (providerName === "codex") {
      meta.codexBin = CODEX_BIN;
      meta.codexModel = CODEX_MODEL;
      meta.unsafeBypass = USE_UNSAFE_CODEX;
    }

    if (providerName === "gemini") {
      meta.geminiModel = GEMINI_MODEL;
    }

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    if (providerName === "codex") {
      await sendMessageSafe(chatId, `🚀 Job ${j.id} started.\nWorking dir: ${workdir}\nModel: ${CODEX_MODEL}`);
    } else {
      await sendMessageSafe(
        chatId,
        `🚀 Job ${j.id} started.\nProvider: ${providerName}\nWorking dir: ${workdir}\nModel: ${providerName === "gemini" ? GEMINI_MODEL : ""}`.trim()
      );
    }

    const provider = providerManager.getProvider(providerName);

    let result = null;
    try {
      result = await provider.execute(j, {
        workdir,
        logPath,
        onPid: (pid) => {
          j.pid = pid;
          j.updatedAt = nowIso();
          upsertJob(db, j);
          saveJobs(db);
        },
      });
    } catch (err) {
      const msg = String(err?.message || err);
      fs.writeFileSync(logPath, `[provider_error] ${msg}\n`, { flag: "a" });
      result = { combinedTail: msg, exitInfo: { code: 1, signal: "provider_error" } };
    }

    const exitInfo = result?.exitInfo || { code: 1, signal: "unknown" };

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
    const modelLabel = result?.model || (providerName === "codex" ? CODEX_MODEL : GEMINI_MODEL);

    const captionLines = [
      `📄 Job ${j2.id} ${j2.status.toUpperCase()}`,
      modelLabel ? `Model: ${modelLabel}` : null,
      tokens ? `Tokens used: ${tokens.toLocaleString()}` : null,
      exitInfo?.code === 0 ? "✅ Completed." : "❌ Completed with errors.",
    ].filter(Boolean);

    const tailSummary =
      `🧾 Job ${j2.id} ${j2.status.toUpperCase()}\n` +
      (modelLabel ? `Model: ${modelLabel}\n` : "") +
      (tokens ? `Tokens used: ${tokens.toLocaleString()}\n` : "") +
      `Exit: code=${exitInfo.code} signal=${exitInfo.signal || "none"}\n\n` +
      `--- Output tail ---\n${(result?.combinedTail || "").trim() || "(no output)"}`;

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

  async function enqueueJob(chatId, prompt, { forcedId = null, workdir = null, provider = "codex" } = {}) {
    const db = loadJobs();
    const id = forcedId || genJobId();

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
      workdir: workdir || WORKDIR,
      provider,
    };

    upsertJob(db, job);
    saveJobs(db);

    startWorkerLoop().catch(() => {});
    return id;
  }

  async function cancelJob(chatId, id) {
    const db = loadJobs();
    const j = getJob(db, id);
    if (!j || j.chatId !== chatId) return { ok: false, reason: "not_found" };
    if (j.status !== "running") return { ok: false, reason: "not_running", status: j.status };

    const provider = providerManager.getProvider(j.provider || "codex");
    await provider.abort(j);

    j.status = "canceled";
    j.updatedAt = nowIso();
    upsertJob(db, j);
    saveJobs(db);

    return { ok: true };
  }

  return { startWorkerLoop, enqueueJob, cancelJob };
}
