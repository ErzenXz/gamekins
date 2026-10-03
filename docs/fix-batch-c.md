# Fix batch C — security, sessions, process tracking, data safety

Implement fixes for these findings from `docs/codex-review.md`: **#8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #19, #20, #24 (partial), #25, #32, #33, #34, #35 (non-installer parts), #39 (main part), #40 (main part), #42**, plus the main-process/API parts that batches A and D asked for in `docs/fix-batch-a-report.md` and `docs/fix-batch-d-report.md` (read both first).

## Files you may edit
Everything under `src/main/**`, `src/preload/**` and `src/shared/**`. You may also make small, necessary edits to `src/renderer/**`: when an API you change is consumed there, and in `src/renderer/src/lib/devMock.ts`, which must keep implementing the full API. Batches A (installer/downloads) and D (renderer) have already finished; keep their work intact.

## Guidance (pragmatic, production-quality)
- **#8 / #9:**
  - One main-process operation coordinator keyed by install group: the base game key, with DLC mapping to its base game.
  - Launch, stop, move, uninstall, install, repair, update, queue resume, and auto-updates acquire it synchronously before any await.
  - Running games always block writes to their own group, regardless of the gameplay-downloads setting.
  - Moves:
    - Acquire the lock first.
    - Reject destinations that equal, contain, or are inside the source.
    - Cross-drive moves copy into a uniquely named staging folder, then rename it into place, update the records, and only then delete the source.
    - On failure, remove only the staging folder.
    - Reject moving non-Epic ("local") games.
- **#10 / #11 / #12:**
  - Track the launched PID plus PIDs found under the game's folder. For macOS `.app` bundles, the bundle is the boundary.
  - For local (non-Epic) games, never treat every process in the executable's parent folder as the game: use the spawned process tree, or the exact executable path.
  - Stop terminates only tracked processes, verifies they exited, and reports survivors as an error without clearing "running".
  - Process-scan failures must be distinguishable from "no processes".
  - Never overlap scans: schedule the next scan after the previous one completes.
  - Cache `{pid, executablePath}` and re-verify identity on rescans.
- **#13:** Checkpoint play time of running sessions every minute, and on quit (via `flush`), without ending the session.
- **#14:**
  - Make the migration safe: never overwrite destination files that are newer than the source, and write the marker even when the copy partially fails, so a retry can't clobber newer data.
  - Move the single-instance lock check BEFORE the migration and the stores load. This likely means a tiny entry module that checks the lock and then dynamically imports the rest. Make sure `electron-vite` builds it and `package.json` `main` still points to the right file.
- **#15 / #16:**
  - Account generation counter. Login, refresh and library commits verify it before saving.
  - Logout clears the Epic partition's cookies and storage.
  - OAuth token grants get exactly one attempt, no retries.
  - Session file writes are atomic.
- **#17:** `JsonStore`:
  - Validate that loaded data has the expected shape. Merge field by field with the defaults, falling back to the default when a value's type doesn't match.
  - Quarantine a corrupt file as `<name>.corrupt-<ts>.json`.
  - Catch write errors, log them and retry later. Never throw out of a timer.
- **#18:** Owned games whose catalog fetch failed keep their previous cached metadata, or get a minimal placeholder, instead of vanishing. Report a partial-refresh error.
- **#19:** Destructive operations such as DLC uninstall require an exact manifest match (manifestId or appName). Never fall back to "largest manifest" for deletion.
- **#20:** Don't delete install records when a drive is unplugged: mark them unavailable (add an optional `unavailable?: boolean` to `InstalledInfo`, and make the renderer show the game as not playable with a "Drive not connected" hint). Expire negative adoption-cache entries after 24 h, and re-check executable existence.
- **#24, partial:** Use async `zlib.inflate` (promisified) for chunk decoding if batch A didn't already. Moving the parser into a worker is optional; do it only if it's simple and safe.
- **#25:** Cache the composed library with a revision counter and a shared `Intl.Collator`. The tray rebuilds only when its recent-games or running state actually changes.
- **#32:**
  - Validate the IPC sender: only the main window's main frame on the app's own URL.
  - Validate arguments at runtime per channel (types, finite numbers, bounds, known keys, enums), using small hand-written validators with no new dependencies.
  - Settings patches accept only known keys with valid values: `maxWorkers` 1–64, `bandwidthLimitMBps` ≥ 0, booleans, and an absolute path for `installDir`.
- **#33:** One `openExternalSafe(url)` helper allowing only http/https, used everywhere, including webview navigation and the context menus.
- **#34:**
  - Set `prefs.partition` correctly in `will-attach-webview`, and force `webSecurity`.
  - Guard redirects (`will-redirect`) and in-page navigations.
  - Deny all permission requests and checks on the Epic partition, except clipboard-sanitized-write and fullscreen if needed.
  - Prevent the main window from navigating away from the app document (`will-navigate`).
- **#35 (non-installer):** Encode or hash app names before using them as filenames (manifests, OVT files). Canonical path checks in uninstall and DLC file removal.
- **#39 (main):** `listPrograms` returns shortcut arguments and working directories, dedupes after resolving shortcuts, and checks the result of `shell.openPath`.
- **#40 (main):** On macOS, storage resolves the actual volume of each install path.
- **#42:** Prerequisites get a timeout (10 min) and don't block the queue forever. Record failure in `prereqsInstalled = false` and surface it.

## Hard rules
- **NO network downloads of game data, and no live Epic API calls.** Do not run the integration harness. The user is on a limited connection.
- Do not launch the Electron app (the user may be gaming); the browser mock at http://localhost:5174 is fine for UI checks.
- `npm run typecheck` and `npx electron-vite build` must pass.
- Do not commit or run any git command that changes state.

Final report: per finding, what changed, what was deferred and why.
