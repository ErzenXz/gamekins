Reviewed all source files under `src/main`, `src/preload`, `src/shared`, and `src/renderer`, including styles, plus README and build configuration. The working tree changed during the review; findings below reflect commit `7cb8f13` and the subsequently read CSS change. **I modified no files.**

The architecture is sensible, and the latest changes improve route splitting, process polling, install-adoption caching, and off-screen rendering. However, several **P1 issues can delete unrelated files, corrupt installations, lose cancellation state, or kill unrelated programs**. I would address those before release. No P0 was established.

Both TypeScript projects passed no-emit checks. An in-memory renderer build produced a **344.3 kB entry chunk, 13.1 kB shared chunk, and 111.5 kB CSS**, with six separately loaded views/dialogs. Mocked, in-memory execution reproduced the pause-state race, bandwidth-limit bypass, short-write acceptance, and cancellation during finalization. Live Epic downloads, UAC, and macOS execution were not exercised.

1. **P1 — Cancellation can recursively delete an existing folder, including a DLC’s parent.**  
   **Location:** `src/main/core/downloads.ts:194`, `src/main/core/downloads.ts:204`, `src/main/providers/epic/index.ts:409`.

   **Problem/cost:** Cleanup infers folder ownership from `kind === 'install'`, current library metadata, and absence of an installed record. It never establishes that this job created the directory. Two sanitized titles can select the same directory; an existing directory can contain unrelated files. After logout removes a DLC record, `!game?.dlcOf` becomes true, allowing cancellation of that DLC install to delete its base game’s directory.

   **Exact fix:** Persist immutable job fields identifying provider, app, parent, and folder ownership. Create fresh installation directories exclusively; reject nonempty existing directories unless using the import flow. Record a matching owner marker before downloading. Recursively delete only a directory created and owned by that job. Missing library metadata must disable recursive deletion.

2. **P1 — Cancel returns without waiting for downloads and writes to stop.**  
   **Location:** `src/main/core/downloads.ts:203`, `src/main/providers/epic/installer.ts:437`, `src/main/providers/epic/installer.ts:493`.

   **Problem/cost:** A fixed 500 ms delay is not a completion barrier. The writer checks cancellation between files, not between parts; prefetch promises are neither aborted nor drained when writing fails. Cancel/uninstall can remove files while old workers still write, and the next queue job can start while previous network work remains alive.

   **Exact fix:** Store the active execution promise alongside its controller. Cancel must abort and await that promise before cleanup. Give each installer an internal controller combined with the caller’s signal; in `finally`, abort it, await all outstanding fetch promises with `Promise.allSettled`, close handles, and clear buffers. Check cancellation before every part, after awaited reads/writes, and before finalization. Replace recursive suffix cleanup with a per-job staging-file inventory.

3. **P1 — Late progress overwrites pause/preemption state and strands the queue.**  
   **Location:** `src/main/core/downloads.ts:158`, `src/main/core/downloads.ts:290`, `src/main/core/downloads.ts:296`.

   **Problem/cost:** Pause sets `paused`, but preparation completion or a late progress callback can set `downloading` again. The aborted catch assumes the requested state survived. Reproduction ended with **`state: downloading`, `active: false`**; `pump()` then ignores the stranded job.

   **Exact fix:** Give each execution a generation ID and explicit stop reason. Ignore progress when its signal is aborted, its generation is obsolete, or its job is no longer active. Call `signal.throwIfAborted()` after preparation. On abort, explicitly restore `paused`, `queued`, or `cancelled` from the stop reason instead of relying on prior mutations.

4. **P1 — Repair truncates live files before replacements are verified.**  
   **Location:** `src/main/providers/epic/installer.ts:148`, `src/main/providers/epic/installer.ts:433`, `src/main/providers/epic/installer.ts:515`.

   **Problem/cost:** Only updates with a known old manifest stage replacements. Repair and updates without that manifest open live files with `'w'`. Cancellation, a network error, or disk exhaustion can destroy an existing executable or archive. The claim that cancelled repair preserves the current installation is therefore false.

   **Exact fix:** Stage every replacement of an existing regular file, independently of operation kind and manifest availability. Verify and close the staging file before promotion. Leave originals intact until commit. Calculate required staging space for updates and repairs as well as fresh installs.

