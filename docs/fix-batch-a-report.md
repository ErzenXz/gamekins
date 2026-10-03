Implemented batch A within the allowed files. I did not edit `src/renderer`, launch Electron, download game data, or run any Git command that changes state.

| Finding | File and function | Change |
|---|---|---|
| #1 | `downloads.ts`: `enqueue`, `claimFolder`, `cancel` | Persisted job identity and folder ownership; require a matching owner marker before recursive deletion. DLC and missing-metadata jobs preserve the folder. |
| #2 | `downloads.ts`: `pause`, `cancel`; `installer.ts`: `run`, `writeFiles` | Await active runs, abort and drain chunk workers, close handles, and use job-specific staging inventories for cleanup. |
| #3 | `downloads.ts`: `run`, `preempt` | Added generations and stop reasons; ignore late progress and explicitly restore the requested state. |
| #4 | `installer.ts`: `prepare`, `writeFiles`, `execute` | Stage every existing-file replacement with `.lodestar-tmp`; include staging space in disk estimates. |
| #5 | `installer.ts`: `prepare`, `completeFileExists`, `execute` | Bind resume records to manifest SHA-1 and job identity, validate file sizes, and rebuild missing staging files. |
| #6 partial | `installer.ts`: `writeAtomic`, `execute` | Save manifests through a flushed temporary file and rename. |
| #7 | `installer.ts`: `writeAll`, `writeFiles` | Retry short writes, reject zero progress, and check final size before recording completion. |
| #21 | `downloads.ts`: `queueUpdates` | Skip `thirdPartyManagedApp` games. |
| #22 | `downloads.ts`: `Throttle.take`; `installer.ts`: `fetchChunk` | Removed the oversized-transfer bypass; throttle streamed body slices with abortable waits. |
| #23 | `installer.ts`: `writeFiles` | Reserve memory before every fetch, charge completed buffers before pumping, and evict/re-download chunks under a 128 MiB budget. |
| #26 | `downloads.ts`: `emitNow`, `emitSoon`, `run` | Checkpoint transitions immediately and progress every five seconds; cap/prune histories while preserving the IPC array payload. |
| #35 | `fsBoundary.ts`; `installer.ts`: `validatePaths` | Check canonical roots and existing ancestors; reject unsafe/duplicate paths, junctions, and escaping symlink targets. |
| #36 | `manifest.ts`: `Reader`, parsers, `decodeChunk` | Bound reads/counts/decompression, validate sizes and chunk identity, and recognize BOM/whitespace-prefixed JSON. |

`providers/types.ts` contains additive changes only.

Verification passed:

- `npx.cmd tsc --noEmit -p tsconfig.node.json`
- `npx.cmd electron-vite build`
- All **19 offline regression checks** in `src/main/providers/epic/integrity.test.cjs`
- Whitespace diff check

The build required a temporary config-loading adapter because the sandbox denied esbuild’s ancestor-directory scan. The unchanged configuration built successfully; the adapter was removed.

Deferred as specified: full commit journaling/rollback remains outside scope, so promotions are not crash-transactional. Broader capability enforcement, IPC telemetry changes, provider metadata-path protection, and manifest parsing outside main require follow-up beyond batch A. No changes outside the allowed files were needed for this batch.