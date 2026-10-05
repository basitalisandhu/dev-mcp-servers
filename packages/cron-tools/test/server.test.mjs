import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { explainCron, localParts, matches, nextRuns, previousRuns, parseCron, validateCron, wallToUtc } from "../dist/cron.js";

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("lists the five tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["explain_cron", "next_runs", "parse_cron", "previous_runs", "validate_cron"]);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("parse_cron expands lists, ranges, steps, names and macros", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "parse_cron", arguments: { expression: "*/15 9-17 1,15 jan-mar mon-fri" } }));
    assert.deepEqual(r.fields.minute.values, [0, 15, 30, 45]);
    assert.deepEqual(r.fields.hour.values, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
    assert.deepEqual(r.fields.day_of_month.values, [1, 15]);
    assert.deepEqual(r.fields.month.values, [1, 2, 3]);
    assert.deepEqual(r.fields.day_of_week.values, [1, 2, 3, 4, 5]);
    assert.equal(r.fields.minute.wildcard, false);
    const macro = parse(await client.callTool({ name: "parse_cron", arguments: { expression: "@weekly" } }));
    assert.equal(macro.normalised, "0 0 * * 0");
    assert.equal(macro.macro, "@weekly");
    const sunday = parseCron("0 0 * * 7");
    assert.deepEqual(sunday.fields.day_of_week.values, [0]);
    assert.deepEqual(parseCron("5/20 * * * *").fields.minute.values, [5, 25, 45]);
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "a * * * *", "0 0 L * *", "@reboot", "1-5-7 * * * *", "0 0 * * 1#2", "* * * * * *"]) {
      const r = await client.callTool({ name: "parse_cron", arguments: { expression: bad } });
      assert.equal(r.isError, true, bad);
    }
  } finally {
    await close();
  }
});