5. **P1 — Resume logs are trusted without checking the completed files.**  
   **Location:** `src/main/providers/epic/installer.ts:105`, `src/main/providers/epic/installer.ts:155`, `src/main/providers/epic/installer.ts:226`.

   **Problem/cost:** A matching build-version string and filename are enough to skip writing. Deleted, truncated, or externally modified files remain “complete.” Missing staged files are silently skipped during finalization, which can still record the new version.

   **Exact fix:** Bind resume records to the downloaded manifest’s digest, not just its version string. Before honoring an entry, identify the expected staged or committed file and validate its size and SHA-1. Remove invalid entries and requeue those files. Make durability ordering explicit: finish and flush the file before recording completion.

6. **P1 — Update promotion has no recoverable transaction.**  
   **Location:** `src/main/providers/epic/installer.ts:223`, `src/main/providers/epic/index.ts:432`.

   **Problem/cost:** Files are renamed individually, removed files are deleted, and the installed manifest is then overwritten non-atomically. A crash can leave mixed versions or a truncated manifest. Cancellation during finalization is ignored; the in-memory reproduction aborted at `finalizing` but still saved the manifest and returned the new version.

   **Exact fix:** Persist a commit journal containing the target manifest digest and each promotion/deletion. Write the journal before modifying originals; record completed promotions durably. Recover unfinished commits before permitting launch or another operation. Write manifests using temporary-file-plus-rename. Cancellation before commit should preserve originals; cancellation during commit must trigger deterministic rollback or completion.

7. **P1 — Short writes pass the installer’s integrity check.**  
   **Location:** `src/main/providers/epic/installer.ts:450`.

   **Problem/cost:** `FileHandle.write()` returns `bytesWritten`, but the installer ignores it, hashes the intended buffer, and credits its full length. A mocked four-byte write that wrote only one byte was accepted and appended to the resume log. [Node’s write API exposes the actual written count.](https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position)

   **Exact fix:** Loop until the entire slice is written, advancing the buffer offset by `bytesWritten`; treat zero progress as an error. Update hashing/progress only after the full slice succeeds. Verify final file length before marking it complete.

8. **P1 — File-operation exclusion is incomplete and enforced at the wrong layer.**  
   **Location:** `src/main/index.ts:54`, `src/main/index.ts:399`, `src/main/index.ts:410`, `src/main/core/library.ts:279`, `src/main/core/downloads.ts:218`.

   **Problem/cost:** IPC checks omit launches in progress, and move checks only the base game’s download. Tray and protocol launches bypass the IPC moving check. Resumed and automatic downloads bypass move guards. With downloads during gameplay enabled, the queue can modify the running game itself. A launch awaiting authentication can race uninstall or move.

   **Exact fix:** Introduce one main-process operation coordinator keyed by base game/shared installation directory. Acquire it synchronously before any `await`. Require launch, stop, move, uninstall, install, repair, update, queue resume, and automatic updates to use it. Running games must always exclude writes to their own installation group, regardless of the global gameplay-download preference.

9. **P1 — Moves can lose location metadata or leave unrecoverable partial destinations.**  
   **Location:** `src/main/index.ts:418`, `src/main/index.ts:425`, `src/main/core/library.ts:214`.

   **Problem/cost:** The moving flag is acquired after `mkdir`, creating a race. Cross-volume copy deletes the source before the new location is durably recorded. A crash can leave metadata pointing at a deleted source; copy failure leaves a target that blocks retries. Source/descendant destinations are not rejected. Local and adopted-provider records are not relocated consistently.

   **Exact fix:** Acquire the installation-group lock first. Canonicalize paths and reject equal, ancestor, and descendant destinations using platform-appropriate comparison. Copy into a uniquely named staging directory, verify it, persist a relocation journal, promote it, durably update provider/library records, then delete the source. Recover or remove only the journal’s partial target after failure. Explicitly reject unsupported local-game moves.

10. **P1 — “Stop” can kill unrelated programs.**  
    **Location:** `src/main/providers/local/index.ts:84`, `src/main/core/processes.ts:53`, `src/main/core/library.ts:376`.

    **Problem/cost:** Local installs use `dirname(executable)` as their process-ownership boundary. For `/Applications/Game.app`, that becomes `/Applications`; Stop selects other applications running underneath it. Windows programs sharing one directory have the same problem. Tracking can also count unrelated applications as game playtime.

    **Exact fix:** Track the launched PID, creation time, executable identity, and verified descendants. For macOS applications, use the `.app` bundle itself as the boundary. For ordinary local executables, do not infer ownership of every process in their parent directory. Terminate only verified members of the tracked process tree.

