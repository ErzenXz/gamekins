# Fix batch D — renderer performance & bugs

Implement fixes for these findings from `docs/codex-review.md`: **#27, #28, #29, #30, #31 (renderer part), #37, #38, #41 (renderer part), and #40 (renderer part)**.

## Files you may edit
- Anything under `src/renderer/**`
- `electron.vite.config.ts`, if needed for chunking

Do NOT edit `src/main/**`, `src/preload/**` or `src/shared/**`. Another engineer is editing the main process right now. If a fix needs main-process or API changes (for example the main-process collection operations in #41, or file-based artwork in #31), do the renderer-side part only and describe the needed API in your final report.

## Guidance
- **#27 (most important):** Virtualize the library grid by rows.
  - Measure columns from the container width and `--cap-w`, then render only the visible rows plus a small overscan, keeping group headings and keyboard navigation working.
  - Virtualize horizontal shelves so only visible items mount.
  - Remove the progressive "mount everything eventually" strategy.
  - Keep the existing look exactly the same: Steam capsule hover tilt, glow and shine, badges, the grid size control, and sort groups.
  - The `.game-grid > .cap-wrap` `content-visibility` CSS rule in `styles/library.css` can stay or go, as long as the hover glow is not clipped.
  - No new npm dependencies: write a small virtualizer yourself.
- **#28:** Build shared derived indexes once per store update (`gamesByKey`, `jobsByKey`, sorted keys, collection membership) and have tiles and rows subscribe by key, so a download tick for one game doesn't re-render every tile.
- **#29:**
  - Start the store's idle-unload timer only on the transition away from the Store tab, using a "last used" timestamp, so other navigation doesn't keep resetting it.
  - Also unload the store when a game starts running, and when the window is hidden for more than about 2 minutes (`document.visibilityState`).
  - Remember the last store URL so it reopens where the user left off.
  - Handle the webview's `render-process-gone` event by offering a reload.
- **#30:**
  - Lazy-load `GamePage` and the collection views with local `Suspense` boundaries.
  - Move `LodestarMark` out of `TitleBar` into its own small module and update the imports.
  - Split route-specific CSS where it is cleanly separable. Keep tokens, the shell and shared components loading eagerly.
- **#31 (renderer):** Don't load the capsule glow background image until the tile is hovered or visible.
- **#37:** Fix the Properties dialog's requested-tab reset bug, and key per-game state by `game.key`.
- **#38:** Bootstrap must not overwrite newer event data. Buffer events received during initialization and apply them after the snapshots, or apply each snapshot only if no newer event for that domain has arrived.
- **#40 (renderer):** The storage manager's refresh dependencies must include DLC sizes and the default install directory, and stale responses must be ignored by request generation.
- **#41 (renderer):** Apply collection edits against the latest store state, serialize them, and don't continue to the follow-up state changes after a failed call.

## Hard rules
- Keep the UI looking and behaving exactly as it does now; this is a performance and bug pass, not a redesign.
- Test in the browser mock: `npm run dev:web` serves http://localhost:5174, which may already be running. Use `?mock=many` (600 games) to confirm scrolling, typing and download ticks stay smooth, that the grid looks identical, and that the hover effects work.
- Do not launch the Electron app, and do not make network requests beyond the local mock.
- `npx tsc --noEmit -p tsconfig.web.json` must pass, and `npx electron-vite build` must succeed.
- Do not commit or run any git command that changes state.

Final report: per finding, what you changed, before/after measurements you took (mounted tiles, render times), anything deferred, and the API changes needed in main.
