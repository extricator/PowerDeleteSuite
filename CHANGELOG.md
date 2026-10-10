# Changelog

## 2.0.1 — 2026-10-10

- Start with submission history when neither comment editing nor comment deletion is selected. Skip comment history entirely unless exporting; exports still discover comments after submissions. Preserve author search coverage, pagination and the global request scheduler.
- Add mocked coverage for all 15 nonempty action/export selections and submission-only deletion of self-posts, link posts and search results. Verify that submission-only mode never edits or deletes comments.

## 2.0.0 — 2026-10-10

Changes relative to Vaspyyy's `42e3a728cf58106fa5d628e86c9a5ebc786348c3` (`master`), preserving its full history and GitHub fork lineage:

- Add a centralized, dependency-injected Reddit scheduler. Default starts are 15 seconds plus 0–5 seconds jitter apart, with one in-flight request. History, pagination, search/sort/timeframe iteration, interface API loading, edit/delete operations and safe retries share it.
- Remove legacy five-second mutation-only timers and retry/skip confirmations that could falsely count failed edits or skip failed discovery pages.
- Pause on HTTP 429, HTTP-200 API rate-limit errors and exhausted `X-Ratelimit-Remaining`. Parse seconds/date Retry-After, reset headers and API wait messages. Require explicit Resume after the longest applicable cooldown; use a configurable 15-minute fallback estimate. Persist observed cooldowns on the current origin.
- Add Stop/Cancel, guarded Resume, countdown, compact settings, actual request/confirmed operation/failure counts and last error display. Offer partial exports on interruption.
- Bound safe read retries with exponential backoff. Stop on 403/authentication, malformed responses and other API failures. Do not automatically retry ambiguous mutations or count them as successful. Request raw edit responses via /api/editusertext.json without HTML rendering, and confirm edit identity/text; accept only the deletion endpoint's empty JSON acknowledgement. Failed edits block deletion.
- Use returned pagination cursors and detect repeated cursors. Avoid repeating confirmed edits/deletes across discovery sorts. Retain all original sections, sorts, timeframes, filters, exclusions and export options.
- Preserve Vaspyyy's `window.r.config.modhash` and `#config` fallback logic, `X-Modhash`/`uh` authentication and HTTP error helper. Fix the early-return validation path that could bypass authentication when using random edit text.
- Consolidate Issue #90's fetch/injection/overview/redirect workaround. Use Date.now, check response.ok, reject empty downloads and prevent duplicate instances. Point readable/minified bookmarklets, optional userscript, stylesheet and update links at extricator/PowerDeleteSuite on master.
- Remove the optional changelog lookup against Reddit; link directly to this fork's changelog. Replace bug-report links directed at the original author with this fork's issue tracker.
- Add editable source modules and reproducible single-file builds, mocked Node/jsdom tests with fake timers and network guards, ESLint, syntax/generated-output checks and GitHub Actions.
- Document the source comparison, full request audit, operating behavior, installation, troubleshooting and limitations. Tests do not contact Reddit or use real account actions.

## Inherited from Vaspyyy

- `c606d87` — old Reddit modhash extraction, authenticated header/form submission, missing-auth protection and improved mutation error diagnostics.
- `42e3a72` — README attribution and a maintained-fork bookmarklet using fetch/Date.now and old Reddit redirect. The checked-in bookmarklet and userscript were older than the README; 2.0.0 reconciles them.

Original application, interface, discovery, filters and export functionality: j0be/PowerDeleteSuite and its contributors. The checked-in stylesheet inherited from Vaspyyy is preserved byte-for-byte.
