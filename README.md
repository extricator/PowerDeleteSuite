# PowerDeleteSuite — maintained, paced Reddit cleanup

[extricator/PowerDeleteSuite](https://github.com/extricator/PowerDeleteSuite) is a public GitHub fork of [Vaspyyy/PowerDeleteSuite-updated](https://github.com/Vaspyyy/PowerDeleteSuite-updated), which is based on [j0be/PowerDeleteSuite](https://github.com/j0be/PowerDeleteSuite). Vaspyyy's code, not the older original implementation, is the development baseline: `42e3a728cf58106fa5d628e86c9a5ebc786348c3`.

This fork adds one shared scheduler for **every Reddit API request**, including history scanning, pagination, search, comment/self-post editing and deletion. Default request starts are **15–20 seconds apart**, with **one request in flight**. Slow responses can increase that interval. The separate five-second edit/delete timers have been removed. Processing large histories will take much longer; the slower history scan is intentional.

Comments, self-post edits, submission deletion, edit-before-delete, subreddit/score/date filters, saved/gilded/moderator exclusions, export, and all original discovery sorts/timeframes remain available. No password is requested and no telemetry is added. The browser uses your existing Reddit session. Account data and settings stay in your browser unless you export or share them.

## Inherited compatibility and bookmarklet fixes

Vaspyyy's modhash compatibility changes are retained: `window.r.config.modhash` first, then the `#config` JSON/legacy-text fallbacks; authenticated requests include both `X-Modhash` and `uh`; missing authentication blocks mutations. HTTP/API error details remain visible. The missing-modhash check now also runs before the random-edit-text confirmation, which previously could return early.

[Issue #90](https://github.com/j0be/PowerDeleteSuite/issues/90) uses a `fetch()` loader with Reddit/overview detection, cache busting, script injection and an old Reddit redirect. Vaspyyy's README already adopted most of that workaround, but its checked-in bookmarklet still downloaded j0be's script with day-of-month cache busting. This fork unifies the loaders, uses `Date.now()`, checks `response.ok`, rejects empty downloads, reports network/HTTP failures, detects `/user/<name>/overview` and `/u/<name>/overview`, and prevents duplicate instances. There are no runtime source-text replacements.

All executable downloads point to this fork's actual default branch, `master`:

`https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/powerdeletesuite.js`

## Install and use

1. Create a browser bookmark named **PowerDeleteSuite**. Paste the complete minified `javascript:` line below into its **URL/location** field. Use the bookmark editor; browsers may strip `javascript:` when pasting into the address bar.
2. Log in and open [your own old Reddit overview](https://old.reddit.com/user/me/overview). Old Reddit supplies the DOM and session modhash this application expects. Run the bookmark while that tab is active.
3. Review the existing action, filter, exclusion and export options. Review **API rate-limit settings** above the original interface. An export-only run is available.
4. Start processing. Keep a single PowerDeleteSuite tab running. Edits/deletions are irreversible; review your options before starting.
5. Use **Stop / Cancel** at any time. This stops queued work and aborts the in-flight browser request. A request already received by Reddit may still have completed. A partial export of already processed items is offered when export was enabled. Reload before starting a new run after cancellation or failure.

The optional [userscript](powerdeletesuite.user.js) adds a PDS link to old Reddit's header using the same maintained bookmarklet. Both loaders fetch exclusively from `extricator/PowerDeleteSuite`.

<!-- bookmarklet:start -->

Readable bookmarklet:

```javascript
javascript:(function () {
  window.bookmarkver = "2.0";
  var isReddit = document.location.hostname.split(".").slice(-2).join(".") === "reddit.com";
  var isOverview = /^\/(?:user|u)\/[^/]+\/overview\/?$/i.test(document.location.pathname);
  if (isReddit && isOverview) {
    if (window.pd_active) {
      alert("PowerDeleteSuite is already loaded. Use its Stop / Resume controls, or reload the page for a new run.");
      return;
    }
    var url = "https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/powerdeletesuite.js?" + Date.now();
    fetch(url)
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      })
      .then(function (code) {
        if (!code.trim()) throw new Error("Empty script download");
        if (window.pd_active) return;
        var script = document.createElement("script");
        script.id = "pd-script";
        script.textContent = code;
        document.head.appendChild(script);
      })
      .catch(function (error) {
        alert("Error retrieving PowerDeleteSuite from GitHub: " + error.message + ". Check your connection and the repository URL, then try again.");
      });
  } else if (confirm("Open your own old.reddit.com overview to run PowerDeleteSuite?")) {
    document.location = "https://old.reddit.com/user/me/overview";
  } else {
    alert("Please open your own Reddit profile overview before running PowerDeleteSuite.");
  }
})();
```

Copy this entire single line into a bookmark's URL field:

```javascript
javascript:!function(){window.bookmarkver="2.0";var e="reddit.com"===document.location.hostname.split(".").slice(-2).join("."),t=/^\/(?:user|u)\/[^/]+\/overview\/?$/i.test(document.location.pathname);if(e&&t){if(window.pd_active)return void alert("PowerDeleteSuite is already loaded. Use its Stop / Resume controls, or reload the page for a new run.");var o="https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/powerdeletesuite.js?"+Date.now();fetch(o).then(function(e){if(!e.ok)throw new Error("HTTP "+e.status);return e.text()}).then(function(e){if(!e.trim())throw new Error("Empty script download");if(!window.pd_active){var t=document.createElement("script");t.id="pd-script",t.textContent=e,document.head.appendChild(t)}}).catch(function(e){alert("Error retrieving PowerDeleteSuite from GitHub: "+e.message+". Check your connection and the repository URL, then try again.")})}else confirm("Open your own old.reddit.com overview to run PowerDeleteSuite?")?document.location="https://old.reddit.com/user/me/overview":alert("Please open your own Reddit profile overview before running PowerDeleteSuite.")}();
```

<!-- bookmarklet:end -->

## Settings and status

| Setting | Default | Behavior |
| --- | --- | --- |
| Global throttling | ON | Disabling pacing still keeps one request in flight and rate-limit pauses enforced. |
| Minimum interval | 15 seconds | Measured between request starts, shared across all API paths. |
| Random jitter | 0–5 seconds | Independently sampled for each request interval. |
| Concurrent API requests | 1, fixed | Includes reads, writes and retries. |
| Pause on 429 | ON, fixed | Also pauses on API-level `RATELIMIT` and exhausted quota headers. |
| Automatically resume | OFF, fixed | Each rate-limit pause requires an explicit click. |
| Fallback cooldown | 15 minutes | Configurable estimate when Reddit gives no usable duration. |

Settings apply when starting a run and are locked during it. Rate settings reset to defaults on a new page load; the original Remember Settings feature continues to store the original form options. Bounds and invalid numeric settings are checked before starting. Programmatic scheduler options include a 45-second request timeout and at most two read retries, using exponential delays of 2 and 4 seconds in addition to the shared pacing constraint (the longer wait wins).

The compact status panel shows Idle, Scanning history, Editing, Deleting, Waiting between requests, Paused due to rate limiting, Cancelled, Completed or Failed. It shows actual request counts and confirmed edit/delete counts, terminal failed-request counts, the last error, and cooldown remaining. Discovery/export counts in the original UI are also preserved. Confirmed mutations are deduplicated within a run when the same item appears in several sorts.

## Rate limits, Stop and Resume

HTTP 429 and API-level rate-limit errors freeze the entire queue immediately. The scheduler takes the longest usable duration from integer/HTTP-date `Retry-After`, `X-Ratelimit-Reset`, and durations in Reddit's rate-limit error, adding a one-second rounding buffer. It inspects `X-Ratelimit-Remaining` and `X-Ratelimit-Used` too. A successful response with remaining quota at zero is acknowledged, then subsequent requests pause.

Without usable cooldown information, the configurable fallback is displayed as an **estimate, not a guaranteed unblock time**. Missing/invalid headers never mean zero wait. No requests start just because the countdown reaches zero. **Resume** remains disabled before the deadline and is also checked inside the scheduler. After cooldown, click it to retry a request explicitly rejected by 429/`RATELIMIT`, or continue after a successful exhausted-quota response. Another rejection requires another cooldown and another click; there is no automatic 429 retry loop.

Cooldown timestamps are saved in local storage on the current Reddit origin, so reloading or cancelling does not erase an observed cooldown. A resumed page still needs an explicit Resume. Storage restrictions can prevent persistence; the in-memory deadline remains enforced. Other origins, browsers, devices and Reddit activity are outside this scheduler's control. Use a single tab: this is a shared queue within the application, not a cross-device or cross-tab request coordinator.

Network/5xx failures on reads get bounded retries through the same queue. HTTP 403, authentication failures, malformed listings and other API errors stop processing visibly; the scanner does not silently skip failed pages. Mutations are **never automatically retried** after network errors, timeouts, 5xx or ambiguous acknowledgements. An edit is confirmed only when the response identifies the requested item and expected text; deletion requires HTTP success with the endpoint's empty JSON object acknowledgement. Empty bodies, arbitrary JSON and HTTP-200 API errors are failures. Failed edits block the subsequent delete.

## Troubleshooting and limitations

- **429 / paused:** wait for the countdown, then decide whether to Resume or Stop. A fallback estimate can be too short. Increase pacing or wait longer if Reddit rejects the next request. Client-side pacing cannot guarantee avoidance of 429s, account/IP restrictions or website blocks; other activity shares Reddit's limits.
- **403 / missing modhash:** stop, check you are logged into your own old Reddit profile, then reload. Do not repeatedly retry authentication failures. Modern Reddit's interface is not supported by the original UI; use old.reddit.com.
- **Download error:** inspect the HTTP error, connection, browser extensions and this public repository's raw URL. A failed script download is never executed. The stylesheet also downloads from this fork.
- **UI template load failure:** the inherited form is still obtained from Reddit's `/r/PowerDeleteSuite/wiki/centralform.json`, through the scheduler. Stop/Resume controls appear before that download. This inherited external template and old Reddit's DOM/jQuery availability remain dependencies; template access restrictions can stop initialization. CSS download failure leaves the markup usable without its original styles.
- **Failed / ambiguous mutation:** inspect the item directly on Reddit before deciding whether to start again. A timed-out or cancelled write may already have completed. Do not assume that a failed acknowledgement means nothing changed. The conservative edit check can stop on a legitimate but changed Reddit response format. The delete acknowledgement is protocol-level evidence, not an independent follow-up read.
- **Incomplete history:** Reddit's listing/search caps, indexing, removed/archived/locked content and permission rules can limit discovery or editing. All original sorts (`new`, `hot`, `top`, `controversial`) and top/controversial timeframes (`all`, `hour`, `day`, `week`, `month`, `year`) are retained. Pagination uses Reddit's returned cursor; repeated cursors stop scanning to prevent loops. No promise of finding every historical item is made.
- Settings/export data remain in browser memory/local storage. Partial export includes items completed before the interruption, not undiscovered content. Export files contain personal account content; share them deliberately.
- This implementation was tested using mocks only. No live Reddit account operations or rate-limit probing were used. A read-only public-template retrieval during development returned 403; real-account/browser behavior has not been verified.

Report fork-specific bugs at [this repository's issues](https://github.com/extricator/PowerDeleteSuite/issues). Do not include session cookies, modhashes, private content or unredacted exports. Attribution and original discussion: [Vaspyyy](https://github.com/Vaspyyy/PowerDeleteSuite-updated), [j0be](https://github.com/j0be/PowerDeleteSuite), and [/r/PowerDeleteSuite](https://www.reddit.com/r/PowerDeleteSuite/).

## Develop and verify

Use Node.js 22.22.2+ on the Node 22 line (CI uses Node 22), or a version supported by the package's engines field. Browser runtime dependencies are unchanged: old Reddit's jQuery, modern `fetch`, `URLSearchParams` and `AbortController`. Development dependencies are jQuery/jsdom for browser fixtures, ESLint and Terser; there are no new browser runtime packages.

```sh
npm ci
npm run build
npm run verify
```

Edit `src/scheduler.js` and `src/app.js`. The build combines them into the single self-contained `powerdeletesuite.js`, generates `bookmarklet.min.js`, and synchronizes both bookmarklets in this README. `npm run check` rejects stale generated files and checks JavaScript syntax. CI runs syntax/build consistency, lint and tests. See [ARCHITECTURE.md](ARCHITECTURE.md) for the request audit and [CHANGELOG.md](CHANGELOG.md) for changes relative to Vaspyyy.

Tests inject mocked transports and a deterministic fake clock, with live `fetch` and HTTP(S) blocked. They cover history/submission/comment pagination, every sort/timeframe, mutations/order, authentication, errors, rate limits, cancellation, UI controls, loaders and export/filter behavior. **Never test by deliberately provoking Reddit rate limits or by using a real account for destructive test actions.**
