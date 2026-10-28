#!/usr/bin/env node
// Burn Codex quota before a reset: read the live quota, work out whether it can be used up in time,
// and run read-only Codex tasks from a task pool in the background until the deadline. Node 18+, no dependencies.
//
//   node burn.mjs quota [--json]
//   node burn.mjs plan --until <time> [--target 95]
//   node burn.mjs add <dir> "<task>"      |  node burn.mjs tasks
//   node burn.mjs start --until <time> [--target 95] [--parallel N] [--max-tasks N]
//   node burn.mjs status                   |  node burn.mjs stop
//
// <time> is ISO (2026-10-29T15:00:00Z) or relative (+3h, +40m). State lives in $BURN_DIR (default ~/.resethook-burn).
// $BURN_LANG=zh prints Chinese. $CODEX_BIN picks the codex binary, $BURN_MODEL the model (default: your Codex default).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DIR = process.env.BURN_DIR || join(homedir(), ".resethook-burn");
const F = { tasks: "tasks.md", out: "out", log: "burn.log", state: "state.json", samples: "samples.jsonl", stop: "STOP" };
for (const k in F) F[k] = join(DIR, F[k]);
const CODEX = process.env.CODEX_BIN || "codex";
const MODEL = process.env.BURN_MODEL || "";
const ZH = process.env.BURN_LANG === "zh";
const TASK_TIMEOUT_MS = 40 * 60e3;
const MAX_PARALLEL = 3;
// Weekly percent used per 1% of the five-hour window. Not published by OpenAI. Plus users measure one full
// five-hour window at 15-16% of the week (v2ex.com/t/1220092, linux.do/t/topic/3075908, github.com/openai/codex/discussions/2251);
// the author's own Codex logs over two weeks gave 0.162. Replaced by your own readings once there are enough.
const K_DEFAULT = 0.162;
const R_DEFAULT = 40; // five-hour percent one task uses per hour; replaced by your own readings too

const T = (zh, en) => (ZH ? zh : en);
const now = () => new Date();
const hm = (d) => d.toLocaleString(ZH ? "zh-CN" : "en-GB", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const H = 3600e3;

function log(msg) {
  const line = `${hm(now())} ${msg}`;
  appendFileSync(F.log, line + "\n");
  console.log(line);
}

const loadState = () => { try { return JSON.parse(readFileSync(F.state, "utf8")); } catch { return {}; } };
const saveState = (patch) => writeFileSync(F.state, JSON.stringify({ ...loadState(), ...patch }, null, 1));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Codex app-server `account/rateLimits/read`: live numbers, no model call. */
function readQuota() {
  return new Promise((ok, fail) => {
    const p = spawn(CODEX, ["app-server"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { p.kill(); fail(new Error("codex app-server did not answer in 30 s")); }, 30e3);
    p.on("error", (e) => { clearTimeout(timer); fail(e); });
    createInterface({ input: p.stdout }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 2) return;
      clearTimeout(timer);
      p.kill();
      const rl = msg.result?.rateLimits;
      if (!rl?.primary || !rl?.secondary) return fail(new Error(`no rate limits: ${line.slice(0, 300)}`));
      const win = (w) => ({ used: w.usedPercent, resets_at: new Date(w.resetsAt * 1000).toISOString() });
      ok({
        five_hour: win(rl.primary),
        weekly: win(rl.secondary),
        plan: rl.planType,
        limit_reached: rl.rateLimitReachedType ?? null,
        reset_credits: (msg.result.rateLimitResetCredits?.credits ?? []).filter((c) => c.status === "available")
          .map((c) => ({ title: c.title, expires: new Date(c.expiresAt * 1000).toISOString() })),
      });
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "resethook-burn", version: "1" } } });
    send({ jsonrpc: "2.0", method: "initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" });
  });
}

/** Every reading is kept, so k and r can be measured from this account instead of guessed. */
async function quota(burning = 0) {
  const q = await readQuota();
  appendFileSync(F.samples, JSON.stringify({ t: Date.now(), p: q.five_hour.used, p_reset: q.five_hour.resets_at, w: q.weekly.used, w_reset: q.weekly.resets_at, burning }) + "\n");
  return q;
}

