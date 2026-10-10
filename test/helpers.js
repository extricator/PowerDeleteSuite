"use strict";
const assert = require("node:assert/strict");
const createScheduler = require("../src/scheduler");
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fakeClock() {
  let time = Date.UTC(2026, 0, 1), id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { at: time + Math.max(0, delay), fn }); return key; },
    clearTimeout: key => timers.delete(key),
    async advance(ms) {
      await flush();
      const end = time + ms;
      let steps = 0;
      while (true) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
        if (!entry) break;
        assert.ok(++steps < 10000, "No busy loops");
        time = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
      }
      time = end; await flush();
    },
    timers,
  };
}
function response(body = {}, status = 200, headers = {}) {
  return { status, ok: status >= 200 && status < 300, statusText: status === 403 ? "Forbidden" : "Response",
    headers: new Headers(headers), text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}
function listing(children = [], after = null) { return { data: { children, after } }; }
function item(kind = "t1", id = "test") {
  return { kind, data: { name: kind + "_" + id, id, body: kind === "t1" ? "original" : undefined,
    selftext: kind === "t3" ? "original" : undefined, is_self: kind === "t3", subreddit: "example",
    title: "Test", score: 10, created_utc: 100, permalink: "/r/example/comments/test", saved: false, gilded: 0, distinguished: null } };
}
function edited(name, text) { return { json: { errors: [], data: { things: [{ data: { name, body: text } }] } } }; }
function harness(reply = () => response(listing()), settings = {}, random = () => 0) {
  const clock = fakeClock(), calls = [], states = [];
  let simultaneous = 0, max = 0;
  const deps = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random,
    getModhash: () => "fixture-modhash", onState: state => states.push(state),
    fetch: async (url, init) => {
      calls.push({ url, init, at: clock.now() });
      max = Math.max(max, ++simultaneous);
      try { return await reply(url, init, calls.length, clock); } finally { simultaneous--; }
    },
  };
  const scheduler = createScheduler(settings, deps);
  return { clock, calls, states, deps, scheduler, max: () => max };
}
module.exports = { fakeClock, response, listing, item, edited, harness, flush };