test("explain_cron produces readable sentences", async () => {
  const cases = [
    ["* * * * *", "Every minute."],
    ["*/5 * * * *", "Every 5 minutes."],
    ["30 9 * * *", "At 09:30."],
    ["0 9,17 * * *", "At 09:00 and 17:00."],
    ["0,30 9 * * *", "At 09:00 and 09:30."],
    ["*/15 9-17 * * 1-5", "At every 15th minute past every hour from 9 through 17 on Monday through Friday."],
    ["0 0 1 * *", "At 00:00 on day-of-month 1."],
    ["0 0 1,15 * 1", "At 00:00 on day-of-months 1 and 15 or on Monday."],
    ["0 12 * jan,jul *", "At 12:00 in January and July."],
    ["5 * * * *", "At minute 5 past every hour."],
    ["* 9 * * *", "Every minute of hour 9."],
    ["0 */6 * * *", "At minute 0 past every 6th hour."],
    ["@daily", "At 00:00."],
  ];
  for (const [expr, expected] of cases) assert.equal(explainCron(expr), expected, expr);
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "explain_cron", arguments: { expression: "0 0 1,15 * 1" } }));
    assert.equal(r.explanation, "At 00:00 on day-of-months 1 and 15 or on Monday.");
    assert.ok(r.warnings.some((w) => /EITHER/.test(w)));
    const bad = await client.callTool({ name: "explain_cron", arguments: { expression: "nope" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("validate_cron reports errors and warnings", async () => {
  const { client, close } = await connected();
  try {
    const ok = parse(await client.callTool({ name: "validate_cron", arguments: { expression: "0 9 * * 1-5" } }));
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.warnings, []);
    const never = parse(await client.callTool({ name: "validate_cron", arguments: { expression: "0 0 31 2,4 *" } }));
    assert.equal(never.valid, true);
    assert.ok(never.warnings.some((w) => /never runs/.test(w)));
    const short = validateCron("0 0 31 * *");
    assert.ok(short.warnings.some((w) => /shorter months/.test(w)));
    const bad = parse(await client.callTool({ name: "validate_cron", arguments: { expression: "0 0 * * 1,2,9" } }));
    assert.equal(bad.valid, false);
    assert.match(bad.errors[0], /outside 0-6/);
    const seven = validateCron("0 0 * * 7");
    assert.ok(seven.warnings.some((w) => /7 was used/.test(w)));
    const q = validateCron("0 0 ? * MON");
    assert.ok(q.valid && q.warnings.some((w) => /Quartz/.test(w)));
  } finally {
    await close();
  }
});

test("next_runs honours time zones, DST and the horizon", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "next_runs", arguments: { expression: "30 9 * * 1-5", timezone: "Europe/Berlin", from: "2026-03-27T12:00:00Z", count: 3 } }));
    assert.deepEqual(r.runs.map((x) => x.local), ["2026-03-30T09:30:00+02:00", "2026-03-31T09:30:00+02:00", "2026-04-01T09:30:00+02:00"]);
    assert.deepEqual(r.runs.map((x) => x.utc), ["2026-03-30T07:30:00.000Z", "2026-03-31T07:30:00.000Z", "2026-04-01T07:30:00.000Z"]);
    assert.deepEqual(r.runs.map((x) => x.weekday), ["Monday", "Tuesday", "Wednesday"]);

    // 02:30 does not exist on 2026-03-29 in Berlin (clocks jump from 02:00 to 03:00), so the run is skipped that day.
    const gap = nextRuns(parseCron("30 2 * * *"), Date.parse("2026-03-28T12:00:00Z"), "Europe/Berlin", 2);
    assert.deepEqual(gap.map((ms) => new Date(ms).toISOString()), ["2026-03-30T00:30:00.000Z", "2026-03-31T00:30:00.000Z"]);

    // 02:30 happens twice on 2026-10-25 in Berlin.
    const twice = nextRuns(parseCron("30 2 * * *"), Date.parse("2026-10-24T12:00:00Z"), "Europe/Berlin", 2);
    assert.deepEqual(twice.map((ms) => new Date(ms).toISOString()), ["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);

    // Hourly across the US fall-back transition keeps one run per real hour.
    const hourly = nextRuns(parseCron("0 * * * *"), Date.parse("2026-11-01T04:30:00Z"), "America/New_York", 4);
    assert.deepEqual(hourly.map((ms) => new Date(ms).toISOString()), ["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"]);

    const utc = parse(await client.callTool({ name: "next_runs", arguments: { expression: "0 0 29 2 *", from: "2026-01-01T00:00:00Z", count: 2 } }));
    assert.deepEqual(utc.runs.map((x) => x.utc), ["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
    const never = parse(await client.callTool({ name: "next_runs", arguments: { expression: "0 0 31 2 *", from: "2026-01-01T00:00:00Z" } }));
    assert.equal(never.found, 0);
    assert.match(never.note, /No run within ten years/);
    const kolkata = parse(await client.callTool({ name: "next_runs", arguments: { expression: "0 0 * * *", timezone: "Asia/Kolkata", from: "2026-06-01T00:00:00Z", count: 1 } }));
    assert.equal(kolkata.runs[0].local, "2026-06-02T00:00:00+05:30");
    assert.equal(kolkata.runs[0].utc, "2026-06-01T18:30:00.000Z");
    assert.equal(wallToUtc(Date.UTC(2026, 5, 2, 0, 0), "Asia/Kolkata"), Date.parse("2026-06-01T18:30:00Z"));

    const badTz = await client.callTool({ name: "next_runs", arguments: { expression: "* * * * *", timezone: "Mars/Olympus" } });
    assert.equal(badTz.isError, true);
    const badFrom = await client.callTool({ name: "next_runs", arguments: { expression: "* * * * *", from: "yesterday" } });
    assert.equal(badFrom.isError, true);
    const defaults = parse(await client.callTool({ name: "next_runs", arguments: { expression: "* * * * *" } }));
    assert.equal(defaults.runs.length, 5);
    assert.ok(Date.parse(defaults.runs[0].utc) > Date.now() - 60_000);
  } finally {
    await close();
  }
});

test("previous_runs is strictly before from, newest first, with DST and a bounded horizon", async () => {
  const { client, close } = await connected();
  try {
    const previous = async (expression, from, timezone = "UTC", count = 2) =>
      parse(await client.callTool({ name: "previous_runs", arguments: { expression, from, timezone, count } }));
    const weekend = await previous("30 9 * * 1-5", "2026-03-30T07:30:00Z", "Europe/Berlin", 3);
    assert.deepEqual(weekend.runs.map((r) => r.utc), ["2026-03-27T08:30:00.000Z", "2026-03-26T08:30:00.000Z", "2026-03-25T08:30:00.000Z"]);
    const gap = await previous("30 2 * * *", "2026-03-30T00:30:00Z", "Europe/Berlin");
    assert.deepEqual(gap.runs.map((r) => r.utc), ["2026-03-28T01:30:00.000Z", "2026-03-27T01:30:00.000Z"]);
    const overlap = await previous("30 2 * * *", "2026-10-25T03:00:00Z", "Europe/Berlin");
    assert.deepEqual(overlap.runs.map((r) => r.utc), ["2026-10-25T01:30:00.000Z", "2026-10-25T00:30:00.000Z"]);
    assert.deepEqual(overlap.runs.map((r) => r.local), ["2026-10-25T02:30:00+01:00", "2026-10-25T02:30:00+02:00"]);
    const chatham = await previous("30 2 * * *", "2026-09-26T14:00:30Z", "Pacific/Chatham", 1);
    assert.equal(chatham.runs[0].utc, "2026-09-26T13:45:00.000Z");
    const boundary = await previous("* * * * *", "2026-01-01T00:00:30Z", "UTC", 1);
    assert.equal(boundary.runs[0].utc, "2026-01-01T00:00:00.000Z");
    const leap = await previous("0 0 29 2 *", "2026-01-01T00:00:00Z");
    assert.deepEqual(leap.runs.map((r) => r.utc), ["2024-02-29T00:00:00.000Z", "2020-02-29T00:00:00.000Z"]);
    const never = await previous("0 0 31 2 *", "2026-01-01T00:00:00Z");
    assert.equal(never.found, 0);
    assert.match(never.note, /No run within ten years/);
    const bad = await client.callTool({ name: "previous_runs", arguments: { expression: "* * * * *", count: 101 } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("optimized previous runs agree with an independent minute scan", () => {
  for (const [zone, from] of [
    ["Europe/Berlin", "2026-10-26T12:00:30Z"],
    ["Europe/Berlin", "2026-03-30T12:00:30Z"],
    ["Asia/Kolkata", "2026-04-01T12:00:30Z"],
    ["Pacific/Chatham", "2026-09-26T14:00:30Z"],
    ["Australia/Lord_Howe", "2026-10-03T16:00:30Z"],
    ["Asia/Kathmandu", "2026-04-01T12:00:30Z"],
    ["America/New_York", "2026-11-01T08:00:30Z"],
    ["America/Santiago", "2026-09-06T06:00:30Z"],
  ]) {
    const fromMs = Date.parse(from);
    for (const expression of ["*/17 * * * *", "30 2 * * *", "0 9 * * 1-5", "0 0 1 * mon"]) {
      const parsed = parseCron(expression);
      const expected = [];
      for (let t = Math.ceil(fromMs / 60_000) * 60_000 - 60_000; t >= fromMs - 3 * 86400_000 && expected.length < 5; t -= 60_000) {
        if (matches(localParts(t, zone), parsed)) expected.push(t);
      }
      assert.deepEqual(previousRuns(parsed, fromMs, zone, expected.length), expected, `${zone}: ${expression}`);
    }
  }
});
