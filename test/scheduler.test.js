"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, response, listing, edited, flush } = require("./helpers");
const read = { kind: "listing" };
const edit = { kind: "edit", name: "t1_test", text: "changed" };
const del = { kind: "delete", name: "t3_test" };

test("one shared queue paces reads, edits and deletes by start time with no overlap", async () => {
  const h = harness((url) => response(url === "/api/del" ? {} : url === "/api/editusertext.json" ? edited(edit.name, edit.text) : listing()));
  const jobs = [h.scheduler.request("/user/test/comments/.json", {}, read),
    h.scheduler.request("/api/editusertext.json", { text: "changed" }, edit),
    h.scheduler.request("/api/del", {}, del), h.scheduler.request("/search.json", {}, read)];
  await h.clock.advance(44999);
  assert.equal(h.calls.length, 3);
  await h.clock.advance(1); await Promise.all(jobs);
  assert.deepEqual(h.calls.map(c => c.at - h.calls[0].at), [0, 15000, 30000, 45000]);
  assert.equal(h.max(), 1);
  assert.deepEqual(h.scheduler.snapshot().counts, { requests: 4, edited: 1, deleted: 1, failed: 0, rateLimits: 0 });
});

test("jitter bounds add 0 to 5 seconds to each start interval", async () => {
  for (const value of [0, 0.5, 0.999999]) {
    const h = harness(undefined, {}, () => value);
    const jobs = [h.scheduler.request("/search.json", {}, read), h.scheduler.request("/search.json", {}, read)];
    await h.clock.advance(20000); await Promise.all(jobs);
    const gap = h.calls[1].at - h.calls[0].at;
    assert.ok(gap >= 15000 && gap <= 20000); assert.ok(Math.abs(gap - (15000 + value * 5000)) < 1);
  }
});

test("slow response bodies retain the single in-flight slot; pacing is not completion plus interval", async () => {
  const h = harness((url, init, n, clock) => ({ ...response(listing()), text: () => new Promise(resolve => clock.setTimeout(() => resolve(JSON.stringify(listing())), 25000)) }));
  const jobs = [h.scheduler.request("/search.json", {}, read), h.scheduler.request("/search.json", {}, read)];
  await h.clock.advance(24999); assert.equal(h.calls.length, 1);
  await h.clock.advance(1); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].at - h.calls[0].at, 25000);
  await h.clock.advance(25000); await Promise.all(jobs);
});

test("disabling pacing still enforces serialization and 429 pauses", async () => {
  const h = harness((url, init, n) => n === 1 ? response({}, 429) : response(listing()), { enabled: false });
  const jobs = [h.scheduler.request("/search.json", {}, read), h.scheduler.request("/search.json", {}, read)];
  await flush(); assert.equal(h.calls.length, 1); assert.equal(h.scheduler.resume(), false);
  await h.clock.advance(900000); assert.equal(h.calls.length, 1);
  assert.equal(h.scheduler.resume(), true); await flush(); await Promise.all(jobs);
  assert.equal(h.max(), 1);
});

test("HTTP 429 freezes queue, rejects early resume, never automatically resumes", async () => {
  const h = harness((url, init, n) => n === 1 ? response({}, 429, { "Retry-After": "30" }) : response(listing()));
  const jobs = [h.scheduler.request("/search.json", {}, read), h.scheduler.request("/search.json", {}, read)];
  await flush(); assert.equal(h.scheduler.snapshot().cooldownMs, 31000);
  assert.equal(h.scheduler.resume(), false);
  await h.clock.advance(30999); assert.equal(h.scheduler.resume(), false);
  await h.clock.advance(1); assert.equal(h.calls.length, 1);
  await h.clock.advance(60000); assert.equal(h.calls.length, 1);
  assert.equal(h.scheduler.resume(), true); await h.clock.advance(15000); await Promise.all(jobs);
  assert.equal(h.calls.length, 3);
});

test("Retry-After seconds and HTTP dates parse; malformed values fall back", () => {
  const h = harness(), time = h.clock.now(), parse = h.scheduler.retryAfter;
  assert.equal(parse("60", time), 60000);
  assert.equal(parse(new Date(time + 120000).toUTCString(), time), 120000);
  assert.equal(parse(new Date(time - 1000).toUTCString(), time), 0);
  for (const value of [null, "", "later", "-1", "1.5", "NaN"]) assert.equal(parse(value, time), null);
});

test("HTTP-date cooldown and Reddit reset header use the longest wait", async () => {
  const h = harness((url, init, n, clock) => n === 1 ? response({}, 429, {
    "Retry-After": new Date(clock.now() + 60000).toUTCString(),
    "X-Ratelimit-Reset": "120", "X-Ratelimit-Remaining": "0", "X-Ratelimit-Used": "100",
  }) : response(listing()));
  const job = h.scheduler.request("/search.json", {}, read);
  await flush(); assert.equal(h.scheduler.snapshot().cooldownMs, 121000);
  assert.deepEqual(h.scheduler.snapshot().rateHeaders, { reset: 120, remaining: 0, used: 100 });
  await h.clock.advance(121000); h.scheduler.resume(); await job;
});

