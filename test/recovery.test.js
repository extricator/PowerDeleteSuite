"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, mutationReply } = require("./app-fixture");
const { response, listing, item } = require("./helpers");

function attachRecovery(a) {
  a.win.setTimeout = a.clock.setTimeout;
  a.win.clearTimeout = a.clock.clearTimeout;
  a.win.eval(fs.readFileSync(path.join(__dirname, "../src/recovery.js"), "utf8"));
  return a.pd.recovery;
}

test("built-in 403 recovery never replays completed edits or loses exports", async () => {
  let reject = true;
  const a = app((url, init) => {
    if (url.startsWith("/api/")) {
      if (new URLSearchParams(init.body).get("thing_id") === "t1_blocked" && reject) return response({ error: 403, message: "Forbidden" }, 403);
      return mutationReply(url, init);
    }
    return response(new URL(url, "https://old.reddit.com").searchParams.get("sort") === "new"
      && url.includes("/comments/") ? listing([item("t1", "completed"), item("t1", "blocked"), item("t1", "pending")]) : listing());
  }, { edit: true, export: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a);
  assert.equal(a.$("#pd__retry-failed").length, 1);
  assert.equal(attachRecovery(a), recovery);
  const before = a.calls.length;
  a.win.confirm = () => false;
  assert.equal(recovery.retry(), false); assert.equal(a.calls.length, before);
  a.win.confirm = () => true; reject = false;
  assert.equal(recovery.retry(), true);
  assert.equal(recovery.retry(), false);
  await a.clock.advance(19999); assert.equal(a.calls.length, before);
  await a.clock.advance(1000000);
  const edits = a.calls.filter(c => c.url === "/api/editusertext.json").map(c => new URLSearchParams(c.init.body).get("thing_id"));
  assert.deepEqual(edits, ["t1_completed", "t1_blocked", "t1_blocked", "t1_pending"]);
  assert.equal(a.completed(), true); assert.equal(a.pd.task.info.edited, 3);
  assert.equal(a.pd.task.info.exported, 3);
  assert.match(a.$("#pd__rate-status").text(), /Edited: 3.*Failed: 1/);
  assert.equal(recovery.report()[0].action, "retry"); a.dom.window.close();
});

test("explicitly skipping a rejected edit never deletes it or retries it across discovery sorts", async () => {
  const a = app((url, init) => {
    if (url.startsWith("/api/")) {
      if (new URLSearchParams(init.body).get("thing_id") === "t1_blocked") return response({}, 403);
      return mutationReply(url, init);
    }
    return response(listing([item("t1", "blocked"), item("t1", "pending")]));
  }, { edit: true, comments: true, export: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a);
  assert.equal(recovery.skip(), true); await a.clock.advance(1000000);
  assert.equal(a.completed(), true);
  const mutations = a.calls.filter(c => c.url.startsWith("/api/"));
  assert.equal(mutations.filter(c => new URLSearchParams(c.init.body).get("thing_id") === "t1_blocked").length, 1);
  assert.equal(mutations.filter(c => new URLSearchParams(c.init.body).get("id") === "t1_blocked").length, 0);
  assert.equal(a.pd.task.info.edited, 1); assert.equal(a.pd.task.info.deleted, 1);
  assert.equal(a.pd.task.info.errors, 1); assert.equal(a.pd.task.info.exported, 2);
  assert.equal(a.pd.confirmed.t1_blocked, undefined);
  assert.equal(recovery.report()[0].name, "t1_blocked");
  assert.equal(recovery.report()[0].action, "skip");
  assert.match(a.$("#pd__recovery").text(), /Explicitly skipped items: 1/);
  a.dom.window.close();
});

test("repeated 403 recovery stops again and never retries automatically", async () => {
  const a = app(url => url.startsWith("/api/") ? response({}, 403) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a);
  assert.equal(recovery.retry(), true); await a.clock.advance(1000000);
  assert.equal(a.win.pd_processing, false); assert.equal(a.completed(), false);
  assert.equal(a.calls.filter(c => c.url.startsWith("/api/")).length, 2);
  assert.equal(a.$("#pd__retry-failed").length, 1);
  assert.match(a.$("#pd__rate-status").text(), /Failed/);
  const count = a.calls.length; await a.clock.advance(1000000); assert.equal(a.calls.length, count);
  a.dom.window.close();
});

test("403 listing recovery retries the same page without skipping pagination or actions", async () => {
  const a = app((url, init, n) => n === 1 ? response({}, 403) : response(listing()), { posts: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a);
  assert.equal(a.$("#pd__skip-failed").length, 0); assert.equal(recovery.skip(), false);
  assert.equal(recovery.retry(), true); await a.clock.advance(1000000);
  assert.equal(a.calls[1].url, a.calls[0].url); assert.equal(a.completed(), true);
  assert.equal(a.calls.filter(c => c.url.startsWith("/api/")).length, 0); a.dom.window.close();
});

test("recovery refuses ambiguous writes and prevents account or modhash changes from authorizing mutations", async () => {
  const ambiguous = app(url => url.startsWith("/api/") ? response({}) : response(listing([item()])), { edit: true });
  ambiguous.pd.actions.page.next(); await ambiguous.clock.advance(100000);
  const unsafe = attachRecovery(ambiguous);
  assert.equal(unsafe.retry(), false); assert.equal(unsafe.skip(), false);
  assert.equal(ambiguous.$("#pd__retry-failed").length, 0); ambiguous.dom.window.close();
  const a = app(url => url.startsWith("/api/") ? response({}, 403) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a), count = a.calls.length;
  a.win.r = undefined; assert.equal(recovery.retry(), false);
  a.win.r = { config: { modhash: "new-valid-modhash" } };
  a.$("#header-bottom-right .user a").text("different-user"); assert.equal(recovery.retry(), false);
  await a.clock.advance(100000); assert.equal(a.calls.length, count); a.dom.window.close();
});

test("recovery cannot bypass a cooldown saved since the failed request", async () => {
  const a = app(url => url.startsWith("/api/") ? response({}, 403) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a), oldApi = a.pd.api, count = a.calls.length;
  a.win.localStorage.setItem("pd_rate_limit_v2", JSON.stringify({ until: a.clock.now() + 60000, estimated: false }));
  assert.equal(recovery.retry(), false); assert.equal(a.pd.api, oldApi);
  await a.clock.advance(60000); assert.equal(a.calls.length, count);
  assert.equal(recovery.retry(), true); a.$("#pd__stop").trigger("click");
  await a.clock.advance(100000); assert.equal(a.calls.length, count);
  a.dom.window.close();
});

test("Stop during recovery spacing prevents the rejected operation from starting", async () => {
  const a = app(url => url.startsWith("/api/") ? response({}, 403) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a), count = a.calls.length;
  assert.equal(recovery.retry(), true); a.$("#pd__stop").trigger("click");
  await a.clock.advance(1000000); assert.equal(a.calls.length, count);
  assert.equal(a.win.pd_processing, false); assert.equal(recovery.retry(), false);
  assert.match(a.$("#pd__rate-status").text(), /Cancelled/); a.dom.window.close();
});

test("retrying a rejected delete retains its confirmed edit and never edits it again", async () => {
  let reject = true;
  const a = app((url, init) => {
    if (url === "/api/del" && reject) return response({}, 403);
    if (url.startsWith("/api/")) return mutationReply(url, init);
    return response(listing([item("t3", "post")]));
  }, { edit: true, posts: true, export: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  assert.equal(a.pd.confirmed.t3_post.edited, true);
  const recovery = attachRecovery(a); reject = false;
  assert.equal(recovery.retry(), true); await a.clock.advance(1000000);
  assert.equal(a.completed(), true);
  assert.equal(a.calls.filter(c => c.url === "/api/editusertext.json").length, 1);
  assert.equal(a.calls.filter(c => c.url === "/api/del").length, 2);
  assert.equal(a.pd.task.info.edited, 1); assert.equal(a.pd.task.info.deleted, 1);
  assert.equal(a.pd.task.info.exported, 1); a.dom.window.close();
});

test("403 interface reads expose explicit retry and never enable skipping", async () => {
  const a = app((url, init, n) => n === 1 ? response({}, 403) : response({ data: { content_md: '<h2></h2><form id="pd__form"></form>' } }));
  delete a.pd.task; a.win.pd_processing = false;
  const recovery = attachRecovery(a);
  a.pd.setup.applyCentral(); await a.clock.advance(100000);
  assert.equal(a.$("#pd__retry-failed").length, 1); assert.equal(recovery.skip(), false);
  assert.equal(recovery.retry(), true); await a.clock.advance(20000);
  assert.equal(a.calls.length, 2); assert.equal(a.calls[1].url, a.calls[0].url);
  assert.equal(a.pd.api.snapshot().terminal, false); assert.equal(a.$("#pd__form").length, 1);
  a.dom.window.close();
});

test("new runs clear explicitly skipped items and recovery logs", async () => {
  const a = app(url => url.startsWith("/api/") ? response({}, 403) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  const recovery = attachRecovery(a); assert.equal(recovery.skip(), true);
  await a.clock.advance(1000000); assert.equal(a.completed(), true);
  assert.equal(a.pd.helpers.shouldBeActedOn(item()), false);
  a.pd.setup.createProcessStream();
  assert.equal(recovery.report().length, 0); assert.equal(a.pd.helpers.shouldBeActedOn(item()), true);
  a.dom.window.close();
});
