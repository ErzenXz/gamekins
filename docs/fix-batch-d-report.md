Batch D’s renderer changes are implemented, but required verification remains blocked. I edited only `src/renderer/**`; I did not touch main/preload/shared source, launch Electron, or commit.

| Finding | Changes |
|---|---|
| #27 | Replaced progressive mounting with row virtualization and horizontal shelf windows; retained headings, keyboard navigation, sizing, and hover styling. |
| #28 | Added shared entity/job indexes, cached derived lists, structural sharing, and keyed tile/row subscriptions. |
| #29 | Fixed Store idle deadlines; added running-game/background unloading, URL restoration, muting, and crash reload. |
| #30 | Lazy-loaded GamePage and collections, extracted `LodestarMark`, and split route CSS. |
| #31 | Deferred capsule glow backgrounds until visibility or hover/focus. |
| #37 | Consumed requested Properties tabs once and keyed per-game state. |
| #38 | Applied snapshots independently and prevented stale snapshots from overwriting newer events. |
| #40 | Included DLC sizes/default directory in storage refresh dependencies and ignored stale responses. |
| #41 | Serialized collection edits against current state; preserved successful edits awaiting events and stopped follow-ups after failures. |

Measurements taken:

| Measurement | Before → After |
|---|---|
| React server-rendered capsules, supplied 900×700 viewport | 600 → 30 |
| Median server-render CPU time, 25 runs | 7.553 → 0.527 ms |
| Production entry JS | 344,061 → 325,201 bytes |
| Startup CSS | 111,730 → 73,757 bytes |

These are **DOM-free render measurements**, not browser mounted-tile or frame-time measurements. Existing CSS declarations were preserved except the virtualization wrapper rules.

Verification:

- Typecheck passed.
- [Nine regression checks](/C:/Users/W11/Desktop/Projects/vapor/src/renderer/tests/batch-d.test.cjs) passed.
- In-memory production renderer build passed.
- `npx electron-vite build` failed before application compilation: esbuild could not resolve the config because directory access was denied.

Deferred main work/API needs: file-backed artwork identifiers with restricted asset URLs (#31); accurate volume identity/capacity in storage responses (#40); transactional collection operations accepting `{operation, gameKeys, name, replacement}` and returning explicit success (#41). Bulk collection edits can still partially succeed until that transaction API exists.

Automatic browser approval review rejected `http://localhost:5174` because permission was declined. Required mock scrolling, typing, download-tick, hover, visual-identity, and mounted-tile checks remain unverified.