import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import koffi from "koffi";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WindowsProcessJob {
  terminate(exitCode?: number): boolean;
  close(): void;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

export interface WindowsJobRuntime {
  platform: NodeJS.Platform;
  createJob(): unknown;
  openProcess(pid: number): unknown;
  assignProcess(job: unknown, process: unknown): boolean;
  terminateJob(job: unknown, exitCode: number): boolean;
  closeHandle(handle: unknown): void;
}

interface WindowsProcessRow {
  ProcessId?: number;
  ParentProcessId?: number;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: killWindowsProcessTree,
};

let cachedWindowsJobApi: WindowsJobRuntime | undefined;

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}

export function createWindowsProcessJob(
  pid: number | undefined,
  runtime: WindowsJobRuntime = windowsJobRuntime(),
): WindowsProcessJob | undefined {
  if (runtime.platform !== "win32" || !pid) return undefined;

  const job = runtime.createJob();
  if (!job) return undefined;
  const processHandle = runtime.openProcess(pid);
  if (!processHandle) {
    runtime.closeHandle(job);
    return undefined;
  }

  const assigned = runtime.assignProcess(job, processHandle);
  runtime.closeHandle(processHandle);
  if (!assigned) {
    runtime.closeHandle(job);
    return undefined;
  }

  let closed = false;
  return {
    terminate(exitCode = 1) {
      if (closed) return false;
      return runtime.terminateJob(job, exitCode);
    },
    close() {
      if (closed) return;
      closed = true;
      runtime.closeHandle(job);
    },
  };
}

function killWindowsProcessTree(pid: number): boolean {
  // Git for Windows/MSYS pipelines can re-parent one side of a pipe while
  // taskkill is tearing down the shell tree. Snapshot descendants first, then
  // kill those PIDs again after the normal /T tree kill so a re-parented
  // process cannot escape and become an orphan.
  const descendants = windowsDescendantPids(readWindowsProcessRows(), pid);
  const rootKilled = taskkillWindowsPid(pid, true);
  for (const descendantPid of descendants.reverse()) {
    taskkillWindowsPid(descendantPid, true);
  }
  return rootKilled;
}

function taskkillWindowsPid(pid: number, includeTree: boolean): boolean {
  const args = ["/pid", String(pid)];
  if (includeTree) args.push("/T");
  args.push("/F");
  const result = spawnSync("taskkill.exe", args, {
    stdio: "ignore",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function readWindowsProcessRows(): WindowsProcessRow[] {
  const script = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId",
    "ConvertTo-Json -Compress",
  ].join(" | ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout) as WindowsProcessRow | WindowsProcessRow[];
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (row) => Number.isInteger(row.ProcessId) && Number.isInteger(row.ParentProcessId),
    );
  } catch {
    return [];
  }
}

export function windowsDescendantPids(
  processes: readonly WindowsProcessRow[],
  rootPid: number,
): number[] {
  const children = new Map<number, number[]>();
  for (const process of processes) {
    const pid = process.ProcessId;
    const parentPid = process.ParentProcessId;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid === undefined || parentPid === undefined) {
      continue;
    }
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function windowsJobRuntime(): WindowsJobRuntime {
  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      createJob: () => undefined,
      openProcess: () => undefined,
      assignProcess: () => false,
      terminateJob: () => false,
      closeHandle: () => undefined,
    };
  }
  cachedWindowsJobApi ??= createWindowsJobApi();
  return cachedWindowsJobApi;
}

function createWindowsJobApi(): WindowsJobRuntime {
  const kernel32 = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("DevSpaceProcessJobHandle", koffi.opaque());
  const CreateJobObjectW = kernel32.func(
    "DevSpaceProcessJobHandle __stdcall CreateJobObjectW(void *security, const char16_t *name)",
  ) as unknown as (security: null, name: null) => unknown;
  const OpenProcess = kernel32.func(
    "DevSpaceProcessJobHandle __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  ) as unknown as (access: number, inherit: number, pid: number) => unknown;
  const AssignProcessToJobObject = kernel32.func(
    "int __stdcall AssignProcessToJobObject(DevSpaceProcessJobHandle job, DevSpaceProcessJobHandle process)",
  ) as unknown as (job: unknown, process: unknown) => number;
  const TerminateJobObject = kernel32.func(
    "int __stdcall TerminateJobObject(DevSpaceProcessJobHandle job, uint32_t exitCode)",
  ) as unknown as (job: unknown, exitCode: number) => number;
  const CloseHandle = kernel32.func(
    "int __stdcall CloseHandle(DevSpaceProcessJobHandle handle)",
  ) as unknown as (handle: unknown) => number;

  const PROCESS_TERMINATE = 0x0001;
  const PROCESS_SET_QUOTA = 0x0100;
  return {
    platform: "win32",
    createJob: () => CreateJobObjectW(null, null),
    openProcess: (pid) => OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid),
    assignProcess: (job, processHandle) => AssignProcessToJobObject(job, processHandle) !== 0,
    terminateJob: (job, exitCode) => TerminateJobObject(job, exitCode) !== 0,
    closeHandle: (handle) => {
      CloseHandle(handle);
    },
  };
}
