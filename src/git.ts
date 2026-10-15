import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWindowsProcessJob, terminateProcessTree } from "./process-platform.js";

const DEFAULT_GIT_TIMEOUT_MS = 30_000;

export interface GitCommandOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  timeoutMs?: number;
  /** Shared wall-clock deadline for a sequence of Git operations. */
  deadlineMs?: number;
}

export class GitCommandTimeoutError extends Error {
  readonly code = "GIT_COMMAND_TIMEOUT";
  constructor(readonly timeoutMs: number) {
    super(`Git operation exceeded its ${timeoutMs}ms budget. Review initialization may be unavailable; this does not mean Core is down.`);
    this.name = "GitCommandTimeoutError";
  }
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  hasHead?: boolean;
  reason?: "not_git";
  message?: string;
}

export async function git(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const configuredTimeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout <= 0) {
    throw new RangeError("Git timeoutMs must be a positive integer");
  }
  if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs)) {
    throw new RangeError("Git deadlineMs must be finite");
  }
  const timeoutMs = Math.min(configuredTimeout, options.deadlineMs === undefined
    ? configuredTimeout : options.deadlineMs - Date.now());
  if (timeoutMs <= 0) throw new GitCommandTimeoutError(configuredTimeout);
  const detached = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let failure: Error | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    const child = spawn("git", args, {
      cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      detached,
    });
    const windowsJob = createWindowsProcessJob(child.pid);
    const terminate = () => {
      if (!windowsJob?.terminate()) terminateProcessTree(child, "SIGKILL", detached);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (failure || timedOut) return;
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        failure = Object.assign(new Error(`Git ${stream} exceeded maxBuffer`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
        terminate();
        return;
      }
      (stream === "stdout" ? stdout : stderr).push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", error => { failure = error; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      windowsJob?.close();
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (timedOut) reject(new GitCommandTimeoutError(timeoutMs));
      else if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(result.stderr || `Git exited with code ${code}`), { ...result, code, signal }));
      else resolve(result);
    });
  });
}

export async function getGitEligibility(cwd: string, options: GitCommandOptions = {}): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"], options);
  } catch (error) {
    if (error instanceof GitCommandTimeoutError) throw error;
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"], options)).stdout.trim();
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], options);
  } catch (error) {
    if (error instanceof GitCommandTimeoutError) throw error;
    let headRef: string;
    try {
      headRef = (await git(gitRoot, ["symbolic-ref", "--quiet", "HEAD"], options)).stdout.trim();
    } catch (headError) {
      if (headError instanceof GitCommandTimeoutError) throw headError;
      throw error;
    }

    const existingHeadRef = (await git(gitRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "--count=1",
      headRef,
    ], options)).stdout.trim();
    if (existingHeadRef) throw error;

    return {
      ok: true,
      gitRoot,
      hasHead: false,
    };
  }

  return { ok: true, gitRoot, hasHead: true };
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
