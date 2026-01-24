import { CODEX_MODEL, USE_UNSAFE_CODEX } from "../config.mjs";

export function buildCodexArgs(prompt, workdir) {
  const args = [];

  args.push("exec");

  // Force a known model for every invocation (unless overridden via env)
  args.push("--model", CODEX_MODEL);

  if (USE_UNSAFE_CODEX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write", "-a", "never");
  }

  args.push("-C", workdir);
  args.push(prompt);

  return args;
}

export function getCodexSystemPrompt() {
  return [
    "You are operating in a local git repo. Follow these constraints:",
    "- Keep output concise. Do NOT paste large diffs into the chat output.",
    "- If you generate a diff, write it to a patch file instead (e.g. /tmp/changes.patch).",
    "- Use git commits and branches. Prefer small commits.",
    "- If asked to open a PR: use GitHub CLI (gh) to create it, and print the PR URL at the end.",
    "- Always finish with a short summary: files changed, commands run, what to verify next.",
  ].join("\n");
}

export function makeBigTaskPrompt(userPrompt) {
  return [getCodexSystemPrompt(), "", "User task:", userPrompt.trim()].join("\n");
}