function fmtQuota(q) {
  let s = T(
    `5 小时窗口已用 ${q.five_hour.used}%（${hm(new Date(q.five_hour.resets_at))} 重置）；周窗口已用 ${q.weekly.used}%（${hm(new Date(q.weekly.resets_at))} 重置）`,
    `5-hour window ${q.five_hour.used}% used (resets ${hm(new Date(q.five_hour.resets_at))}); weekly ${q.weekly.used}% used (resets ${hm(new Date(q.weekly.resets_at))})`,
  );
  if (q.reset_credits.length) s += T(`；账上有 ${q.reset_credits.length} 次手动整体重置可用（是用户的，不要动）`, `; ${q.reset_credits.length} manual full reset(s) available (the user's, leave them alone)`);
  return s;
}

/** k and r from consecutive readings inside the same windows. Readings are whole percents, so wait for enough of them. */
export function rates(samples) {
  const s = [...samples].sort((a, b) => a.t - b.t);
  let dp = 0, dw = 0, dpBurn = 0, hours = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (a.p_reset !== b.p_reset || a.w_reset !== b.w_reset || b.t - a.t > 2 * H || b.p < a.p || b.w < a.w) continue;
    dp += b.p - a.p;
    dw += b.w - a.w;
    if (a.burning && b.burning) { dpBurn += b.p - a.p; hours += ((b.t - a.t) / H) * a.burning; }
  }
  return {
    k: dp >= 30 && dw >= 3 ? { v: dw / dp, measured: true } : { v: K_DEFAULT, measured: false },
    r: hours >= 0.5 && dpBurn >= 10 ? { v: dpBurn / hours, measured: true } : { v: R_DEFAULT, measured: false },
  };
}

/** Step forward 5 minutes at a time: n tasks burn r*n five-hour percent per hour, a window gives at most 100%. */
export function simulate(q, from, deadline, target, k, r, n) {
  let p = q.five_hour.used, w = q.weekly.used, pReset = Date.parse(q.five_hour.resets_at);
  const step = 5 * 60e3;
  for (let t = from.getTime(); t < deadline.getTime(); t += step) {
    if (t >= pReset) { p = 0; pReset += 5 * H; }
    const burn = Math.min((r * n * step) / H, 100 - p);
    p += burn;
    w += burn * k;
    if (w >= target) return { doneAt: new Date(t + step), weeklyAtEnd: target };
  }
  return { doneAt: null, weeklyAtEnd: w };
}

/** The formula: weekly percent burnable before the deadline ≈ k × ((100 − P) + 100 × five-hour resets before the deadline). */
export function plan(q, { until, target = 95, from = now(), k, r }) {
  const deadline = new Date(Math.min(until.getTime(), Date.parse(q.weekly.resets_at))); // the weekly window ending counts as a reset too
  const hrs = (deadline - from) / H;
  const P = q.five_hour.used, W = q.weekly.used;
  const t1 = (Date.parse(q.five_hour.resets_at) - from) / H;
  const resets = hrs <= t1 ? 0 : 1 + Math.floor((hrs - t1) / 5);
  const cap = k.v * (100 - P + 100 * resets);
  let parallel = 0, doneAt = null, weeklyAtEnd = W;
  if (W < target) {
    for (let n = 1; n <= MAX_PARALLEL && !doneAt; n++) ({ doneAt, weeklyAtEnd } = simulate(q, from, deadline, target, k.v, r.v, (parallel = n)));
  }
  return { deadline, hrs, P, W, t1, resets, cap, target, k, r, parallel, doneAt, weeklyAtEnd };
}

