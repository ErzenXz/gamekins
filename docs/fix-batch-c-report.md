Implemented batch C, including sender and argument validation for `games:details`. The metadata feature remains wired through the existing API.

| Finding | Changes |
|---|---|
| #8 | Shared synchronous installation-group locks cover launches, maintenance, queue resumes and automatic updates. Running games block writes to their group. |
| #9 | Moves reject overlapping destinations and local games; cross-drive copies use unique staging, durable records before source deletion, and relocation recovery. |
| #10 | Process tracking uses spawned identities, descendants and appropriate executable boundaries; local games exclude neighboring programs. |
| #11 | Stop verifies termination and reports survivors or unverifiable identities while retaining running protection. |
| #12 | Process scans share one promise; polling schedules after completion and revalidates executable/creation identities. |
| #13 | Running sessions checkpoint playtime every minute and on flush; persisted identities reserve groups during startup reconciliation. |
| #14 | Single-instance locking precedes migration/store loading. Migration preserves newer files and marks partially failed copies considered. |
| #15 | Account generations guard login, refresh and library commits; logout clears Epic storage. Session writes are atomic. |
| #16 | OAuth grants receive exactly one attempt. |
| #17 | Stores validate shapes, retain valid default-compatible fields, quarantine corrupt files and retry failed writes safely. |
| #18 | Failed catalog lookups retain cached owned-game metadata or placeholders and report partial-refresh errors. |
| #19 | Destructive manifest lookup requires exact identity; shared files remain protected. |
| #20 | Disconnected installations remain recorded, show “Drive not connected,” and block queue writes. Negative adoption entries expire after 24 hours; executables are rechecked. |
| #24 | Chunk inflation is asynchronous and retains existing bounds/integrity checks. |
| #25 | Library composition uses revision caching and a shared collator; unchanged tray menus are reused. |
| #32 | Every IPC channel validates the main-window sender, frame, trusted URL and runtime arguments, including settings bounds and `games:details`. |
| #33 | Remote external links use the HTTP/HTTPS-only helper. |
| #34 | Webviews force the Epic partition and web security; navigation/redirect guards and permission denial are enforced. |
| #35 | Manifest/OVT filenames are hashed, legacy manifests migrate safely, and destructive paths use canonical boundary checks. |
| #39 | Shortcut discovery/addition preserves arguments and working directories, deduplicates resolved targets, and propagates `openPath` failures. |
| #40 | macOS storage resolves actual volume boundaries and handles disconnected external volumes. |
| #42 | Prerequisites have a ten-minute timeout and cancellation handling; failures remain visible, with committed content preserved and repair-based retry. |
| D follow-ups #31/#41 | Added bounded file-backed artwork through a restricted protocol and atomic main-owned collection operations; updated preload, renderer consumers and mock API. |

Deferred: optional worker-based manifest parsing (#24), and batch A’s previously excluded full installer promotion/rollback journal. Relocation recovery deliberately preserves surviving source copies to avoid uncertain deletion.

Verification:

- `npm run typecheck`: passed.
- `npm test`: **45 passed**.
- Renderer regressions: **9 passed**.
- `npx electron-vite build`: sandbox blocked config loading with an ancestor-directory access denial. The complete production build passed using a temporary **in-memory config-loader adapter**, with no configuration or tool files changed.
- `git diff --check`: passed.

No network downloads, live Epic API calls, integration harness, Electron launch or git commits were performed.