11. **P1 — Stop reports success even when processes survive.**  
    **Location:** `src/main/core/processes.ts:13`, `src/main/core/processes.ts:58`, `src/main/core/library.ts:372`.

    **Problem/cost:** Process enumeration errors become empty output; termination errors are swallowed; `stop()` immediately calls `finish()`. Access-denied processes can remain running while the UI clears “Running” and the queue resumes updates against their files.

    **Exact fix:** Return a distinguishable enumeration failure instead of an empty successful scan. Await termination, verify tracked process identities have exited, and report surviving processes. Keep the running/install lock until termination is confirmed. Never treat an unknown scan result as proof that a game stopped.

12. **P2 — Slow process scans overlap, and cached PID checks cannot detect PID reuse.**  
    **Location:** `src/main/core/library.ts:29`, `src/main/core/library.ts:332`, `src/main/core/processes.ts:15`.

    **Problem/cost:** The improved fast path avoids scanning during normal direct launches, but unknown/handoff launches still use an async five-second interval around a scan with a fifteen-second timeout. Several PowerShell processes can overlap. A reused cached PID can keep a game marked running indefinitely.

    **Exact fix:** Use one scan promise or a recursive timeout scheduled after completion. Back off while launch identity remains unknown. Cache `{pid, creationTime, executable}` rather than PID alone, and revalidate identity periodically. Discard scan results belonging to obsolete running-session generations.

13. **P1 — Quit/restart loses live-game protection and the session’s playtime.**  
    **Location:** `src/main/core/library.ts:356`, `src/main/core/library.ts:390`, `src/main/index.ts:507`, `src/main/index.ts:519`.

    **Problem/cost:** Elapsed playtime is added only by `finish()`; `flush()` does not checkpoint active sessions. After restart, the running map is empty and downloads start immediately, even if a detached game is still running.

    **Exact fix:** Persist incremental playtime checkpoints and active-session identities without ending the session. On startup, reconcile persisted PIDs/executables before resuming downloads. Gate jobs touching those installation groups until reconciliation finishes. Quit should also drain or checkpoint active installer work.

14. **P1 — Failed migration can overwrite newer data on the next launch.**  
    **Location:** `src/main/migrate.ts:42`, `src/main/migrate.ts:46`, `src/main/index.ts:453`.

    **Problem/cost:** Migration copies with `force: true`. If copying fails halfway, the application continues and writes new data without a migration marker. The next launch repeats migration and overwrites that newer data with the old application’s files. Migration and store construction also precede the single-instance lock.

    **Exact fix:** Put lock acquisition in a minimal entry module, then dynamically import migration/bootstrap only for the owning instance. Use a migration journal and staged copies; preserve existing destination data. Record per-item completion and make retries idempotent. A failed migration must never blindly recopy over live destination stores.

15. **P1 — Logout/cancelled login can be undone by older asynchronous work.**  
    **Location:** `src/main/providers/epic/index.ts:119`, `src/main/providers/epic/index.ts:187`, `src/main/providers/epic/index.ts:209`, `src/main/core/library.ts:154`.

    **Problem/cost:** An outstanding refresh can save a new session after logout. A login exchange can save credentials after its window was closed and the promise rejected. Library refresh can repopulate a provider after `forgetProvider()`. Shared store cookies also survive logout.

    **Exact fix:** Add an account generation and cancellation controller. Capture the generation for login, token refresh, and library requests; verify it immediately before saving credentials or committing results. Increment it on logout/cancellation and clear in-flight references. Enforce one login promise in main. Clear the Epic partition’s relevant cookies/storage and reset its guest on logout. Persist session files atomically.

16. **P2 — One-use OAuth exchanges are retried automatically.**  
    **Location:** `src/main/providers/epic/api.ts:125`.

    **Problem/cost:** The code explicitly warns against replaying token exchanges but still gives them two attempts. If Epic consumes an authorization code and the response is lost, replay can return an invalid-code error; rotating refresh-token exchanges have the analogous risk.

    **Exact fix:** Use one attempt for authorization-code and refresh-token grants. Separate retryable reads from credential-changing operations. Preserve existing session state on ambiguous transport failure and require a controlled recovery flow rather than treating replay rejection as definitive expiry.

17. **P1 — Valid but malformed persisted JSON can prevent startup; persistence failures can escape main.**  
    **Location:** `src/main/core/store.ts:28`, `src/main/core/store.ts:47`, `src/main/core/store.ts:54`, `src/main/core/downloads.ts:65`.

    **Problem/cost:** Parsing success is treated as schema validity. `{"jobs":null}` reaches a `for…of` during module construction; `games:null` breaks library operations. Disk-full, permission, and rename errors escape the timer callback or shutdown flush. Atomic rename protects file replacement, not the application from those exceptions.

    **Exact fix:** Supply a runtime schema/version migration to each store and validate nested collections and settings. Quarantine invalid input and retain a usable backup. Serialize asynchronous atomic writes through one writer queue; catch failures, retain dirty state, retry appropriately, and surface a recoverable persistence error. Await durable flush where transaction correctness requires it.

