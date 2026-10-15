import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { git, getGitEligibility, GitCommandTimeoutError } from "./git.js";

test("Git failures retain stderr and exit code while output stays bounded", async () => {
  await assert.rejects(() => git(tmpdir(), ["rev-parse", "--verify", "devspace-nonexistent-ref"]), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: number }).code, 128);
    assert.equal(typeof (error as Error & { stderr: string }).stderr, "string");
    return true;
  });
  await assert.rejects(() => git(tmpdir(), ["--version"], { maxBuffer: 1 }), error =>
    error instanceof Error && (error as Error & { code: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
});

test("a blocked Git stdin is bounded without reporting Core downtime", async () => {
  const started = Date.now();
  await assert.rejects(() => git(tmpdir(), ["hash-object", "--stdin"], { timeoutMs: 250 }), error => {
    assert.ok(error instanceof GitCommandTimeoutError);
    assert.equal(error.code, "GIT_COMMAND_TIMEOUT");
    assert.doesNotMatch(error.message, /CORE_UNAVAILABLE/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
});

test("an exhausted Git deadline propagates instead of claiming the directory is not Git", async () => {
  await assert.rejects(() => getGitEligibility(tmpdir(), { deadlineMs: Date.now() - 1 }), GitCommandTimeoutError);
});

test("Git timeout terminates a real child process, including Git for Windows wrapper descendants", async t => {
  const root = await mkdtemp(join(tmpdir(), "devspace-git-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidPath = join(root, "child.pid");
  const script = join(root, "wait.cjs");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const quote = (path: string) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  await git(root, ["init"]);
  await assert.rejects(() => git(root, ["-c", `alias.devspace-wait=!${quote(process.execPath)} ${quote(script)}`, "devspace-wait"],
    { timeoutMs: 1_500 }), GitCommandTimeoutError);
  const pid = Number(await readFile(pidPath, "utf8"));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Git child ${pid} survived its timeout`);
});
