"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const jquery = require("jquery");
const { harness, response, listing, item, flush } = require("./helpers");
const { app, mutationReply } = require("./app-fixture");

test("discovery starts with submissions without comment actions and retains comments for exports", async () => {
  for (let selection = 1; selection < 16; selection++) {
    const opts = { posts: !!(selection & 1), comments: !!(selection & 2), edit: !!(selection & 4), export: !!(selection & 8) };
    const a = app(() => response(listing()), opts);
    a.pd.actions.page.next(); await a.clock.advance(1000000);
    const context = JSON.stringify(opts);
    assert.equal(a.completed(), true, context);
    assert.ok(a.calls[0].url.includes(opts.comments || opts.edit ? "/comments/" : "/submitted/"), context);
    assert.equal(a.calls.some(c => c.url.includes("/comments/")), opts.comments || opts.edit || opts.export, context);
    assert.ok(a.calls.some(c => c.url.includes("/submitted/")), context);
    assert.equal(a.calls.filter(c => c.url.startsWith("/search.json")).length, 14, context);
    a.dom.window.close();
  }
});

test("submission-only deletion starts immediately, paginates and searches without editing or deleting comments", async () => {
  const a = app((url, init) => {
    if (url.startsWith("/api/")) return mutationReply(url, init);
    const parsed = new URL(url, "https://old.reddit.com");
    if (url.includes("/comments/")) throw new Error("Submission-only runs must not scan comments");
    if (parsed.searchParams.get("sort") !== "new") return response(listing());
    if (url.includes("/submitted/")) {
      if (!parsed.searchParams.get("after")) return response(listing([item("t3", "self")], "t3_self"));
      const link = item("t3", "link"); link.data.is_self = false;
      return response(listing([link]));
    }
    // Only submission deletion is authorized, even if a listing includes a comment.
    return response(listing([item("t1", "comment"), item("t3", "search")]));
  }, { posts: true });
  a.pd.actions.page.next(); await a.clock.advance(1000000);
  assert.equal(a.completed(), true);
  assert.match(a.calls[0].url, /\/submitted\//);
  const mutations = a.calls.filter(c => c.url.startsWith("/api/"));
  assert.deepEqual(mutations.map(c => c.url), ["/api/del", "/api/del", "/api/del"]);
  assert.deepEqual(mutations.map(c => new URLSearchParams(c.init.body).get("id")), ["t3_self", "t3_link", "t3_search"]);
  const pages = a.calls.filter(c => c.url.includes("/submitted/") && new URL(c.url, "https://old.reddit.com").searchParams.get("sort") === "new");
  assert.equal(new URL(pages[1].url, "https://old.reddit.com").searchParams.get("after"), "t3_self");
  assert.equal(a.pd.task.info.edited, 0);
  assert.equal(a.pd.task.info.deleted, 3);
  for (let i = 1; i < a.calls.length; i++) assert.ok(a.calls[i].at - a.calls[i - 1].at >= 15000);
  assert.equal(a.max(), 1); a.dom.window.close();
});

for (const kind of ["t1", "t3"]) {
  test(`${kind} pagination is paced and searches visit every original sort/timeframe`, async () => {
    const target = kind === "t1" ? "/comments/" : "/submitted/";
    const a = app((url) => {
      const parsed = new URL(url, "https://old.reddit.com");
      if (url.includes(target) && parsed.searchParams.get("sort") === "new") {
        return response(parsed.searchParams.get("after") ? listing([item(kind, "second")]) : listing([item(kind, "first")], kind + "_first"));
      }
      return response(listing());
    }, { export: true });
    a.pd.actions.page.next(); await a.clock.advance(1000000);
    assert.equal(a.completed(), true);
    const calls = a.calls.filter(c => c.url.includes(target));
    assert.equal(calls.length, 15);
    assert.equal(new URL(calls[1].url, "https://old.reddit.com").searchParams.get("after"), kind + "_first");
    for (let i = 1; i < a.calls.length; i++) assert.ok(a.calls[i].at - a.calls[i - 1].at >= 15000);
    const searches = a.calls.filter(c => c.url.startsWith("/search.json"));
    assert.equal(searches.length, 14);
    for (const sort of ["new", "hot", "top", "controversial"]) {
      const matching = searches.filter(c => new URL(c.url, "https://old.reddit.com").searchParams.get("sort") === sort);
      assert.equal(matching.length, ["top", "controversial"].includes(sort) ? 6 : 1);
      if (matching.length === 6) assert.deepEqual(matching.map(c => new URL(c.url, "https://old.reddit.com").searchParams.get("t")), ["all", "hour", "day", "week", "month", "year"]);
    }
    assert.equal(a.pd.task.info.exported, 2);
    a.dom.window.close();
  });
}

for (const kind of ["t1", "t3"]) {
  for (const mode of ["edit", "delete", "both"]) {
    test(`${kind} ${mode}: confirmed mutations, authentication and edit-before-delete ordering`, async () => {
      let sent = false;
      const fixture = item(kind);
      const a = app((url, init) => {
        if (url.startsWith("/api/")) return mutationReply(url, init);
        if (!sent) { sent = true; return response(listing([fixture])); }
        return response(listing());
      }, { edit: mode !== "delete", comments: kind === "t1" && mode !== "edit", posts: kind === "t3" && mode !== "edit" });
      a.pd.actions.page.next(); await a.clock.advance(1000000);
      const mutations = a.calls.filter(c => c.url.startsWith("/api/"));
      assert.deepEqual(mutations.map(c => c.url), mode === "both" ? ["/api/editusertext.json", "/api/del"] : [mode === "edit" ? "/api/editusertext.json" : "/api/del"]);
      for (const mutation of mutations) {
        assert.equal(mutation.init.headers["X-Modhash"], "fixture-modhash");
        assert.equal(new URLSearchParams(mutation.init.body).get("uh"), "fixture-modhash");
      }
      assert.equal(a.pd.task.info.edited, mode !== "delete" ? 1 : 0);
      assert.equal(a.pd.task.info.deleted, mode !== "edit" ? 1 : 0);
      assert.equal(a.completed(), true); a.dom.window.close();
    });
  }
}

test("failed edit cannot trigger delete, cannot count as success, and leaves content available for inspection", async () => {
  const a = app((url) => url.startsWith("/api/") ? response({}) : response(listing([item()])), { comments: true, edit: true, export: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  assert.equal(a.win.pd_processing, false);
  assert.equal(a.completed(), false);
  assert.equal(a.pd.task.info.deleted + a.pd.task.info.edited, 0);
  assert.equal(a.calls.filter(c => c.url === "/api/del").length, 0);
  assert.equal(a.pd.task.items.length, 1);
  assert.match(a.$("#pd__last-error").text(), /not confirmed/); a.dom.window.close();
});

test("429 while scanning exposes cooldown and Resume, retaining the pending page", async () => {
  const a = app((url, init, n) => n === 1 ? response({}, 429, { "Retry-After": "30" }) : response(listing()), { export: true });
  a.pd.actions.page.next(); await flush();
  assert.match(a.$("#pd__rate-status").text(), /Paused due to rate limiting/);
  assert.equal(a.$("#pd__resume").prop("disabled"), true);
  await a.clock.advance(31000);
  assert.equal(a.$("#pd__resume").prop("disabled"), false);
  assert.equal(a.calls.length, 1);
  a.$("#pd__resume").trigger("click"); await a.clock.advance(1000000);
  assert.equal(a.completed(), true); a.dom.window.close();
});

test("Stop during history wait prevents pagination and preserves partial export", async () => {
  const a = app(() => response(listing([item()], "t1_test")), { export: true });
  a.pd.actions.page.next(); await flush();
  a.$("#pd__stop").trigger("click"); await a.clock.advance(1000000);
  assert.equal(a.calls.length, 1);
  assert.equal(a.win.pd_processing, false);
  assert.match(a.$("#pd__rate-status").text(), /Cancelled/);
  assert.equal(a.$("#pd__partial-export a").length, 1); a.dom.window.close();
});

test("authentication fallbacks are retained and no modhash always blocks mutations including empty edits", () => {
  const a = app(() => response(listing()), { edit: true });
  assert.equal(a.pd.helpers.modhash(), "fixture-modhash");
  a.win.r = undefined;
  a.$("body").append('<script id="config" type="text/plain">{"modhash":"fallback123"}</script>');
  assert.equal(a.pd.helpers.modhash(), "fallback123");
  a.$("#config").text("modhash: 'legacy123'"); assert.equal(a.pd.helpers.modhash(), "legacy123");
  a.$("#config").remove(); assert.equal(a.pd.helpers.modhash(), "");
  a.pd.task.config.editText = "";
  assert.equal(a.pd.helpers.validate().valid, false);
  assert.match(a.pd.helpers.validate().reason, /modhash/);
  assert.equal(a.calls.length, 0); a.dom.window.close();
});

test("filters, exclusions and export retain their original behavior", () => {
  const a = app(() => response(listing()), { export: true });
  const original = item();
  assert.equal(a.pd.helpers.shouldBeActedOn(original), true);
  for (const key of ["saved", "gilded", "mod"]) {
    a.pd.filters[key] = true;
    const excluded = item(); excluded.data[key === "mod" ? "distinguished" : key] = key === "mod" ? "moderator" : key === "gilded" ? 1 : true;
    a.pd.task.items = [excluded]; assert.equal(a.pd.helpers.shouldBeActedOn(excluded), false);
    a.pd.filters[key] = false;
  }
  a.pd.filters.subs = { enabled: true, list: ["other"] }; a.pd.task.items = [original];
  assert.equal(a.pd.helpers.shouldBeActedOn(original), false);
  a.pd.filters.subs.enabled = false;
  a.pd.filters.score = { enabled: true, gt: true, num: 20 }; assert.equal(a.pd.helpers.shouldBeActedOn(original), false);
  a.pd.filters.score.enabled = false;
  a.pd.filters.date = { enabled: true, gt: false, num: 50 }; assert.equal(a.pd.helpers.shouldBeActedOn(original), false);
  a.pd.filters.date.enabled = false;
  a.pd.actions.children.exportItem(original); a.pd.actions.children.exportItem(original);
  assert.equal(a.pd.task.info.exported, 1); assert.equal(a.pd.exportItems.length, 2); a.dom.window.close();
});

test("repeated pagination cursor fails clearly without looping", async () => {
  const a = app(() => response(listing([item()], "t1_test")), { export: true });
  a.pd.actions.page.next(); await a.clock.advance(100000);
  assert.equal(a.calls.length, 2); assert.equal(a.win.pd_processing, false);
  assert.match(a.$("#pd__last-error").text(), /repeated a pagination cursor/); a.dom.window.close();
});

test("same content discovered through multiple sorts is not edited repeatedly", async () => {
  const a = app((url, init) => url.startsWith("/api/") ? mutationReply(url, init) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(1000000);
  assert.equal(a.calls.filter(c => c.url === "/api/editusertext.json").length, 1);
  assert.equal(a.pd.api.snapshot().counts.edited, 1); a.dom.window.close();
});

test("interface API loading shares the scheduler and supports Stop before UI template is ready", async () => {
  const a = app((url, init, n) => n === 1 ? response({}, 429, { "Retry-After": "1" }) : response({ data: { content_md: "<form id='pd__form'></form>" } }));
  a.pd.setup.applyCentral(); await flush();
  assert.equal(a.calls[0].url, "/r/PowerDeleteSuite/wiki/centralform.json");
  assert.match(a.$("#pd__rate-status").text(), /Paused/);
  a.$("#pd__stop").trigger("click"); await a.clock.advance(100000);
  assert.equal(a.calls.length, 1); a.dom.window.close();
});

test("edit requests select raw JSON rather than the legacy HTML-rendered acknowledgement", async () => {
  const a = app((url, init) => url.startsWith("/api/") ? mutationReply(url, init) : response(listing([item()])), { edit: true });
  a.pd.actions.page.next(); await a.clock.advance(1000000);
  const editCall = a.calls.find(c => c.url.startsWith("/api/"));
  assert.equal(editCall.url, "/api/editusertext.json");
  assert.equal(new URLSearchParams(editCall.init.body).has("renderstyle"), false);
  assert.equal(new URLSearchParams(editCall.init.body).get("raw_json"), "1");
  assert.equal(a.pd.api.snapshot().counts.edited, 1); a.dom.window.close();
});

test("page cycles involving more than one cursor are stopped before repeating requests", async () => {
  const a = app((url, init, n) => response(listing([item("t1", String(n))], n % 2 ? "t1_a" : "t1_b")), { export: true });
  a.pd.actions.page.next(); await a.clock.advance(1000000);
  assert.equal(a.calls.length, 3); assert.equal(a.completed(), false);
  assert.match(a.$("#pd__last-error").text(), /repeated a pagination cursor/); a.dom.window.close();
});

test("generated bookmarklet payload initializes the inherited interface and paces its first scan", async () => {
  const h = harness();
  const dom = new JSDOM('<div id="header-bottom-right"><span class="user"><a>fixture-user</a></span></div><div class="titlebox"><h1>fixture-user</h1></div><div class="content" role="main"></div>',
    { url: "https://old.reddit.com/user/fixture-user/overview", runScripts: "outside-only" });
  const win = dom.window;
  win.$ = win.jQuery = jquery(win); win.r = { config: { modhash: "fixture-modhash" } };
  win.bookmarkver = "2.0"; win.confirm = () => false; win.alert = () => {};
  win.Date.now = h.clock.now; win.Math.random = () => 0;
  win.setTimeout = h.clock.setTimeout; win.clearTimeout = h.clock.clearTimeout;
  const calls = [];
  win.fetch = async (url) => {
    calls.push({ url, at: h.clock.now() });
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      return { ...response(), json: async () => ({ data: { stylesheet: "#pd__central { color: black; }" } }) };
    }
    if (url.includes("centralform")) return response({ data: { content_md: '<h2></h2><form id="pd__form"><input type="checkbox" id="pd__export" checked><input id="pd__score-num" value="0"><input id="pd__date-num" value="0"></form><div class="processing"></div><div class="complete"><div class="summary"></div><div class="goodbye"></div></div>' } });
    return response(listing());
  };
  const generated = fs.readFileSync(path.join(__dirname, "../powerdeletesuite.js"), "utf8");
  win.eval(generated); await flush();
  assert.equal(calls.length, 2);
  assert.equal(win.$("#pd__rate-panel").length, 1);
  assert.equal(win.$("#pd__form").length, 1);
  const instance = win.pd; win.eval(generated); assert.equal(win.pd, instance);
  win.$("#pd__form").trigger("submit");
  await h.clock.advance(14999); assert.equal(calls.length, 2);
  await h.clock.advance(1); assert.equal(calls.length, 3);
  assert.match(calls[2].url, /submitted/);
  await h.clock.advance(1000000);
  assert.match(win.$("#pd__rate-status").text(), /Completed/);
  assert.equal(win.pd_processing, false); win.close();
});