18. **P2 — Partial catalog failures silently turn owned games into missing games.**  
    **Location:** `src/main/providers/epic/index.ts:233`, `src/main/providers/epic/index.ts:245`, `src/main/core/library.ts:155`.

    **Problem/cost:** Individual catalog errors are swallowed; records without metadata are omitted. The resulting partial list replaces the provider cache as if complete. Games disappear without a refresh error, potentially leaving queued operations with “no longer in your library.” Catalog entries also have no freshness policy.

    **Exact fix:** Treat ownership records as authoritative independently of metadata fetch success. Preserve prior metadata or create a minimal placeholder for unresolved owned records, and report partial refresh errors. Key catalog entries by namespace and item ID and add a TTL/version policy. Coalesce refreshes and reject obsolete results.

19. **P1 — DLC manifest lookup can fall back to the base game’s manifest.**  
    **Location:** `src/main/providers/epic/launcherData.ts:113`, `src/main/providers/epic/index.ts:505`.

    **Problem/cost:** When an exact manifest ID/app match fails, lookup returns the largest manifest. During DLC uninstall, that can supply the base game’s file list. Uninstall also prefers any Lodestar manifest that exists, even when the current install came from Epic and that manifest is stale.

    **Exact fix:** Require exact identity for DLC and destructive operations; return an explicit missing-manifest error when it cannot be established. Choose the manifest according to installation source, app identity, and recorded version/digest. Never use “largest manifest” as authority for deleting files. For shared files, exclude paths still owned by another installed manifest.

20. **P2 — Install reconciliation mistakes unavailable storage for removal, and adoption caches miss file-only changes.**  
    **Location:** `src/main/core/library.ts:182`, `src/main/providers/epic/index.ts:342`, `src/main/providers/epic/index.ts:365`.

    **Problem/cost:** Unplugging a drive deletes installed records. Reconnecting does not necessarily restore Lodestar-created installations. Adoption results—including negative results—are cached solely by manifest signature: restoring a missing executable or claiming a previously unmatched game does not invalidate that cache.

    **Exact fix:** Keep installation records with an `available/unavailable` state; reserve removal for explicit uninstall or confirmed deletion. Include matching-account/catalog generation in adoption-cache validity. Recheck critical executable existence and expire negative entries. Invalidate size/pack information when installation files change.

21. **P2 — Automatic updates ignore third-party installer ownership.**  
    **Location:** `src/main/core/downloads.ts:337`, `src/main/index.ts:343`.

    **Problem/cost:** Installation routes EA/Ubisoft-managed titles through the official launcher, but automatic updates enqueue them into the direct Epic pipeline. This can create repeated failures or modify launcher-managed payloads using an unsupported flow.

    **Exact fix:** Skip `thirdPartyManagedApp` in direct automatic updates. Expose explicit provider/game capabilities for install, update, repair, and move; enforce them in main as well as the UI. Route supported third-party maintenance through its owning launcher.

22. **P2 — The bandwidth cap is ineffective for chunks larger than the configured rate.**  
    **Location:** `src/main/core/downloads.ts:42`, `src/main/providers/epic/installer.ts:336`.

    **Problem/cost:** `bytes > limit` immediately admits the transfer, and throttling occurs after the entire response has downloaded. Reproduction admitted 2 MiB immediately at 1 MiB/s. Low caps can therefore leave sixteen workers consuming full connection bandwidth.

    **Exact fix:** Read response bodies in bounded slices and await shared token availability before advancing each read. Account for every byte; remove the oversized-transfer bypass. Use abortable waits and bound request concurrency/burst size separately.

23. **P1 — The chunk cache’s nominal 768 MiB limit is not a hard bound.**  
    **Location:** `src/main/providers/epic/installer.ts:32`, `src/main/providers/epic/installer.ts:393`, `src/main/providers/epic/installer.ts:420`.

    **Problem/cost:** Chunks remain pinned until their final reference, while `take()` can start a fetch outside budget checks. A manifest that references many chunks in early files and again in a late file can retain the whole set. `pump()` also runs before the completed buffer is charged. Memory can exceed 768 MiB, with compressed/raw buffers adding further overhead.

    **Exact fix:** Reserve actual per-request memory before starting work and release reservations only after buffer disposal. Use a smaller hard budget, approximately 64–128 MiB. Allow eviction/re-download or bounded disk spooling for distant references so progress never requires retaining every shared chunk. Ensure completion accounting precedes further pumping.

