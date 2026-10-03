# Fix batch A — download & installer integrity

Implement fixes for these findings from `docs/codex-review.md`: **#1, #2, #3, #4, #5, #7, #21, #22, #23, #26** and the installer-side parts of **#35** and **#36**.

## Files you may edit
- `src/main/core/downloads.ts`
- `src/main/providers/epic/installer.ts`
- `src/main/providers/epic/manifest.ts`
- `src/main/providers/types.ts` (additive changes only)
- New files under `src/main/core/` or `src/main/providers/epic/` if helpful (for example a `fsBoundary.ts` helper)

Do NOT edit anything under `src/renderer/**` (another engineer is changing it right now), and do not edit `src/main/index.ts`, `src/main/core/library.ts`, `src/shared/**` or `src/preload/**`. If a fix truly needs a change there, describe it in your final report instead of making it.

## Guidance (pragmatic, production-quality, not over-engineered)
- **#1:** Record on the job whether this job created the install folder. Persist a `createdFolder` flag, or a `.lodestar/owner` marker file containing the job id written when the folder was created. Only recursively delete on cancel when that is true. Never recursively delete for DLC jobs or when the game's metadata is missing.
- **#2 / #3:**
  - Keep the active run's promise. `cancel` and `pause` must abort it and await it before cleanup.
  - Give each run a generation/stop reason so late progress callbacks can't overwrite `paused`/`queued`/`cancelled`, and no job is left `downloading` with nothing active.
  - In the installer: on exit (success or failure), abort the internal controller, await outstanding chunk fetches with `allSettled`, close all file handles, and check the signal before every part write and before finalizing.
- **#4:** Stage the replacement of ANY existing regular file (repair, and updates without an old manifest) via the existing `.lodestar-tmp` staging plus promotion at commit. Never truncate a live file. Note: the rename from Vapor to Lodestar changed the staging suffix and folder names; check `installer.ts` for the current `STAGE_SUFFIX` and resume-log path, and keep them consistent.
- **#5:** Bind resume entries to the manifest's hash (for example SHA-1 of the manifest bytes) instead of the version string. Before trusting a resume entry, check that the (staged or final) file exists with the right size. A cheap size check is enough, because files are already SHA-1-verified when written. Missing staged files at finalize must be re-written, not silently skipped.
- **#6, partial:** Write the saved manifest atomically (tmp + rename). A full commit journal is out of scope; leave a short note.
- **#7:** Loop on `FileHandle.write` until the whole slice is written, and treat zero progress as an error. Check the final file size before marking it complete.
- **#21:** `queueUpdates` must skip games with `thirdPartyManagedApp`.
- **#22:** Throttle while reading the response body. Read the body as a stream in slices (for example 64 KiB) and take tokens per slice. Remove the `bytes > limit` bypass.
- **#23:** Hard memory budget of about 128 MiB for chunk buffers. Reserve before fetching, including in `take()`. Allow re-downloading (eviction) of chunks whose next use is far away, instead of pinning them, so progress never needs more than the budget. Charge completed buffers before pumping more.
- **#26:**
  - Throttle disk persistence of the queue: checkpoint on state transitions immediately, and on progress at most every ~5 s.
  - Cap `speedHistory`/`diskHistory` as they are now, and drop the histories from finished jobs.
  - Keep the `downloads` IPC event payload shape unchanged; the renderer depends on it.
- **#35 (installer):** Before writing, verify that the install root and each file's parent directory resolve, via `realpath` on existing ancestors, inside the canonical install root. Reject symlink targets that are absolute or escape the root. Reject duplicate or absolute manifest paths.
- **#36 (manifest.ts):** Bounds-check the reader (no short reads; counts limited by the remaining bytes). Cap decompression output to the declared sizes (`inflateSync` with `maxOutputLength`). Strip a BOM or leading whitespace before detecting JSON manifests.

## Hard rules
- **NO network downloads of game data, and do not run the integration harness or any live Epic download.** The user is on a limited connection. Pure unit-style checks with in-memory or mocked data are fine.
- Do not launch the Electron app.
- `npx tsc --noEmit -p tsconfig.node.json` must pass, and `npx electron-vite build` must succeed.
- Do not commit or run any git command that changes state.
- Keep the existing code style: TypeScript strict, small focused helpers, comments only where they explain why.

Final report: per finding, what you changed (file and function), anything you deferred and why, and any changes needed outside your allowed files.