function fmtPlan(x) {
  const src = (m) => (m ? T("实测", "measured") : T("默认", "default"));
  const lines = [
    T(`现在：周已用 W=${x.W}%，5 小时窗口已用 P=${x.P}%（${x.t1.toFixed(1)} 小时后重置）；离截止 ${x.hrs.toFixed(1)} 小时（${hm(x.deadline)}）`,
      `Now: weekly W=${x.W}% used, five-hour P=${x.P}% used (resets in ${x.t1.toFixed(1)} h); ${x.hrs.toFixed(1)} h to the deadline (${hm(x.deadline)})`),
    T(`换算：用掉 1% 的 5 小时额度，周额度涨 k=${x.k.v.toFixed(3)}%（${src(x.k.measured)}）；一个任务每小时用掉 5 小时额度 r=${x.r.v.toFixed(0)}%（${src(x.r.measured)}）`,
      `Rates: 1% of the five-hour window costs k=${x.k.v.toFixed(3)}% of the week (${src(x.k.measured)}); one task uses r=${x.r.v.toFixed(0)}% of the five-hour window per hour (${src(x.r.measured)})`),
    T(`公式：截止前最多能烧的周额度 ≈ k ×［(100−P) + 100 × 截止前 5 小时窗口还会重置几次］= ${x.k.v.toFixed(3)} ×［${100 - x.P} + 100 × ${x.resets}］≈ ${x.cap.toFixed(0)}%；要烧的 = ${x.target}% − W = ${Math.max(0, x.target - x.W)}%`,
      `Formula: weekly percent burnable before the deadline ≈ k × ((100 − P) + 100 × five-hour resets before it) = ${x.k.v.toFixed(3)} × (${100 - x.P} + 100 × ${x.resets}) ≈ ${x.cap.toFixed(0)}%; needed = ${x.target}% − W = ${Math.max(0, x.target - x.W)}%`),
  ];
  if (!x.parallel) lines.push(T(`结论：周已用 ${x.W}% 已经到目标，不用烧。`, `Verdict: weekly is already at ${x.W}%, nothing to burn.`));
  else if (x.doneAt) lines.push(T(`结论：能烧完。开 --parallel ${x.parallel}，约 ${hm(x.doneAt)} 烧到 ${x.target}%（比截止早 ${((x.deadline - x.doneAt) / H).toFixed(1)} 小时）。现在就开烧。`,
    `Verdict: it fits. Run --parallel ${x.parallel}; reaches ${x.target}% around ${hm(x.doneAt)}, ${((x.deadline - x.doneAt) / H).toFixed(1)} h early. Start now.`));
  else lines.push(T(`结论：烧不完。开满 --parallel ${x.parallel}，截止时周已用约 ${x.weeklyAtEnd.toFixed(0)}%。照样现在就开烧，能烧多少算多少。`,
    `Verdict: it does not fit. Run --parallel ${x.parallel}; the week ends near ${x.weeklyAtEnd.toFixed(0)}% used. Start now anyway.`));
  return lines.join("\n");
}

export function parseUntil(s, from = now()) {
  const m = /^\+(\d+(?:\.\d+)?)([hm])$/.exec(s);
  if (m) return new Date(from.getTime() + Number(m[1]) * (m[2] === "h" ? H : 60e3));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`bad time: ${s}`);
  return d;
}

// Task pool: one line per task, `- [ ] <dir> | <task>`; [~] running, [x] done, [!] failed.
const LINE = /^- \[( |~|x|!)\] (.+?) \| (.+)$/;
const readLines = () => (existsSync(F.tasks) ? readFileSync(F.tasks, "utf8").split("\n") : []);
const writeLines = (lines) => writeFileSync(F.tasks, lines.join("\n"));

function takeTask() {
  const lines = readLines();
  const i = lines.findIndex((l) => LINE.exec(l)?.[1] === " ");
  if (i < 0) return null;
  const [, , dir, task] = LINE.exec(lines[i]);
  lines[i] = `- [~] ${dir} | ${task}`;
  writeLines(lines);
  return { i, dir, task };
}

function finishTask(i, mark, note) {
  const lines = readLines();
  const [, , dir, task] = LINE.exec(lines[i]);
  lines[i] = `- [${mark}] ${dir} | ${task}  → ${note}`;
  writeLines(lines);
}