24. **P2 — Manifest parsing, decompression, and some filesystem probes run on main’s event loop.**  
    **Location:** `src/main/providers/epic/manifest.ts:126`, `src/main/providers/epic/manifest.ts:306`, `src/main/providers/epic/installer.ts:275`.

    **Problem/cost:** Every compressed chunk uses `inflateSync`; large manifests are also inflated and parsed synchronously. Optional-content selection uses synchronous existence probes. At high throughput or on slow storage, download work competes directly with IPC, window actions, and progress delivery.

    **Exact fix:** Run parsing/decompression and installation planning in a worker or utility process with bounded messages and transferable buffers. Replace selection-time synchronous probes with bounded asynchronous metadata reads. Keep orchestration and small state updates in main.

25. **P2 — Tray updates repeatedly compose and sort the whole library.**  
    **Location:** `src/main/core/library.ts:66`, `src/main/core/library.ts:78`, `src/main/core/library.ts:384`, `src/main/core/tray.ts:53`.

    **Problem/cost:** Approximately every three seconds during downloads, the tray rebuilds unchanged menu contents through `recent() → list()`, composing all games and sorting all titles. `localeCompare` with options is particularly expensive. On this machine, 25 synthetic 1,000-title sorts averaged **46.15 ms**, versus **1.71 ms** with a cached collator.

    **Exact fix:** Cache an `Intl.Collator` and sorted provider order. Maintain a revisioned composed-library cache and DLC index. Derive five recent games without title-sorting everything. Rebuild the menu only when recent titles/running states change; update the tooltip only when its displayed value changes.

26. **P2 — Download ticks serialize and persist the entire historical queue.**  
    **Location:** `src/main/core/downloads.ts:95`, `src/main/core/downloads.ts:246`, `src/main/index.ts:61`, `src/main/core/store.ts:45`.

    **Problem/cost:** Each progress emission sends every job and its histories and schedules a full JSON save. With matching 250 ms timers, persistence can repeatedly write or keep postponing the checkpoint. Work continues when the window is hidden. Finished histories accumulate until manually cleared.

    **Exact fix:** Separate durable queue transitions from volatile telemetry. Send small active-job deltas; publish histories at their one-second sampling rate and preserve unchanged references. Checkpoint progress on a longer interval plus pause/quit, with a maximum wait. Reduce or suppress hidden-window telemetry and send a fresh snapshot on show. Prune retained history automatically.

27. **P2 — The grid retains every tile, and collection shelves are completely unvirtualized.**  
    **Location:** `src/renderer/src/components/library/libraryData.ts:194`, `src/renderer/src/views/library/GameGrid.tsx:52`, `src/renderer/src/views/LibraryHome.tsx:145`.

    **Problem/cost:** Progressive rendering eventually mounts the entire library, including each tile’s hooks and image state. Games are mounted again in each applicable collection shelf. The new `content-visibility` rule reduces off-screen rendering work but does not remove React elements, subscriptions, or retained image state; shelves do not receive that rule.

    **Exact fix:** Virtualize grid rows with measured columns and small overscan, preserving group headings and keyboard navigation. Virtualize horizontal shelf items independently. Keep only visible/intersecting shelves mounted. Do not use progressive mounting as the final large-library strategy.

28. **P2 — Derived library data and selectors repeat scans across subscribers.**  
    **Location:** `src/renderer/src/components/library/libraryData.ts:13`, `src/renderer/src/components/library/libraryData.ts:93`, `src/renderer/src/views/shell/StorageManager.tsx:20`, `src/renderer/src/views/shell/StorageManager.tsx:178`.

    **Problem/cost:** Every `useLibraryGames()` instance separately filters/sorts. Storage rows each search the games array on store updates; the storage signature reconstructs a library-length string on download ticks. Whole-percent job changes still propagate a new map through all shelves/grids, even for one affected game.

    **Exact fix:** Maintain stable `gamesByKey`, `jobsByKey`, sorted keys, collection membership, and installation revisions. Share derived caches across hook instances. Subscribe tiles/rows by key to their displayed fields. Preserve unchanged entity references when applying IPC updates rather than replacing the complete object graph.

