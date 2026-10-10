"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { response, flush } = require("./helpers");
const root = path.join(__dirname, "..");
function run(code, opts = {}) {
  const requests = [], scripts = [], alerts = [];
  const context = {
    window: { pd_active: opts.active }, Date: { now: () => 123456789 },
    document: { location: { hostname: opts.hostname || "old.reddit.com", pathname: opts.pathname || "/user/test/overview" },
      createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
    fetch: async url => { requests.push(url); if (opts.offline) throw new Error("offline"); return response(opts.code === undefined ? "window.fixture = true;" : opts.code, opts.status || 200); },
    alert: message => alerts.push(message), confirm: () => opts.confirm !== false,
  };
  vm.runInNewContext(code, context);
  return { requests, scripts, alerts, context };
}
for (const file of ["bookmarklet.js", "bookmarklet.min.js"]) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  test(`${file} loads exclusively from the fork with Date.now cache busting`, async () => {
    const h = run(code); await flush();
    assert.deepEqual(h.requests, ["https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/powerdeletesuite.js?123456789"]);
    assert.equal(h.scripts.length, 1); assert.equal(h.scripts[0].textContent, "window.fixture = true;");
    assert.equal(h.context.window.bookmarkver, "2.0");
  });
  test(`${file} fails closed on HTTP errors, empty downloads and network failures`, async () => {
    for (const opts of [{ status: 404 }, { status: 500 }, { code: "" }, { offline: true }]) {
      const h = run(code, opts); await flush();
      assert.equal(h.scripts.length, 0); assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0], /Error retrieving PowerDeleteSuite from GitHub/);
    }
  });
  test(`${file} checks genuine Reddit profile overviews and redirects to old Reddit`, async () => {
    for (const opts of [{ hostname: "reddit.com.evil.test" }, { pathname: "/r/example/overview" }, { pathname: "/user/test/overview-other" }, { pathname: "/user/test/comments" }]) {
      const h = run(code, opts); await flush(); assert.equal(h.requests.length, 0);
      assert.equal(h.context.document.location, "https://old.reddit.com/user/me/overview");
    }
    for (const pathname of ["/u/test/overview", "/user/test/overview/"]) {
      const h = run(code, { pathname }); await flush(); assert.equal(h.requests.length, 1);
    }
    const declined = run(code, { hostname: "example.com", confirm: false });
    assert.equal(declined.requests.length, 0); assert.equal(declined.alerts.length, 1);
  });
  test(`${file} refuses duplicate instances`, async () => {
    const h = run(code, { active: true }); await flush();
    assert.equal(h.requests.length, 0); assert.match(h.alerts[0], /already loaded/);
  });
}

test("all script loaders and README reference extricator, with no runtime text patches", () => {
  for (const file of ["bookmarklet.js", "bookmarklet.min.js", "powerdeletesuite.user.js"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(text, /raw\.githubusercontent\.com\/extricator\/PowerDeleteSuite\/master\//);
    assert.doesNotMatch(text, /raw\.githubusercontent\.com\/(?:j0be|Vaspyyy|mykola2312)/);
    assert.doesNotMatch(text, /\.replace\(/);
  }
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /https:\/\/github.com\/extricator\/PowerDeleteSuite/);
  assert.ok(readme.includes(fs.readFileSync(path.join(root, "bookmarklet.min.js"), "utf8").trim()));
  assert.doesNotMatch(readme, /MY-GITHUB-USERNAME|ACTUAL-DEFAULT-BRANCH/);
});

test("optional userscript uses checked downloads and a DOM link without duplicate IDs", async () => {
  const { JSDOM } = require("jsdom");
  const code = fs.readFileSync(path.join(root, "powerdeletesuite.user.js"), "utf8");
  const minified = fs.readFileSync(path.join(root, "bookmarklet.min.js"), "utf8").trim();
  for (const status of [200, 404]) {
    const dom = new JSDOM('<div id="header-bottom-right"><ul class="flat-list"></ul></div>', { runScripts: "outside-only" });
    const alerts = [], calls = [];
    dom.window.fetch = async url => { calls.push(url); return response(minified, status); };
    dom.window.alert = message => alerts.push(message);
    dom.window.eval(code); await flush();
    assert.match(calls[0], /^https:\/\/raw.githubusercontent.com\/extricator\/PowerDeleteSuite\/master\/bookmarklet.min.js\?/);
    if (status === 200) {
      assert.equal(dom.window.document.getElementById("pd-delete").getAttribute("href"), minified);
      dom.window.eval(code); await flush();
      assert.equal(dom.window.document.querySelectorAll("#pd-delete").length, 1);
    } else {
      assert.equal(dom.window.document.getElementById("pd-delete"), null);
      assert.match(alerts[0], /HTTP 404/);
    }
    dom.window.close();
  }
});
