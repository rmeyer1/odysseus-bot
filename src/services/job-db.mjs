import fs from "node:fs";
import { JOBS_DB_PATH, JOBS_DIR, JOB_LOGS_DIR } from "../config.mjs";

export function ensureJobsDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(JOB_LOGS_DIR, { recursive: true });
}

export function loadJobs() {
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

export function saveJobs(db) {
  fs.writeFileSync(JOBS_DB_PATH, JSON.stringify(db, null, 2));
}

export function getJob(db, id) {
  return db.jobs.find((j) => j.id === id);
}

export function upsertJob(db, job) {
  const idx = db.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) db.jobs[idx] = job;
  else db.jobs.push(job);
}