29. **P2 — Store unloading is delayed by unrelated navigation and ignores game/background transitions.**  
    **Location:** `src/renderer/src/App.tsx:52`, `src/renderer/src/views/StoreView.tsx:174`.

    **Problem/cost:** Every non-store view change restarts the ten-minute timeout. Regular navigation can keep the guest alive indefinitely; launching a game or hiding the window does not unload it. Hiding the wrapper retains the guest’s process/resources and does not explicitly stop network work or audio.

    **Exact fix:** Start the timeout only on the transition away from Store, using a stored “last used” timestamp. Add a shorter resource policy for hidden windows and running games. Persist the current URL, mute hidden guests, and destroy idle guests when appropriate. Handle `render-process-gone` by resetting readiness and offering guest recreation.

30. **P2 — GamePage, collections, and all route CSS remain startup dependencies.**  
    **Location:** `src/renderer/src/views/LibraryView.tsx:8`, `src/renderer/src/views/LibraryView.tsx:9`, `src/renderer/src/main.tsx:5`.

    **Problem/cost:** The new lazy routes/dialogs work, but visiting Library Home still parses GamePage and CollectionsPage. All styles are imported by the entry, so `cssCodeSplit: true` cannot defer their route-specific rules.

    **Exact fix:** Lazy-load GamePageHost and collection views with local Suspense boundaries. Move route-specific CSS into modules imported by those routes, leaving tokens/shell/shared components eager. Extract `LodestarMark` from TitleBar so route modules do not depend on a large shell component for one asset.

31. **P2 — Image backgrounds bypass intended lazy loading; custom artwork inflates persisted/IPC state.**  
    **Location:** `src/renderer/src/components/Capsule.tsx:61`, `src/main/core/extras.ts:13`, `src/main/core/library.ts:108`.

    **Problem/cost:** Every shelf capsule creates an image background for its hidden glow; the `<img loading="lazy">` policy does not govern that background. Custom artwork is synchronously decoded/resized and stored as base64 inside game state, then repeatedly included in whole-library messages.

    **Exact fix:** Assign glow backgrounds only after visibility/hover intent or image loading. Cache appropriately sized artwork as files and expose opaque URLs through a restricted application protocol. Keep artwork identifiers in JSON/IPC. Bound source dimensions/pixel count and perform decoding/resizing outside main.

32. **P1 — IPC handlers authenticate neither the sender nor runtime arguments.**  
    **Location:** `src/main/index.ts:270`, `src/main/index.ts:388`, `src/main/index.ts:442`, `src/preload/index.ts:3`.

    **Problem/cost:** The central wrapper discards the event and casts arguments to TypeScript types. Arbitrary patches can persist invalid settings—for example `NaN` worker counts or negative bandwidth—and privileged filesystem operations accept unchecked payloads. A navigated or compromised frame can use the exposed bridge. [Electron explicitly recommends validating IPC senders.](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)

    **Exact fix:** Require the current main window’s `webContents`, its main frame, and the exact trusted application URL; reject other senders. Add per-channel runtime schemas with strict allowed fields, bounded arrays/strings, enums, finite worker counts within supported limits, and nonnegative bandwidth. Validate game/provider existence and capabilities centrally. Canonicalize filesystem arguments before use.

33. **P1 — Webview navigation forwards arbitrary protocols to the operating system.**  
    **Location:** `src/main/index.ts:169`, `src/main/index.ts:182`, `src/main/index.ts:190`.

    **Problem/cost:** The IPC external-link helper restricts schemes, but webview navigation and context-menu handlers call `shell.openExternal()` directly. Remote content can trigger an OS protocol handler or open a local/network resource through those paths.

    **Exact fix:** Use one main-process external-link helper everywhere. Parse the URL and allow only explicitly supported HTTP(S) links. Handle Epic launcher links internally after strict parsing; reject all other schemes. Require user interaction for launching external links and handle rejected promises.

