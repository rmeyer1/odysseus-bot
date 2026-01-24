import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  CODEX_BIN,
  CODEX_MODEL,
  CODEX_TIMEOUT_MS,
  HEARTBEAT_SEC,
  JOB_LOGS_DIR,
  MAX_INLINE_OUTPUT_CHARS,
  USE_UNSAFE_CODEX,
  WORKDIR,
} from "../config.mjs";
import { buildCodexArgs, makeBigTaskPrompt } from "../commands/codex.mjs";
import { getJob, loadJobs, saveJobs, upsertJob } from "./job-db.mjs";
import { genJobId, nowIso, parseTokensUsed, shellQuote, sleep } from "../utils/common.mjs";

let workerRunning = false;

export function createWorker({ sendMessageSafe, sendDocumentSafe }) {
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

  async function enqueueJob(chatId, prompt, { forcedId = null, workdir = null } = {}) {
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
    };

    upsertJob(db, job);
    saveJobs(db);

    startWorkerLoop().catch(() => {});
    return id;
  }

  return { startWorkerLoop, enqueueJob };
}