function runTask(dir, task) {
  mkdirSync(F.out, { recursive: true });
  const out = join(F.out, `${new Date().toISOString().replace(/[-:]/g, "").slice(4, 15)}-${Math.random().toString(36).slice(2, 5)}.md`);
  const prompt = `${task}\n\n${T(
    "要求：只读，不修改任何文件，不执行会改动系统或对外发消息的命令。需要上网就查一手来源并附链接，查不到就说查不到，不要编。最后交一份完整结果。",
    "Rules: read only. Do not modify files or run commands that change the system or send anything out. Cite sources for anything from the web; say so when you cannot find something. End with a complete written result.",
  )}`;
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-c", 'model_reasoning_effort="high"', "-c", 'web_search="live"',
    "-C", resolve(dir.replace(/^~(?=\/|$)/, homedir())), "-o", out, ...(MODEL ? ["-m", MODEL] : []), prompt];
  return new Promise((ok) => {
    const p = spawn(CODEX, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-400); });
    const timer = setTimeout(() => p.kill(), TASK_TIMEOUT_MS);
    p.on("error", (e) => { clearTimeout(timer); ok({ ok: false, note: e.message, out }); });
    p.on("close", (code) => {
      clearTimeout(timer);
      ok(code === 0 ? { ok: true, note: "ok", out } : { ok: false, note: `exit ${code}: ${err.trim().split("\n").pop() ?? ""}`, out });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runner(until, target, parallel, maxTasks) {
  let started = 0, done = 0, failed = 0;
  saveState({ running: true, pid: process.pid, until: until.toISOString(), target, parallel, done, failed, started_at: now().toISOString(), stop_reason: null });
  const q0 = await quota();
  saveState({ start_quota: q0 });
  log(T(`开烧，到 ${hm(until)} 为止，目标周额度 ${target}%。起点：${fmtQuota(q0)}`, `Burning until ${hm(until)}, target ${target}% weekly. Start: ${fmtQuota(q0)}`));

  // A new announcement while burning moves the deadline in state.json, so it is re-read each time.
  const stopReason = () => {
    if (existsSync(F.stop)) return T("收到 stop", "stop requested");
    if (now() >= new Date(loadState().until)) return T("到点了", "deadline reached");
    if (maxTasks && started >= maxTasks) return T(`做满 ${maxTasks} 条`, `ran ${maxTasks} task(s)`);
    return null;
  };

  async function worker() {
    for (;;) {
      const reason = stopReason();
      if (reason) return reason;
      let q;
      try { q = await quota(parallel); } catch (e) { log(T(`读额度失败：${e.message}`, `quota read failed: ${e.message}`)); await sleep(60e3); continue; }
      if (q.weekly.used >= target) return T(`周额度到 ${q.weekly.used}%`, `weekly reached ${q.weekly.used}%`);
      if (q.five_hour.used >= 99 || q.limit_reached) {
        const wake = new Date(q.five_hour.resets_at);
        if (wake >= new Date(loadState().until)) return T("5 小时窗口用满，恢复时已过截止", "five-hour window full until after the deadline");
        log(T(`5 小时窗口用满，等到 ${hm(wake)}`, `five-hour window full, waiting until ${hm(wake)}`));
        while (now() < new Date(wake.getTime() + 60e3) && !existsSync(F.stop)) await sleep(30e3);
        continue;
      }
      const t = takeTask();
      if (!t) return T("任务池空了", "task pool is empty");
      started++;
      log(T(`派活：${t.task.slice(0, 80)}`, `task: ${t.task.slice(0, 80)}`));
      const res = await runTask(t.dir, t.task);
      const rel = relative(DIR, res.out);
      finishTask(t.i, res.ok ? "x" : "!", res.ok ? rel : res.note);
      res.ok ? done++ : failed++;
      saveState({ done, failed });
      log(`${res.ok ? T("做完", "done") : T("失败", "failed")}: ${t.task.slice(0, 40)} → ${res.ok ? rel : res.note}`);
    }
  }

  const reasons = await Promise.all(Array.from({ length: parallel }, (_, i) => sleep(i * 5e3).then(worker)));
  const q1 = await quota();
  log(T(`停了（${reasons[0]}）。做完 ${done} 条，失败 ${failed} 条。现在：${fmtQuota(q1)}`, `Stopped (${reasons[0]}). ${done} done, ${failed} failed. Now: ${fmtQuota(q1)}`));
  saveState({ running: false, stop_reason: reasons[0], end_quota: q1, ended_at: now().toISOString() });
  rmSync(F.stop, { force: true });
}

function readSamples() {
  if (!existsSync(F.samples)) return [];
  return readFileSync(F.samples, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function opt(rest, name, dflt) {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : dflt;
}

async function main([cmd, ...rest]) {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(F.tasks)) writeFileSync(F.tasks, T("# 任务池：`- [ ] <目录> | <任务>`，Codex 只读跑\n\n", "# Task pool: `- [ ] <dir> | <task>`, run read-only by Codex\n\n"));
  switch (cmd) {
    case "quota": {
      const q = await quota();
      console.log(rest.includes("--json") ? JSON.stringify(q, null, 1) : fmtQuota(q));
      return 0;
    }
    case "plan": {
      const until = opt(rest, "--until");
      if (!until) return usage();
      const q = await quota();
      const { k, r } = rates(readSamples());
      console.log(fmtPlan(plan(q, { until: parseUntil(until), target: Number(opt(rest, "--target", 95)), k, r })));
      return 0;
    }
    case "add": {
      if (rest.length !== 2) return usage();
      appendFileSync(F.tasks, `- [ ] ${rest[0]} | ${rest[1].split(/\s+/).join(" ")}\n`);
      console.log(T("加好了", "added"));
      return 0;
    }
    case "tasks":
      console.log(readFileSync(F.tasks, "utf8"));
      return 0;
    case "status": {
      const st = loadState();
      const running = st.running && alive(st.pid);
      const todo = readLines().filter((l) => l.startsWith("- [ ]")).length;
      console.log(T(`${running ? "在烧" : "没在烧"}；任务池还剩 ${todo} 条`, `${running ? "burning" : "not burning"}; ${todo} task(s) left in the pool`));
      if (st.started_at) console.log(T(`上一轮：${hm(new Date(st.started_at))} 开始，截止 ${hm(new Date(st.until))}，做完 ${st.done} 条，失败 ${st.failed} 条${running ? "" : `，停止原因：${st.stop_reason}`}`,
        `Last run: started ${hm(new Date(st.started_at))}, deadline ${hm(new Date(st.until))}, ${st.done} done, ${st.failed} failed${running ? "" : `, stopped: ${st.stop_reason}`}`));
      console.log(fmtQuota(await quota()));
      if (existsSync(F.log)) console.log(readFileSync(F.log, "utf8").trim().split("\n").slice(-6).join("\n"));
      return 0;
    }
    case "stop":
      writeFileSync(F.stop, "");
      console.log(T("已通知停下，正在跑的那条做完就停", "stop requested; running tasks finish first"));
      return 0;
    case "start": {
      const u = opt(rest, "--until");
      if (!u) return usage();
      const until = parseUntil(u);
      const st = loadState();
      if (st.running && alive(st.pid)) {
        const old = new Date(st.until);
        if (until > old) {
          saveState({ until: until.toISOString() });
          log(T(`又来一条预告，截止从 ${hm(old)} 延到 ${hm(until)}`, `new announcement: deadline moved from ${hm(old)} to ${hm(until)}`));
        } else console.log(T(`已经在烧了，截止 ${hm(old)} 不变`, `already burning, deadline ${hm(old)} unchanged`));
        return 0;
      }
      if (until <= now()) { console.log(T(`截止时间 ${hm(until)} 已经过了`, `deadline ${hm(until)} has passed`)); return 1; }
      rmSync(F.stop, { force: true });
      const self = fileURLToPath(import.meta.url);
      const args = [self, "_run", until.toISOString(), opt(rest, "--target", "95"), opt(rest, "--parallel", "1"), opt(rest, "--max-tasks", "0")];
      // keep a Mac awake while burning; detach fully so an ssh caller returns at once
      let bin = process.execPath;
      if (process.platform === "darwin") { args.unshift("-i", bin); bin = "caffeinate"; }
      spawn(bin, args, { detached: true, stdio: ["ignore", "ignore", openSync(F.log, "a")], env: process.env }).unref();
      console.log(T(`开始烧了，截止 ${hm(until)}。进度看 status`, `burning until ${hm(until)}; check with status`));
      return 0;
    }
    case "_run":
      await runner(new Date(rest[0]), Number(rest[1]), Math.min(MAX_PARALLEL, Number(rest[2]) || 1), Number(rest[3]) || 0);
      return 0;
    default:
      return usage();
  }
}

function usage() {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