34. **P1 — Webview lockdown misses session enforcement, redirects, and permission policy.**  
    **Location:** `src/main/index.ts:139`, `src/main/index.ts:186`, `src/renderer/src/views/StoreView.tsx:85`.

    **Problem/cost:** Assigning `params.partition` occurs after Electron constructs the preferences object; the guest is created from those preferences, so the partition is not forcibly overridden. Only `will-navigate` checks destinations; redirects and programmatic `loadURL()` need separate validation. No remote-session permission handlers are configured. [Electron’s implementation shows the preference ordering](https://github.com/electron/electron/blob/main/lib/browser/guest-view-manager.ts), and [its navigation documentation distinguishes programmatic loads and redirects](https://www.electronjs.org/docs/latest/api/web-contents#event-will-navigate).

    **Exact fix:** Set `prefs.partition = EPIC_PARTITION` and force safe web preferences, including `webSecurity`. Validate every programmatic load through a main-owned API and guard top-level redirects. Lock the main application window against navigation away from its application document. Configure permission-request and permission-check handlers on the Epic session with an explicit allowlist/default denial. [Electron otherwise automatically approves permission requests by default.](https://www.electronjs.org/docs/latest/tutorial/security#5-handle-session-permission-requests-from-remote-content)

35. **P1 — Lexical path checks do not prevent symlink/junction escapes.**  
    **Location:** `src/main/providers/epic/installer.ts:290`, `src/main/providers/epic/installer.ts:477`, `src/main/providers/epic/index.ts:515`.

    **Problem/cost:** `resolve()` rejects textual `..` escapes but does not inspect existing filesystem links. A path underneath the installation directory can traverse a junction into another directory; writes, hashing, chmod, and manifest-based deletion then affect files outside the install. Manifest symlink targets are accepted unchecked. Raw app names also become manifest/OVT filenames.

    **Exact fix:** Use a shared filesystem-boundary helper that checks canonical root and existing ancestors with `lstat/realpath`, rejects unexpected links/reparse points, and validates symlink destinations. Reject absolute, root-equal, escaping, and duplicate manifest paths before installation. Encode/hash app identifiers for metadata filenames. Use exclusive staging-file creation and no-follow protection where supported.

36. **P1 — Binary inputs can cause excessive allocation/decompression in main.**  
    **Location:** `src/main/providers/epic/manifest.ts:79`, `src/main/providers/epic/manifest.ts:103`, `src/main/providers/epic/manifest.ts:126`, `src/main/providers/epic/manifest.ts:306`.

    **Problem/cost:** Counts, string lengths, block offsets, chunk sizes, and decompressed output are insufficiently bounded. `bytes()` silently returns short slices; arbitrary counts allocate arrays; `inflateSync` has no output cap. Corrupt manifests/chunks can exhaust memory or stall main before producing an ordinary download error. JSON preceded by whitespace/BOM is also misclassified as binary.

    **Exact fix:** Add checked reader bounds and block-local limits. Bound counts by remaining input and supported maximums; validate safe integers and chunk-part ranges. Bound downloaded bodies and decompression output against validated expected sizes. Verify chunk identity/integrity before caching. Strip BOM/leading whitespace when recognizing JSON. Parse hostile inputs outside main.

37. **P2 — Requested Properties tabs immediately reset to General.**  
    **Location:** `src/renderer/src/components/PropertiesDialog.tsx:68`, `src/renderer/src/components/PropertiesDialog.tsx:137`.

    **Problem/cost:** The effect selects `wanted`, clears it in Zustand, then reruns because `wanted` changed and selects General. “Installed Files,” DLC, and customization shortcuts therefore fail. Switching game keys while General stays mounted also retains the previous game’s launch-argument state.

    **Exact fix:** Consume a tab request once: when `wanted` is null, do not reset the selected tab unless the game key changed. Prefer a keyed dialog-body component initialized with `{gameKey, requestedTab}`. Key General by `game.key` so arguments and pending save timers belong to exactly one game.

38. **P2 — Bootstrap can overwrite events received while snapshots are loading.**  
    **Location:** `src/renderer/src/store.ts:425`, `src/renderer/src/store.ts:434`, `src/renderer/src/store.ts:443`.

    **Problem/cost:** Subscriptions start first, then snapshots are applied after all requests settle. A newer library/account/download event can arrive while another request is delayed and subsequently be overwritten by an older snapshot. Failure fallbacks also use the state captured before those events.

    **Exact fix:** Add per-domain revisions to snapshots and events; apply only a revision at least as new as the current domain. Alternatively buffer events during initialization and replay them after snapshots. Read current state for failure fallbacks. Do not let one slow domain delay application of independent successful snapshots.

39. **P2 — Local shortcut discovery loses arguments and fails duplicate recognition.**  
    **Location:** `src/main/providers/local/index.ts:104`, `src/main/providers/local/index.ts:141`, `src/main/providers/local/index.ts:189`, `src/renderer/src/components/library/AddGameDialog.tsx:50`.

    **Problem/cost:** Discovery returns the shortcut target, discarding its arguments; deduplication occurs before `.lnk` resolution. Renderer duplicate detection compares executable paths to installation directories. Both argument parsers mishandle forms such as `-option="value with spaces"`. `shell.openPath()` failures are also ignored.

    **Exact fix:** Preserve shortcut path, target, arguments, and working directory in the discovery contract. Resolve before deduplicating using canonical executable identity plus arguments. Compare renderer program entries to full executable identities. Use platform-correct argument parsing and reject nonempty `shell.openPath()` error results.

40. **P2 — Storage information is wrong for macOS external volumes and stale after DLC/default-drive changes.**  
    **Location:** `src/main/core/extras.ts:68`, `src/renderer/src/views/shell/StorageManager.tsx:20`, `src/renderer/src/views/shell/StorageManager.tsx:44`.

    **Problem/cost:** Every macOS path is assigned to `/`, so games on external volumes use the system volume’s capacity/free-space figures. The refresh signature excludes DLC installation sizes and the default install directory. Overlapping storage requests can also commit out of order.

    **Exact fix:** Resolve actual volume/mount identity and call `statfs` on a path belonging to that volume. Include default directory and base/DLC installation revisions in refresh dependencies. Apply storage responses only if their request generation is current.

41. **P2 — Collection changes can lose concurrent edits and scale poorly.**  
    **Location:** `src/renderer/src/lib/gameActions.ts:384`, `src/renderer/src/lib/gameActions.ts:413`, `src/main/core/library.ts:258`.

    **Problem/cost:** Operations read renderer snapshots and replace entire collections arrays through sequential IPC calls. Two edits before the coalesced library event arrives can overwrite one another. Bulk rename/delete incurs one IPC/mutation per game; follow-up UI state changes continue even when `act()` swallowed an error.

    **Exact fix:** Add main-process collection operations accepting `{operation, gameKeys, name, replacement}`. Apply additions/removals against current main state in one transaction, then persist/emit once. Return explicit success or propagate errors before changing empty-collection state or navigation.

42. **P2 — Prerequisite installation can hold the entire queue indefinitely.**  
    **Location:** `src/main/providers/epic/installer.ts:258`, `src/main/providers/epic/installer.ts:539`.

    **Problem/cost:** PowerShell waits indefinitely for an elevated installer, without cancellation or timeout. One hung prerequisite blocks every subsequent download. Import/repair does not run missing prerequisites, and prerequisite failure still returns an apparently ready installation.

    **Exact fix:** Model prerequisites as a separate tracked phase with cancellation/timeout handling and an explicit result. Keep the downloaded installation committed, but expose “prerequisites required/failed” with retry. Support prerequisite installation after import/repair without redownloading content.

**Prioritized top 10 performance wins**

Estimates below are engineering estimates, except the stated bundle measurements and sorting benchmark; they are not measured end-to-end startup or RSS results.

| Priority | Win | Estimated impact |
|---|---|---|
| 1 | Enforce a 64–128 MiB chunk-memory budget and drain cancelled workers | Roughly **640–704 MiB less buffer capacity** than the current nominal limit; prevents larger unbounded retention. |
| 2 | Virtualize grid rows and horizontal shelves | For 1,000 games, approximately **90–97% fewer mounted tiles/subscriptions**, depending on viewport and overscan. |
| 3 | Cache library composition/order and stop unchanged tray rebuilds | Synthetic title sorting improved **46.15 → 1.71 ms**, about **27×**; cached unchanged menus eliminate that recurring work altogether. |
| 4 | Destroy idle Store guests promptly on background/game transitions | Likely **tens to hundreds of MiB** reclaimed per retained guest, plus its network/audio/timer activity. |
| 5 | Move inflate/manifest planning/image decoding outside main | Removes synchronous work from latency-sensitive IPC; greatest benefit during fast downloads and large-manifest processing. |
| 6 | Separate telemetry from durable queue state; send deltas | Target **70–95% less progress serialization/IPC volume** with queue history, and much fewer disk checkpoints. |
| 7 | Normalize renderer entities and share derived indexes | Changes repeated per-row scans from effectively **O(rows × games)** to keyed lookups; eliminates duplicate sorts and unrelated tile updates. |
| 8 | Gate glow images by visibility and store artwork as files | Avoids shelf-wide background fetches; removes base64 artwork from repeated library payloads and reduces duplicate decoding. |
| 9 | Lazy-load GamePage/collections and extract route CSS | Estimated additional **20–50 kB JS** and **30–60 kB CSS** deferred from startup; verify with the resulting bundle graph. |
| 10 | Use asynchronous store hydration and bounded, cached program discovery | Reduces pre-window blocking and icon-request bursts; potentially hundreds of milliseconds on large profiles or slow storage. |