test("successful exhausted-quota response pauses subsequent requests only", async () => {
  const h = harness((url, init, n) => response(listing(), 200, n === 1 ? { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": "20" } : {}));
  await h.scheduler.request("/search.json", {}, read);
  const job = h.scheduler.request("/search.json", {}, read);
  assert.equal(h.scheduler.snapshot().paused, true);
  await h.clock.advance(21000); assert.equal(h.calls.length, 1);
  h.scheduler.resume(); await job;
});

test("API-level RATELIMIT in HTTP 200 pauses, parses message, and permits explicit retry", async () => {
  const h = harness((url, init, n) => response(n === 1 ? { json: { errors: [["RATELIMIT", "try again in 2 minutes 3 seconds", "ratelimit"]] } } : edited(edit.name, edit.text)));
  const job = h.scheduler.request("/api/editusertext.json", {}, edit);
  await flush(); assert.equal(h.scheduler.snapshot().cooldownMs, 124000);
  assert.equal(h.scheduler.snapshot().counts.edited, 0);
  await h.clock.advance(124000); assert.equal(h.calls.length, 1);
  h.scheduler.resume(); await job;
  assert.equal(h.scheduler.snapshot().counts.edited, 1);
});

test("missing and unusable cooldown headers use configurable conservative estimate", async () => {
  for (const headers of [{}, { "Retry-After": "invalid", "X-Ratelimit-Reset": "NaN" }]) {
    const h = harness(() => response({}, 429, headers), { fallbackCooldownMs: 1200000 });
    const pending = h.scheduler.request("/search.json", {}, read);
    const rejection = assert.rejects(pending, { kind: "cancelled" });
    await flush(); assert.equal(h.scheduler.snapshot().cooldownMs, 1200000);
    assert.equal(h.scheduler.snapshot().estimated, true);
    h.scheduler.cancel(); await rejection;
  }
});

test("repeated 429s require a new manual cooldown/resume for every attempt", async () => {
  const h = harness(() => response({}, 429, { "Retry-After": "1" }));
  const pending = h.scheduler.request("/search.json", {}, read);
  const rejection = assert.rejects(pending, { kind: "cancelled" });
  await h.clock.advance(100000); assert.equal(h.calls.length, 1);
  h.scheduler.resume(); await h.clock.advance(100000); assert.equal(h.calls.length, 2);
  assert.equal(h.scheduler.snapshot().paused, true);
  h.scheduler.cancel(); await rejection;
});

test("Stop cancels queued requests and rejects future requests while waiting or paused", async () => {
  for (const rateLimited of [false, true]) {
    const h = harness(() => rateLimited ? response({}, 429) : response(listing()));
    const first = h.scheduler.request("/search.json", {}, read);
    const second = h.scheduler.request("/search.json", {}, read);
    const checks = [first, second].map(job => job.catch(e => e));
    await flush(); h.scheduler.cancel(); await Promise.all(checks);
    await h.clock.advance(1000000); assert.equal(h.calls.length, 1);
    assert.equal(h.scheduler.resume(), false);
    await assert.rejects(h.scheduler.request("/search.json", {}, read), { kind: "cancelled" });
  }
});

test("Stop aborts in-flight request and ignores late success and late 429", async () => {
  for (const late of [response(listing()), response({}, 429)]) {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    const job = h.scheduler.request("/search.json", {}, read);
    const check = assert.rejects(job, { kind: "cancelled" });
    h.scheduler.cancel(); assert.equal(h.calls[0].init.signal.aborted, true);
    release(late); await check; await flush(); await h.clock.advance(1000000);
    assert.equal(h.calls.length, 1); assert.equal(h.scheduler.snapshot().queued, 0);
  }
});

test("read network and HTTP 5xx retries are bounded and globally paced", async () => {
  for (const failure of [() => { throw new TypeError("offline"); }, () => response({}, 503)]) {
    const h = harness(failure);
    const job = h.scheduler.request("/search.json", {}, read);
    const check = assert.rejects(job);
    await h.clock.advance(100000); await check;
    assert.equal(h.calls.length, 3); assert.equal(h.scheduler.snapshot().status, "Failed");
    assert.deepEqual(h.calls.map(c => c.at - h.calls[0].at), [0, 15000, 30000]);
  }
});

test("read exponential backoff remains effective with global pacing disabled", async () => {
  const h = harness(() => response({}, 503), { enabled: false });
  const check = assert.rejects(h.scheduler.request("/search.json", {}, read));
  await h.clock.advance(6000); await check;
  assert.deepEqual(h.calls.map(c => c.at - h.calls[0].at), [0, 2000, 6000]);
});

test("HTTP 403, API authentication errors and malformed listings fail without skipping/retrying", async () => {
  for (const reply of [response({}, 403), response({ json: { errors: [["BAD_CSRF", "invalid modhash"]] } }),
    response("<html>login</html>"), response({ data: { children: "invalid" } }), response({ error: 401, message: "Unauthorized" }),
    response({ data: { children: [{ kind: "t3", data: {} }], after: null } }), response({ success: false })]) {
    const h = harness(() => reply);
    await assert.rejects(h.scheduler.request("/search.json", {}, read));
    assert.equal(h.calls.length, 1); assert.equal(h.scheduler.snapshot().counts.failed, 1);
  }
});

test("destructive network, 5xx, API errors and ambiguous acknowledgements are never retried or counted", async () => {
  for (const spec of [edit, del]) {
    for (const reply of [() => { throw new Error("offline"); }, () => response({}, 503),
      () => response(""), () => response({ unexpected: true }), () => response({ json: { errors: [["DELETED", "already deleted"]] } })]) {
      const h = harness(reply);
      await assert.rejects(h.scheduler.request(spec.kind === "edit" ? "/api/editusertext.json" : "/api/del", {}, spec));
      await h.clock.advance(100000);
      assert.equal(h.calls.length, 1);
      assert.equal(h.scheduler.snapshot().counts.edited + h.scheduler.snapshot().counts.deleted, 0);
    }
  }
});

test("edit acknowledgement must match both fullname and expected text", async () => {
  for (const body of [edited("t1_other", "changed"), edited(edit.name, "different"), { json: { errors: [] } }, {}]) {
    const h = harness(() => response(body));
    await assert.rejects(h.scheduler.request("/api/editusertext.json", {}, edit), { kind: "ambiguous" });
  }
});

test("modhash is required at dispatch and sent in both header and uh form field", async () => {
  const h = harness(() => response({}));
  await h.scheduler.request("/api/del", { id: del.name }, del);
  assert.equal(h.calls[0].init.headers["X-Modhash"], "fixture-modhash");
  assert.equal(new URLSearchParams(h.calls[0].init.body).get("uh"), "fixture-modhash");
  assert.equal(new URLSearchParams(h.calls[0].init.body).get("api_type"), "json");
  const create = require("../src/scheduler");
  const blocked = create({}, { ...h.deps, getModhash: () => "" });
  await assert.rejects(blocked.request("/api/del", {}, del), { kind: "auth" });
  assert.equal(h.calls.length, 1);
});

test("invalid settings and non-Reddit URLs are rejected; GitHub is never queued", async () => {
  const h = harness();
  for (const values of [{ intervalMs: -1 }, { jitterMs: NaN }, { fallbackCooldownMs: 0 }, { timeoutMs: Infinity }, { maxReadRetries: 100 }]) {
    assert.throws(() => h.scheduler.configure(values));
  }
  for (const url of ["https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/powerdeletesuite.js", "//example.com", "/api/del?x=1"]) {
    await assert.rejects(h.scheduler.request(url, {}, read), { kind: "url" });
  }
  assert.equal(h.calls.length, 0);
});

test("persisted cooldown survives reload and Stop; expired cooldown still needs explicit Resume", async () => {
  const create = require("../src/scheduler");
  const h = harness(() => response({}, 429, { "Retry-After": "60" }));
  let saved = null;
  const deps = { ...h.deps, loadCooldown: () => saved, saveCooldown: value => { saved = value; } };
  const first = create({}, deps);
  const failed = assert.rejects(first.request("/search.json", {}, read), { kind: "cancelled" });
  await flush(); first.cancel(); await failed;
  const second = create({}, { ...deps, fetch: async () => response(listing()) });
  const pending = second.request("/search.json", {}, read);
  assert.equal(second.resume(), false);
  await h.clock.advance(61000);
  assert.equal(second.snapshot().paused, true);
  assert.equal(second.resume(), true); await pending;
  assert.equal(saved, null);
});

test("read timeout retries are bounded; a timed out mutation never retries", async () => {
  for (const spec of [read, del]) {
    const h = harness((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const check = assert.rejects(h.scheduler.request(spec.kind === "delete" ? "/api/del" : "/search.json", {}, spec));
    await h.clock.advance(200000); await check;
    assert.equal(h.calls.length, spec.kind === "delete" ? 1 : 3);
    assert.match(h.scheduler.snapshot().lastError, /timed out/);
  }
});

test("429 closes its unread response stream before releasing the in-flight slot", async () => {
  let closed = false;
  const h = harness(() => ({ ...response({}, 429, { "Retry-After": "1" }), body: { cancel: async () => { closed = true; } } }));
  const check = assert.rejects(h.scheduler.request("/search.json", {}, read), { kind: "cancelled" });
  await flush(); assert.equal(closed, true);
  assert.equal(h.scheduler.snapshot().inFlight, false);
  h.scheduler.cancel(); await check;
});
