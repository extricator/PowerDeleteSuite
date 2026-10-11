# Request architecture and source audit

## Baseline and lineage

Development starts at Vaspyyy/PowerDeleteSuite-updated `42e3a728cf58106fa5d628e86c9a5ebc786348c3`. The comparison against j0be's master showed changes in README.md and powerdeletesuite.js: 82 insertions and 16 deletions across those files. The compatibility commit `c606d87` introduces `helpers.modhash`, `helpers.apiHeaders`, `helpers.ajaxErrorMessage`, authenticated `X-Modhash`/`uh`, JSON edit requests and missing-modhash validation. Those benefits are retained, with authentication rechecked at actual dispatch and error handling centralized.

GitHub's native fork was created from Vaspyyy with the name PowerDeleteSuite. Expected metadata: parent Vaspyyy/PowerDeleteSuite-updated; source j0be/PowerDeleteSuite. Origin is extricator/PowerDeleteSuite; upstream is Vaspyyy/PowerDeleteSuite-updated. j0be is the fork-network root, not the code baseline.

Issue #90 and Vaspyyy's README already use fetch, script injection, Reddit/overview checks and old Reddit redirection. Vaspyyy's checked-in bookmarklet still used j0be and day-of-month cache busting; its optional userscript also fetched j0be's bookmarklet. Both are reconciled with the README and point exclusively to this fork. response.ok, empty-download checks, stricter profile path detection, duplicate-instance protection and clear errors are added. No code is modified by runtime string replacement.

## Complete network audit

| Original path | New path | Scheduling |
| --- | --- | --- |
| Version-check `/r/PowerDeleteSuite/new.json` | Direct GitHub changelog link; request eliminated | No Reddit API call |
| `/r/PowerDeleteSuite/wiki/centralform.json` | `pd.api.request`, `interface` validation | Shared queue, including initialization and retry |
| `/user/<user>/comments/.json` | `pd.actions.page.handle` → `pd.api.request` | Shared queue |
| `/user/<user>/submitted/.json` | Same handler | Shared queue |
| `/search.json` | Same handler, retained author/self query | Shared queue |
| Pagination (`after`) | Same handler using returned `data.after` | Shared queue; repeated cursors fail |
| Sort/timeframe iteration | Existing page.shift/resetSorts/resetTimes → same handler | Shared queue |
| Comment and self-post `/api/editusertext` | `pd.actions.edit` → `pd.api.request` | Shared queue; authentication at dispatch |
| Comment/submission `/api/del` | `pd.actions.delete` → `pd.api.request` | Shared queue; authentication at dispatch |
| Read transient retries | Scheduler retains job, bounded retries | Same queue; max(global start deadline, backoff deadline) |
| Explicit 429 retry | Scheduler retains rejected job, user Resume after cooldown | Same queue; no automatic resume |
| Legacy mutation fallback/dry-run | No simulated success; actions disabled stops visibly | No API bypass |
| Stylesheet download | `fetch` from this fork's raw stylesheet.json | Unrelated GitHub request; unpaced |
| Bookmarklet/userscript download | `fetch` from this fork's raw JS files | Unrelated GitHub requests; unpaced |

The application contains no remaining `$.ajax` calls and does not patch global browser fetch/XMLHttpRequest. Runtime API transport exists only in `src/scheduler.js`. Adding any Reddit call must use `pd.api.request`; adding an endpoint requires validation and mocked tests.

## Scheduler and failure contracts

`src/scheduler.js` owns a FIFO queue, one active job, a timer, a next-start deadline and global pause/cancel/failure state. Each start computes the next deadline once using interval plus jitter. An active job holds its slot until response-body parsing and validation finish. Enqueued pagination, recursive mutation processing and retries cannot bypass the slot or deadline. Request timeouts abort via AbortController; actual browser fetch settles on abort before a retry starts. Stop rejects pending/active consumers, aborts transport and prevents all future starts. Cancellation cannot undo a write Reddit already received.

429/API RATELIMIT retains the explicitly rejected job and pauses the queue; Resume retries that job only after the deadline. A successful exhausted-quota response resolves its job and pauses subsequent work. Other failed mutations stop terminally without retries. Safe read failures get at most two retries. Missing modhash is rejected before dispatch. HTTP success alone is insufficient: listing shape/cursors, API errors and edit/delete acknowledgement contracts are checked.

Deletion's `{}` acknowledgement is the existing endpoint's success protocol; there is no independent confirmation request. Editing uses /api/editusertext.json without renderstyle=html, plus raw_json=1 and checks returned fullname and body/selftext. Changed formats fail conservatively and require inspection. No failure path turns a failed edit into `pdEdited=true`. Confirmed operation counts come from the scheduler; application discovery counts cannot inflate mutation counts when an item reappears.

`src/app.js` retains the original UI/options and filter/discovery/export logic. It adds the compact controls before requesting the inherited form. Partial exports include completed items only. Cooldown storage contains a timestamp and an estimate flag, no credentials or content. Storage errors fall back to in-memory enforcement. Multi-tab scheduling is not coordinated; use one tab.

`src/recovery.js` is bundled after the app and also built as standalone `recovery.js` for unrefreshed failed 2.0.0/2.0.1 tabs. It installs idempotently, makes no requests at installation, and wraps app-level failure/status/eligibility hooks without changing global network APIs or replacing source text. Only a terminal HTTP 403 permits explicit recovery. New schedulers expose failed operation/path/fullname metadata; older schedulers use the retained pending item/config to identify the rejected mutation, or the current page for a failed read. Ambiguous outcomes are never eligible.

On a confirmed recovery action, the helper recreates the transport through the existing `basicSettings` factory and reapplies its settings. Task state, confirmed IDs, filters and export stay intact; count baselines are adjusted and status counts include prior transports. Saved cooldowns and account/modhash checks remain enforced. A conservative interval plus maximum jitter separates replacement from the first request. Stop during that timer prevents dispatch. Reads retry the same failed page, removing only its failed-attempt cycle marker; skipped writes finish only the chosen item and enter a per-run exclusion map and downloadable audit log. A skipped edit cannot fall through to deletion. No pending-run persistence/import is provided. Logs and partial exports remain local downloads, not resumable checkpoints.

## Tests and maintenance

`test/helpers.js` supplies deterministic timers and transport fixtures. jsdom tests exercise the actual app with a minimal old Reddit DOM and mocked API responses. Loader tests use a VM with mocked document/fetch. `test/no-network.js` prevents live fetch and HTTP(S). Node's built-in test runner executes each file through scripts/test.js. Tests advance virtual time rather than sleeping or sending bursts. The live Reddit form, real accounts, rate limits and destructive endpoints are never tested against Reddit.

`npm run build` concatenates source into powerdeletesuite.js and generates both bookmarklet forms/README blocks. Commit both source and generated artifacts. `npm run verify` checks reproducibility, syntax, lint and all mocked tests. GitHub Actions runs the same verification on pushes and pull requests; it has read-only repository permissions.
