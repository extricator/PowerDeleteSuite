/* Explicit recovery for rejected mutations; also loadable into stopped 2.0.x tabs. */
function installRedditRecovery(win) {
  "use strict";
  var pd = win.pd, $ = win.jQuery || win.$;
  if (!pd || !$ || !pd.api || !pd.setup || !pd.setup.basicSettings) {
    throw new Error("Open the existing PowerDeleteSuite tab before loading recovery controls");
  }
  if (pd.recovery) { pd.recovery.render(); return pd.recovery; }
  var audit = [], previousCounts = { requests: 0, edited: 0, deleted: 0, failed: 0, rateLimits: 0 };
  var originalFailed = pd.ui.failed, originalStatus = pd.ui.rateStatus;
  var originalShouldAct = pd.helpers.shouldBeActedOn, skippedItems = {};
  var originalCreateProcess = pd.setup.createProcessStream;

  function context() {
    var state = pd.api.snapshot(), task = pd.task;
    if (!state.terminal || state.cancelled || state.inFlight || win.pd_processing ||
        !/^HTTP 403\b/.test(state.lastError)) return null;
    if (!task) return state.lastFailure && state.lastFailure.operation === "interface"
      ? { state: state, operation: "interface", path: state.lastFailure.path } : null;
    if (!task.items || !task.items.length) {
      if (state.lastFailure && state.lastFailure.operation !== "listing") return null;
      return { state: state, operation: "listing", path: pd.endpoints[task.paths.sections[0]] };
    }
    var item = task.items[0], config = task.config;
    var confirmed = pd.confirmed[item.data.name] || {};
    var operation = !confirmed.edited && (item.kind === "t1" || item.data.is_self) && config.isEditing
      ? "edit" : !confirmed.deleted && ((item.kind === "t1" && config.isRemovingComments) ||
        (item.kind === "t3" && config.isRemovingPosts)) ? "delete" : null;
    if (!operation) return null;
    if (state.lastFailure && (state.lastFailure.operation !== operation || state.lastFailure.name !== item.data.name)) return null;
    return { state: state, item: item, operation: operation, path: operation === "edit" ? "/api/editusertext.json" : "/api/del" };
  }
  function panel() {
    if (!$("#pd__recovery").length) {
      $("#pd__rate-panel").after('<section id="pd__recovery" style="margin:20px;padding:12px;border:1px solid #ccc;background:white;color:#222" aria-live="polite"></section>');
    }
    return $("#pd__recovery").empty();
  }
  function report() {
    return JSON.parse(JSON.stringify(audit));
  }
  function render() {
    var target = panel(), current = context();
    var skipped = audit.filter(function (entry) { return entry.action === "skip"; }).length;
    if (audit.length) {
      target.append($("<p>").text("Recovery attempts: " + audit.length + ". Explicitly skipped items: " + skipped +
        ". Skips are recorded as failures, never successful edits/deletions."));
      target.append($("<a>").text("Download recovery log (contains item identifiers)")
        .attr("download", "PowerDeleteSuiteRecovery.json")
        .attr("href", "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(report(), null, 2))));
    }
    if (!current) {
      var failure = pd.api.snapshot().lastFailure;
      if (failure) target.append($("<p>").text("Failed request: " + failure.operation + " " + failure.path +
        (failure.name ? " — " + failure.name : "")));
      if (!audit.length && !failure) target.remove();
      return;
    }
    target.prepend($("<strong>").text("HTTP 403 recovery — v2.0.2"));
    target.append($("<p>").text("Reddit rejected " + current.operation + " for " + (current.item ? current.item.data.name : current.path) +
      " with HTTP 403. Completed work and remaining history are still in this tab. Check your login and inspect the item before choosing an action. A 403 can affect one item or broader access; repeated failures require investigation."));
    var permalink = current.item && current.item.data.permalink;
    if (typeof permalink === "string" && /^\/(?:r|user|comments)\//.test(permalink) && !permalink.includes("\\")) {
      target.append($("<a>").text("Inspect failed item in another tab").attr({ href: permalink, target: "_blank", rel: "noopener" }));
    }
    target.append(" ", $("<button>").attr({ type: "button", id: "pd__retry-failed" }).text("Retry rejected operation and continue")
      .on("click", function () { recover(false); }));
    if (current.item) target.append(" ", $("<button>").attr({ type: "button", id: "pd__skip-failed" }).text("Skip this item and continue (record failure)")
      .on("click", function () { recover(true); }));
    else target.append($("<p>").text("Failed history/interface reads may be retried explicitly; they cannot be skipped without losing coverage."));
    if (current.state.cooldownMs > 0) target.append($("<p>").text("Recovery is blocked until the existing cooldown expires."));
  }
  function recover(skip) {
    var current = context();
    if (!current || (skip && !current.item)) return false;
    if (current.state.cooldownMs > 0) {
      win.alert("The existing Reddit cooldown has not expired. Recovery cannot bypass it."); return false;
    }
    if (current.item && !pd.helpers.modhash()) { win.alert("No valid modhash. Restore your login before retrying; keep this tab open."); return false; }
    var user = $("#header-bottom-right .user a").first().text();
    if (user !== pd.config.user) { win.alert("The logged-in account has changed. Recovery stopped."); return false; }
    if (!win.confirm(skip ? "Skip " + current.item.data.name + "? Its failed operation will remain unresolved and be recorded in the recovery log. Continue with the remaining items?"
      : "Retry the rejected " + current.operation + " for " + (current.item ? current.item.data.name : current.path) + " once, then continue? A repeated 403 will stop again. Completed operations will not be replayed.")) return false;

    // Older shipped schedulers cannot clear a terminal failure. Recreate only
    // the transport, retaining task/cursors, filters, confirmed IDs and export.
    var oldApi = pd.api, oldConfig = pd.config;
    try {
      pd.api = null;
      pd.setup.basicSettings();
      if (pd.api.snapshot().paused && !pd.api.resume()) throw new Error("An existing cooldown still blocks recovery");
      pd.api.configure(current.state.settings);
    } catch (failure) {
      pd.api = oldApi; pd.config = oldConfig;
      pd.ui.rateStatus(oldApi.snapshot()); win.alert(failure.message); return false;
    }
    Object.keys(previousCounts).forEach(function (key) { previousCounts[key] += current.state.counts[key]; });
    if (pd.runCounts) ["requests", "edited", "deleted"].forEach(function (key) { pd.runCounts[key] -= current.state.counts[key]; });
    audit.push({ at: new Date().toISOString(), action: skip ? "skip" : "retry", operation: current.operation,
      name: current.item ? current.item.data.name : null, path: current.path,
      permalink: current.item && current.item.data.permalink || null, error: current.state.lastError });
    win.pd_processing = true;
    $("#pd__last-error").text("");
    pd.ui.rateStatus(Object.assign({}, pd.api.snapshot(), { status: "Waiting between requests" }));
    render();
    // Retain the previous start deadline across replacement of the scheduler.
    var spacing = current.state.settings.enabled ? current.state.settings.intervalMs + current.state.settings.jitterMs : 0;
    win.setTimeout(function () {
      if (!win.pd_processing || pd.api.snapshot().cancelled) return;
      if (current.operation === "interface") {
        win.pd_processing = false;
        pd.setup.applyCentral();
      } else if (current.operation === "listing") {
        delete pd.task.seenPages[JSON.stringify([pd.task.paths.sections[0], pd.task.paths.sorts[0],
          pd.task.paths.timeframes[0], pd.task.after])];
        pd.actions.page.handle();
      } else if (skip) {
        skippedItems[current.item.data.name] = true;
        current.item.pdRecoveryError = current.state.lastError;
        pd.actions.children.finishItem();
        pd.actions.children.handleGroup();
      } else pd.actions.children.handleSingle();
    }, spacing);
    return true;
  }
  pd.ui.rateStatus = function (state) {
    var combined = Object.assign({}, state, { counts: Object.assign({}, state.counts) });
    Object.keys(previousCounts).forEach(function (key) { combined.counts[key] += previousCounts[key]; });
    originalStatus(combined);
  };
  pd.ui.failed = function (failure) { originalFailed(failure); render(); };
  pd.helpers.shouldBeActedOn = function (item) {
    var eligible = originalShouldAct(item);
    return eligible && !skippedItems[item.data.name];
  };
  pd.setup.createProcessStream = function () {
    skippedItems = {}; audit = [];
    originalCreateProcess(); render();
  };
  pd.recovery = { render: render, retry: function () { return recover(false); },
    skip: function () { return recover(true); }, report: report };
  render();
  return pd.recovery;
}
if (typeof module !== "undefined" && module.exports) module.exports = installRedditRecovery;
else installRedditRecovery(window);
