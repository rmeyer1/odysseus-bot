import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  CODEX_BIN,
  CODEX_MODEL,
  CODEX_TIMEOUT_MS,
  HEARTBEAT_SEC,
  USE_UNSAFE_CODEX,
} from "../config.mjs";
import { buildCodexArgs, makeBigTaskPrompt } from "../commands/codex.mjs";
import { nowIso, shellQuote, sleep } from "../utils/common.mjs";
import BaseProvider from "./BaseProvider.mjs";

export default class CodexCliProvider extends BaseProvider {
  constructor({ sendMessageSafe }) {
    super();
    this.sendMessageSafe = sendMessageSafe;
    this.running = new Map();
  }

  async execute(job, context) {
    const { workdir, logPath, onPid } = context;

    const fullPrompt = makeBigTaskPrompt(job.prompt);
    const args = buildCodexArgs(fullPrompt, workdir);

    const outStream = fs.createWriteStream(logPath, { flags: "a" });
    outStream.write(
      `== job ${job.id} ==\nstarted: ${nowIso()}\ncmd: ${CODEX_BIN} ${args
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

    this.running.set(job.id, child);
    if (onPid) onPid(child.pid);

    const heartbeatTimer = setInterval(async () => {
      if (finished) return;
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_SEC * 1000) {
        lastHeartbeat = now;
        try {
          await this.sendMessageSafe(job.chatId, `⏳ Job ${job.id} still running…`);
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
    this.running.delete(job.id);

    outStream.write(`\n\nended: ${nowIso()}\nexit: ${JSON.stringify(exitInfo)}\n`);
    outStream.end();

    return {
      combinedTail,
      exitInfo,
      model: CODEX_MODEL,
      provider: "codex",
    };
  }

  async abort(job) {
    const child = this.running.get(job.id);
    if (!child) return false;
    try {
      child.kill("SIGKILL");
      return true;
    } catch {
      return false;
    } finally {
      this.running.delete(job.id);
    }
  }
}
