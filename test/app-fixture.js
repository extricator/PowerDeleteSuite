"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const jquery = require("jquery");
const createScheduler = require("../src/scheduler");
const { harness, response, edited } = require("./helpers");
const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");

function app(reply, opts = {}) {
  const h = harness(reply);
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div id="header-bottom-right"><span class="user"><a>fixture-user</a></span></div>
    <div class="titlebox"><h1>fixture-user</h1></div><main class="content" role="main">
    <div id="pd__central"><h2></h2><form id="pd__form">
    <input type="checkbox" id="pd__comments" ${opts.comments ? "checked" : ""}>
    <input type="checkbox" id="pd__submissions" ${opts.posts ? "checked" : ""}>
    <input type="checkbox" id="pd__comments-edit" ${opts.edit ? "checked" : ""}>
    <input id="pd__comments-edit-text" value="changed"><input type="checkbox" id="pd__export" ${opts.export ? "checked" : ""}>
    <input type="checkbox" id="pd__subreddits"><div id="pd__sub-list"><input data-sub="example"></div>
    <input type="checkbox" id="pd__score"><input type="checkbox" id="pd__score-dirtoggle"><input id="pd__score-num" value="0">
    <input type="checkbox" id="pd__date"><input type="checkbox" id="pd__date-dirtoggle"><input id="pd__date-num" value="0">
    <input type="checkbox" id="pd__gilded"><input type="checkbox" id="pd__saved"><input type="checkbox" id="pd__mod">
    <input type="checkbox" id="pd__remember"><button type="submit">Start</button></form>
    <div class="processing"></div><div class="complete"><div class="summary"></div><div class="goodbye"></div></div></div></main>
    </body></html>`, { url: "https://old.reddit.com/user/fixture-user/overview", runScripts: "outside-only" });
  const win = dom.window;
  win.$ = win.jQuery = jquery(win);
  win.pd_active = true; // Evaluate the actual app without contacting any endpoint at startup.
  win.r = { config: { modhash: "fixture-modhash" } };
  win.confirm = () => true;
  win.alert = () => {};
  win.fetch = () => { throw new Error("Unmocked network prohibited"); };
  win.createRedditScheduler = (settings, deps) => createScheduler(settings, { ...h.deps, ...deps, fetch: h.deps.fetch });
  win.eval(source);
  const pd = win.pd;
  pd.setup.basicSettings();
  pd.setup.createProcessStream();
  pd.setup.ratePanel();
  const finish = pd.ui.done;
  let completed = false;
  pd.ui.done = function () { completed = true; finish(); };
  return { ...h, win, dom, pd, $: win.$, completed: () => completed };
}
function mutationReply(url, init) {
  const params = new URLSearchParams(init.body);
  return response(url === "/api/editusertext.json" ? edited(params.get("thing_id"), params.get("text")) : {});
}


module.exports = { app, mutationReply };
