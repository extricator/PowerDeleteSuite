/* Shared Reddit transport. Dependency injection keeps tests off the network. */
function createRedditScheduler(options, dependencies) {
  "use strict";
  var deps = dependencies || {};
  var now = deps.now || Date.now;
  var random = deps.random || Math.random;
  var later = deps.setTimeout || setTimeout;
  var clear = deps.clearTimeout || clearTimeout;
  var transport = deps.fetch || fetch;
  var notify = deps.onState || function () {};
  var settings = Object.assign({
    enabled: true, intervalMs: 15000, jitterMs: 5000,
    fallbackCooldownMs: 900000, timeoutMs: 45000, maxReadRetries: 2,
  }, options);
  var queue = [], active = null, timer = null;
  var nextStart = 0, blockedUntil = 0, paused = false, cancelled = false;
  var terminal = false, estimated = false, lastError = "", status = "Idle";
  var counts = { requests: 0, edited: 0, deleted: 0, failed: 0, rateLimits: 0 };
  var rateHeaders = {};

  function error(kind, message, extra) {
    return Object.assign(new Error(message), { kind: kind }, extra);
  }
  function number(value) {
    return value !== null && value !== undefined && String(value).trim() !== "" &&
      Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  }
  function retryAfter(value, time) {
    if (!value) return null;
    if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
    // Reject numeric junk rather than interpreting it as a date.
    if (!/[a-z]/i.test(value)) return null;
    var date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - time) : null;
  }
  function snapshot() {
    return {
      status: status, paused: paused, cancelled: cancelled, terminal: terminal,
      cooldownMs: Math.max(0, blockedUntil - now()), estimated: estimated,
      queued: queue.length, inFlight: active !== null, lastError: lastError,
      counts: Object.assign({}, counts), rateHeaders: Object.assign({}, rateHeaders),
      settings: Object.assign({}, settings),
    };
  }
  function emit(value) {
    if (value) status = value;
    notify(snapshot());
  }
  function arm(delay) {
    if (timer !== null) clear(timer);
    timer = later(function () { timer = null; pump(); }, Math.max(1, delay));
  }
  function restoreCooldown() {
    var saved = deps.loadCooldown && deps.loadCooldown();
    if (saved && Number.isFinite(saved.until) && saved.until > blockedUntil) {
      blockedUntil = saved.until;
      paused = true;
      estimated = !!saved.estimated;
      lastError = "A previous run reached Reddit's rate limit; explicit Resume is required";
    }
  }
  function cooldown(response, apiMessage) {
    var values = [];
    var retry = retryAfter(response.headers.get("Retry-After"), now());
    var reset = number(response.headers.get("X-Ratelimit-Reset"));
    if (retry !== null) values.push(retry);
    if (reset !== null) values.push(reset * 1000);
    // RATELIMIT messages sometimes carry the only available wait duration.
    var match, pattern = /(\d+(?:\.\d+)?)\s*(second|minute|hour)s?/gi;
    var apiWait = 0;
    while ((match = pattern.exec(apiMessage || ""))) {
      apiWait += Number(match[1]) * ({ second: 1000, minute: 60000, hour: 3600000 })[match[2].toLowerCase()];
    }
    if (apiWait) values.push(apiWait);
    estimated = values.length === 0;
    // Add a second for rounding / clock skew. Never shorten an existing cooldown.
    blockedUntil = Math.max(blockedUntil, now() +
      (estimated ? settings.fallbackCooldownMs : Math.max.apply(null, values) + 1000));
    paused = true;
    if (deps.saveCooldown) deps.saveCooldown({ until: blockedUntil, estimated: estimated });
    counts.rateLimits++;
    lastError = apiMessage || "Reddit rate limit reached";
    emit("Paused due to rate limiting");
  }
  function apiErrors(body) {
    if (!body || typeof body !== "object") return [];
    var errors = body.json && body.json.errors || body.errors || [];
    if (!Array.isArray(errors)) errors = [errors];
    if (body.error) errors = errors.concat([[String(body.error), body.message || "API error"]]);
    if (body.success === false) errors = errors.concat([["API_ERROR", body.message || "Unsuccessful response"]]);
    return errors;
  }
  function validate(body, spec) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw error("malformed", "Malformed Reddit JSON response");
    }
    if (spec.kind === "listing") {
      if (!body.data || !Array.isArray(body.data.children) ||
          !body.data.children.every(function (item) {
            return item && (item.kind === "t1" || item.kind === "t3") &&
              item.data && typeof item.data.name === "string";
          }) || !(body.data.after === null || typeof body.data.after === "string")) {
        throw error("malformed", "Malformed history listing; scanning stopped without skipping the page");
      }
    } else if (spec.kind === "edit") {
      var things = body.json && body.json.data && body.json.data.things;
      var confirmed = body.json && Array.isArray(body.json.errors) && body.json.errors.length === 0 &&
        Array.isArray(things) && things.some(function (thing) {
          return thing && thing.data && thing.data.name === spec.name &&
            (thing.data.body === spec.text || thing.data.selftext === spec.text);
        });
      if (!confirmed) throw error("ambiguous", "Edit was not confirmed for " + spec.name + "; inspect Reddit before trying again");
    } else if (spec.kind === "delete") {
      // /api/del's JSON success response is an empty object (api_type=json).
      // HTML, empty bodies and arbitrary JSON are never treated as success.
      if (Object.keys(body).length !== 0) {
        throw error("ambiguous", "Unexpected delete acknowledgement for " + spec.name + "; inspect Reddit before trying again");
      }
    }
    if (spec.validate && !spec.validate(body)) throw error("malformed", "Malformed " + spec.kind + " response");
    return body;
  }
  async function execute(job) {
    var spec = job.spec, timeout;
    try {
      var init = { method: spec.kind === "edit" || spec.kind === "delete" ? "POST" : "GET",
        credentials: "same-origin", signal: job.controller.signal,
        headers: { Accept: "application/json" } };
      var params = new URLSearchParams();
      Object.keys(job.data).forEach(function (key) {
        if (job.data[key] !== null && job.data[key] !== undefined) params.set(key, job.data[key]);
      });
      if (init.method === "POST") {
        var auth = deps.getModhash ? deps.getModhash() : "";
        if (typeof auth !== "string" || !auth.trim()) throw error("auth", "No valid modhash; reload your logged-in old.reddit.com overview");
        init.headers["X-Modhash"] = auth;
        init.headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
        params.set("uh", auth);
        params.set("api_type", "json");
        init.body = params.toString();
      }
      var url = job.url + (init.method === "GET" && params.size ? "?" + params.toString() : "");
      job.started = true;
      counts.requests++;
      timeout = later(function () { job.timedOut = true; job.controller.abort(); }, settings.timeoutMs);
      var response = await transport(url, init);
      if (cancelled) throw error("cancelled", "Cancelled");
      rateHeaders = {
        remaining: number(response.headers.get("X-Ratelimit-Remaining")),
        reset: number(response.headers.get("X-Ratelimit-Reset")),
        used: number(response.headers.get("X-Ratelimit-Used")),
      };
      if (response.status === 429) {
        cooldown(response, "HTTP 429: Reddit rejected this request. Resume explicitly retries it after cooldown.");
        // Release an unread response stream before another request can use the slot.
        try { if (response.body) await response.body.cancel(); } catch (_) { /* Abort also closes the stream. */ }
        if (cancelled) throw error("cancelled", "Cancelled");
        queue.unshift(job);
        return;
      }
      var text = await response.text(), body;
      if (cancelled) throw error("cancelled", "Cancelled");
      try { body = JSON.parse(text); } catch (_) { /* handled below */ }
      var errors = apiErrors(body);
      var message = errors.map(function (entry) { return Array.isArray(entry) ? entry.join(": ") : String(entry); }).join("; ").slice(0, 300);
      if (errors.some(function (entry) { return /RATELIMIT|RATE_LIMIT|TOO_MANY_REQUESTS|^429\b/i.test(Array.isArray(entry) ? entry[0] : String(entry)); })) {
        cooldown(response, "HTTP " + response.status + " API " + message);
        queue.unshift(job);
        return;
      }
      // An exhausted quota pauses the entire queue even on a successful response.
      if (rateHeaders.remaining !== null && rateHeaders.remaining <= 0) cooldown(response, "X-Ratelimit-Remaining exhausted");
      if (!response.ok) {
        throw error(response.status === 403 ? "auth" : "http", "HTTP " + response.status +
          (message ? ": " + message : ": " + (body && body.message ||
            text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || response.statusText || "Reddit request failed")),
        { status: response.status, retryable: response.status >= 500 && response.status <= 599 });
      }
      if (errors.length) throw error(/USER_REQUIRED|BAD_CSRF|MODHASH|LOGGED_IN|FORBIDDEN/i.test(message) ? "auth" : "api", "HTTP " + response.status + " API " + message);
      validate(body, spec);
      if (cancelled) throw error("cancelled", "Cancelled; any in-flight edit/delete may already have completed");
      if (spec.kind === "edit") counts.edited++;
      if (spec.kind === "delete") counts.deleted++;
      job.resolve(body);
    } catch (failure) {
      if (!failure.kind) failure = error("network", job.timedOut ? "Request timed out" : "Network request failed", { retryable: true });
      if (cancelled) failure = error("cancelled", "Cancelled; any in-flight edit/delete may already have completed");
      var read = job.spec.kind !== "edit" && job.spec.kind !== "delete";
      lastError = failure.message;
      if (read && failure.retryable && job.retries < settings.maxReadRetries && !cancelled) {
        job.notBefore = now() + 2000 * Math.pow(2, job.retries++);
        queue.unshift(job);
      } else {
        if (failure.kind !== "cancelled") counts.failed++;
        if (!read && job.started && (failure.kind === "network" || failure.kind === "http" || failure.kind === "malformed")) {
          failure.message += "; outcome may be ambiguous. No automatic mutation retry; inspect Reddit first";
          lastError = failure.message;
        }
        terminal = !cancelled;
        job.reject(failure);
        queue.splice(0).forEach(function (pending) { pending.reject(failure); });
        emit(cancelled ? "Cancelled" : "Failed");
      }
    } finally {
      if (timeout !== undefined) clear(timeout);
      active = null;
      pump();
    }
  }
  function pump() {
    if (cancelled || terminal || active) return;
    restoreCooldown();
    if (paused) {
      emit("Paused due to rate limiting");
      if (blockedUntil > now()) arm(Math.min(1000, blockedUntil - now()));
      return;
    }
    if (!queue.length) { emit("Idle"); return; }
    var wait = Math.max(nextStart, queue[0].notBefore) - now();
    if (wait > 0) { emit("Waiting between requests"); arm(wait); return; }
    active = queue.shift();
    active.started = false;
    active.timedOut = false;
    active.controller = new AbortController();
    nextStart = now() + (settings.enabled ? settings.intervalMs + random() * settings.jitterMs : 0);
    emit(active.spec.kind === "edit" ? "Editing" : active.spec.kind === "delete" ? "Deleting" : "Scanning history");
    // execute may finish synchronously on a missing modhash; pass the job explicitly.
    execute(active);
  }
  function configure(values) {
    if (active || queue.length || paused || cancelled || terminal) throw error("settings", "Settings can only change while idle");
    var merged = Object.assign({}, settings, values);
    ["intervalMs", "jitterMs", "fallbackCooldownMs", "timeoutMs"].forEach(function (key) {
      if (!Number.isFinite(merged[key]) || merged[key] < (key === "fallbackCooldownMs" || key === "timeoutMs" ? 1000 : 0) || merged[key] > 86400000) {
        throw error("settings", "Invalid " + key + "; use a value between the minimum and 24 hours");
      }
    });
    if (!Number.isInteger(merged.maxReadRetries) || merged.maxReadRetries < 0 || merged.maxReadRetries > 5) throw error("settings", "Invalid read retry limit");
    settings = merged;
    emit();
  }
  configure(settings);
  restoreCooldown();
  if (paused) pump();
  return {
    request: function (url, data, spec) {
      if (!/^\/(?:user\/|search\.json|api\/|r\/)/.test(url) || /[?#\\]/.test(url)) {
        return Promise.reject(error("url", "Only same-origin Reddit API paths may use this scheduler"));
      }
      if (cancelled || terminal) return Promise.reject(error(cancelled ? "cancelled" : "failed", "Processing has stopped; reload before running again"));
      return new Promise(function (resolve, reject) {
        queue.push({ url: url, data: data || {}, spec: spec || { kind: "listing" },
          resolve: resolve, reject: reject, retries: 0, notBefore: 0, started: false });
        pump();
      });
    },
    resume: function () {
      restoreCooldown();
      if (cancelled || terminal || !paused || now() < blockedUntil) return false;
      paused = false;
      if (deps.saveCooldown) deps.saveCooldown(null);
      if (timer !== null) { clear(timer); timer = null; }
      pump();
      return true;
    },
    cancel: function () {
      cancelled = true;
      if (timer !== null) { clear(timer); timer = null; }
      var failure = error("cancelled", "Cancelled; reload to start a new run");
      queue.splice(0).forEach(function (job) { job.reject(failure); });
      if (active) { active.reject(failure); active.controller.abort(); }
      emit("Cancelled");
    },
    configure: configure,
    snapshot: snapshot,
    complete: function () { emit("Completed"); },
    retryAfter: retryAfter,
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = createRedditScheduler;
