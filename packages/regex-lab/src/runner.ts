/**
 * Runs a regular expression in a worker thread so that a pathological pattern can be stopped by
 * terminating the worker. Regular expression execution cannot be interrupted on the main thread.
 */
import { Worker } from "node:worker_threads";

export const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_TIMEOUT_MS = 10_000;
export const MAX_MATCHES_PER_SAMPLE = 200;

export interface MatchGroup {
  index: number | string;
  value: string | null;
  start: number | null;
  end: number | null;
}

export interface SampleResult {
  sample: string;
  matched: boolean;
  match_count: number;
  truncated: boolean;
  matches: { start: number; end: number; text: string; groups: MatchGroup[] }[];
  replaced?: string;
}

export interface RunOutcome {
  timed_out: boolean;
  elapsed_ms: number;
  error?: string;
  results: SampleResult[];
}

export interface ProbeOutcome {
  timed_out: boolean;
  elapsed_ms: number;
  error?: string;
  timings: { length: number; ms: number; matched: boolean }[];
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
function main() {
  const { mode, pattern, flags, samples, replacement, maxMatches, inputs } = workerData;
  let re;
  try {
    re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    if (!flags.includes("d")) re = new RegExp(pattern, re.flags + "d");
  } catch (e) {
    parentPort.postMessage({ type: "error", message: String(e && e.message || e) });
    return;
  }
  if (mode === "probe") {
    for (const input of inputs) {
      const t0 = performance.now();
      const matched = new RegExp(pattern, flags).test(input);
      parentPort.postMessage({ type: "probe", length: input.length, ms: Math.round((performance.now() - t0) * 100) / 100, matched });
    }
    parentPort.postMessage({ type: "done" });
    return;
  }
  const results = [];
  for (const sample of samples) {
    re.lastIndex = 0;
    const matches = [];
    let truncated = false;
    let m;
    while ((m = re.exec(sample)) !== null) {
      if (matches.length >= maxMatches) { truncated = true; break; }
      const groups = [];
      for (let g = 1; g < m.length; g++) {
        const idx = m.indices && m.indices[g];
        groups.push({ index: g, value: m[g] === undefined ? null : m[g], start: idx ? idx[0] : null, end: idx ? idx[1] : null });
      }
      if (m.groups) {
        for (const name of Object.keys(m.groups)) {
          const idx = m.indices && m.indices.groups && m.indices.groups[name];
          groups.push({ index: name, value: m.groups[name] === undefined ? null : m.groups[name], start: idx ? idx[0] : null, end: idx ? idx[1] : null });
        }
      }
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], groups });
      if (m[0].length === 0) re.lastIndex++;
    }
    const entry = { sample, matched: matches.length > 0, match_count: matches.length, truncated, matches };
    if (replacement !== undefined) {
      try { entry.replaced = sample.replace(new RegExp(pattern, flags), replacement); } catch (e) { entry.replaced = "replace failed: " + String(e && e.message || e); }
    }
    results.push(entry);
    parentPort.postMessage({ type: "partial", result: entry });
  }
  parentPort.postMessage({ type: "done" });
}
main();
`;

function spawn(data: Record<string, unknown>, timeoutMs: number, onMessage: (msg: Record<string, unknown>) => void): Promise<{ timedOut: boolean; error?: string; elapsed: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 } });
    let settled = false;
    const finish = (out: { timedOut: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...out, elapsed: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    worker.on("message", (msg: Record<string, unknown>) => {
      if (msg.type === "error") finish({ timedOut: false, error: String(msg.message) });
      else if (msg.type === "done") finish({ timedOut: false });
      else onMessage(msg);
    });
    worker.on("error", (err) => finish({ timedOut: false, error: err.message }));
    worker.on("exit", (code) => {
      if (!settled) finish({ timedOut: false, error: code === 0 ? undefined : `worker exited with code ${code}` });
    });
  });
}

export async function runRegex(pattern: string, flags: string, samples: string[], options: { timeoutMs?: number; replacement?: string; maxMatches?: number } = {}): Promise<RunOutcome> {
  const results: SampleResult[] = [];
  const out = await spawn(
    { mode: "test", pattern, flags, samples, replacement: options.replacement, maxMatches: Math.min(options.maxMatches ?? MAX_MATCHES_PER_SAMPLE, MAX_MATCHES_PER_SAMPLE) },
    Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    (msg) => {
      if (msg.type === "partial") results.push(msg.result as SampleResult);
    },
  );
  return { timed_out: out.timedOut, elapsed_ms: out.elapsed, error: out.error, results };
}

export async function probeRegex(pattern: string, flags: string, inputs: string[], timeoutMs: number): Promise<ProbeOutcome> {
  const timings: ProbeOutcome["timings"] = [];
  const out = await spawn({ mode: "probe", pattern, flags, inputs }, Math.min(timeoutMs, MAX_TIMEOUT_MS), (msg) => {
    if (msg.type === "probe") timings.push({ length: msg.length as number, ms: msg.ms as number, matched: msg.matched as boolean });
  });
  return { timed_out: out.timedOut, elapsed_ms: out.elapsed, error: out.error, timings };
}
