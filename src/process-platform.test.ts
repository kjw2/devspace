import assert from "node:assert/strict";
import {
  createWindowsProcessJob,
  resolveShellCommand,
  terminateProcessTree,
  windowsDescendantPids,
} from "./process-platform.js";

assert.deepEqual(resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe" }), {
  executable: "C:\\Windows\\cmd.exe",
  args: ["/d", "/s", "/c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-lc", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" }), {
  executable: "/bin/sh",
  args: ["-c", "echo ok"],
});

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);

assert.deepEqual(
  windowsDescendantPids([
    { ProcessId: 10, ParentProcessId: 1 },
    { ProcessId: 11, ParentProcessId: 10 },
    { ProcessId: 12, ParentProcessId: 10 },
    { ProcessId: 13, ParentProcessId: 11 },
    { ProcessId: 99, ParentProcessId: 1 },
  ], 10),
  [11, 12, 13],
);

assert.deepEqual(
  windowsDescendantPids([
    { ProcessId: 20, ParentProcessId: 21 },
    { ProcessId: 21, ParentProcessId: 20 },
  ], 20),
  [21],
);

const jobCalls: string[] = [];
const job = createWindowsProcessJob(55, {
  platform: "win32",
  createJob: () => (jobCalls.push("create"), { kind: "job" }),
  openProcess: (pid) => (jobCalls.push(`open:${pid}`), { kind: "process" }),
  assignProcess: () => (jobCalls.push("assign"), true),
  terminateJob: (_handle, exitCode) => (jobCalls.push(`terminate:${exitCode}`), true),
  closeHandle: (handle) => jobCalls.push(`close:${(handle as { kind: string }).kind}`),
});
assert.ok(job);
assert.deepEqual(jobCalls, ["create", "open:55", "assign", "close:process"]);
assert.equal(job.terminate(), true);
job.close();
assert.equal(job.terminate(), false);
assert.deepEqual(jobCalls, [
  "create",
  "open:55",
  "assign",
  "close:process",
  "terminate:1",
  "close:job",
]);

const failedJobCalls: string[] = [];
assert.equal(createWindowsProcessJob(56, {
  platform: "win32",
  createJob: () => (failedJobCalls.push("create"), { kind: "job" }),
  openProcess: () => (failedJobCalls.push("open"), { kind: "process" }),
  assignProcess: () => (failedJobCalls.push("assign"), false),
  terminateJob: () => false,
  closeHandle: (handle) => failedJobCalls.push(`close:${(handle as { kind: string }).kind}`),
}), undefined);
assert.deepEqual(failedJobCalls, [
  "create",
  "open",
  "assign",
  "close:process",
  "close:job",
]);
