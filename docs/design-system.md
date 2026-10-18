# Gamekins design system

Steam's layout and density with a modern finish. Keep what makes it feel like Steam (left game list, big uppercase nav, hero game pages, green Play, shelves, information density) and modernize the surface: layered cool darks, hairline borders instead of bevels, rounded shapes, quick motion.

All tokens live in `src/renderer/src/styles/base.css` (`:root`). Never hardcode a color that has a token.

## Surfaces (darkest to lightest)

| Token | Use |
|---|---|
| `--bg-app` `#0a0d12` | Window chrome: top bar, footer |
| `--bg-sunken` `#07090d` | Text fields, wells, progress tracks |
| `--bg-side` `#0d1117` | Left game list |
| `--bg-main` `#11151c` | Main content background |
| `--surface-1` `#151a22` | Cards, panels, dialogs |
| `--surface-2` `#1a2029` | Menus, hovered rows/cards |
| `--surface-3` `#222936` | Controls (buttons), hovered controls |
| `--surface-4` `#2b3443` | Selected / pressed |
| `--border` | Hairline (6% white) on cards and panels |
| `--border-strong` | Inputs, popovers, emphasis (10% white) |

Cards use `background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--border); border-radius: var(--r-lg);`. Use inset box-shadow rings instead of `border` so sizes don't change.

## Text

`--text` (primary), `--text-2` (secondary), `--text-3` (labels, hints), `--text-4` (disabled, faint). `#fff` for titles and hovered text.

## Typography

One type system for every page. All sizes, weights, tracking and line heights are tokens in `base.css`; never write a raw `px` font size, a raw weight or a raw `em` letter-spacing. Pick the **role** first, then copy its recipe, so the same role looks identical on every page.

### Scale

| Token | Size | | Token | Value |
|---|---|---|---|---|
| `--fs-2xs` | 10.5px | | `--fw-regular` | 400 |
| `--fs-xs` | 11.5px | | `--fw-medium` | 550 |
| `--fs-sm` | 12.5px | | `--fw-semibold` | 650 |
| `--fs-base` | 13.5px (body default) | | `--fw-bold` | 750 |
| `--fs-md` | 15px | | `--fw-heavy` | 800 (display only) |
| `--fs-lg` | 18px | | | |
| `--fs-xl` | 22px | | `--tracking-label` | 0.08em (all small caps) |
| `--fs-2xl` | 28px | | `--tracking-caps` | 0.06em (big caps: nav, Play) |
| `--fs-hero` | clamp(28px, 3.4cqi, 48px) | | `--tracking-snug` / `-tight` / `-tighter` | -0.01 / -0.015 / -0.02em |

Line heights: `--lh-tight` 1.1 (display/page titles), `--lh-snug` 1.3 (card titles, wrapped labels), `--lh-body` 1.5 (body default, paragraphs, hints), `--lh-relaxed` 1.65 (long descriptions, legal). Fixed `px` line heights are fine where they size a box (pills, rows, 20px section labels).

`b`/`strong` default to `--fw-semibold` (base.css), not the browser's 700.

### Roles

| Role | Recipe | Used by |
|---|---|---|
| Display | `--fs-hero`, heavy, `--tracking-tighter`, `--lh-tight` | Game page title (welcome headline uses its own clamp from `--fs-xl`) |
| Page title | `--fs-2xl`, bold, `--tracking-tighter`, 34px line | Settings `.st-title`, Collections header, Downloads hero name |
| Headline | `--fs-xl`, bold, `--tracking-tight` | Active download title, empty library, store overlay, crash/about |
| Panel / dialog title | `--fs-lg`, semibold, `--tracking-snug` | `.modal-title`, `.props-h`, info panel, empty/loading titles, account name |
| Card title | `--fs-md`, semibold, `--tracking-snug` | Free-game cards, queue rows, highlights, collection tiles, drive cards, install header |
| Stat value | `--fs-md`, semibold, tabular-nums | Game page stats, download meters, HLTB hours, install sizes, versions |
| Row title | `--fs-base`, medium | Settings/option rows (`.st-label`, `.opt-title`), DLC, storage game names |
| Body | `--fs-base`, regular | Menus, lists, inputs, notices, dialog copy (`--lh-body`), descriptions (`--lh-relaxed`) |
| Secondary | `--fs-sm`, regular, `--text-3` | Hints, meta lines, captions over cards ("Today", "Free until…") use medium |
| Caption | `--fs-xs`, `--text-4` | File paths, legal, fine print |
| **Section label** | `--fs-sm`, semibold, uppercase, `--tracking-label`, `--text-2`, 20px line (shelves 24px), 2px inset, **10px to content** | Shelf titles, game page `.gp-sec-title`, downloads `.dls-section-title`, settings `.st-sub` |
| Label | `--fs-xs`, semibold, uppercase, `--tracking-label`, `--text-3` | Sidebar group names, settings nav title, field labels, menu headings, table headers, toast titles, "Sort by" |
| Micro label | `--fs-2xs`, semibold, uppercase, `--tracking-label`, `--text-3` | Labels stacked over a stat value (game page stats, download meters, HLTB, install/props cells) |
| Badge | `--fs-2xs`, bold, uppercase, `--tracking-label`, pill | `FREE NOW`, `PAUSED`, `GAME CONTENT`, `COMING SOON`, `RUNNING`, `ADDED` |
| Status word | `--fs-xs`, semibold, uppercase, `--tracking-label`, tinted | `DOWNLOADING`, `QUEUED`, `ERROR`, game page download label |
| Counter | `--fs-2xs`, semibold, tabular-nums, pill | Counts next to labels (sidebar groups, shelves, props tabs, collections), nav badge (bold) |
| Nav | `--fs-base`, semibold, uppercase, `--tracking-caps` | Top tabs |
| Buttons | `--fs-base` medium; `.small` `--fs-sm`; `.btn-lg` `--fs-md`; caps actions bold with `--tracking-caps` (Play/Pause) | |

Any number that changes while you look at it (speeds, sizes, percentages, ETAs, counts) gets `font-variant-numeric: tabular-nums` (or `.tabular`).

### Spacing that goes with type

- Page gutters: 18px inside the main pane (library home, game page, downloads); shelves add a 4px inset for hover room. Settings is a two-pane page: 20px top, 32px sides, page title centred on the same line as the Collections title.
- Section label to its content: 10px. Between sections: 26px.
- Card padding steps: 12 / 14 / 16 / 18 / 24px. Compact tiles 12px, rows 12–14px, panels 16–18px, hero cards 24px.

## Accent and status

`--accent` (blue), `--accent-hover`, `--accent-press`, `--accent-text` (blue for text on dark), `--accent-soft` (14% tint background), `--accent-line` (focus/ctx outline). Status: `--ok`, `--warn`, `--danger`, each with a `*-soft` tint. Big actions: `--play` (green gradient), `--install` (blue gradient), with `-hover` variants. Brand gradient: `--brand` (avatar, rare brand moments).

Tinted notices: `background: var(--danger-soft); box-shadow: inset 0 0 0 1px rgba(255, 93, 82, 0.28);` (same pattern for warn/accent/ok).

## Shape

`--r-xs` 4, `--r-sm` 6 (small chips, rows), `--r-md` 8 (buttons, inputs), `--r-lg` 12 (cards, menus), `--r-xl` 16 (dialogs, big panels), `--r-pill`.

## Depth

Flat things use borders, not shadows. Only floating things (menus, dialogs, toasts, popovers) use `--shadow-pop`.

## Motion

`--t-fast` 0.12s for hover color changes, `--t-med` 0.18s for movement, easing `--ease-out`. Menus use the `dd-in` keyframes (scale 0.97 + fade).

## Controls (shared classes in base.css)

`.btn` (default), `.btn-blue` (primary), `.btn-play`, `.btn-ghost` (outline), `.btn-danger`, `.btn.small`, `.btn-lg`, `.icon-btn`, `.chip`, `.input`, `select`, `.switch`, `.progress`, `.modal*`. Library-specific controls (`.lbtn`, etc.) should match these.

Menus: panel `--surface-2`, radius `--r-lg`, padding 6px, items radius `--r-sm`, hover `--surface-4` with white text (no inverted white rows).

## Performance rules (mandatory)

The app must stay fast and light. In every stylesheet:

1. Animate only `transform` and `opacity`. Never transition `filter`, `box-shadow`, `width/height`, `background-position` or layout on anything that repeats (tiles, rows, list items). Color/background-color transitions on hover are fine.
2. No `backdrop-filter`. Use a semi-opaque solid color instead.
3. No `filter: blur()` on large areas or list items. For ambient art, upscale a tiny image instead.
4. No 3D (`perspective`, `preserve-3d`, `rotateX`), no `will-change` on list items.
5. For hover rings or shadows on tiles, pre-paint them on a pseudo-element and fade its `opacity`.
6. Avoid infinite animations except spinners and active progress; never on idle screens.
7. Scroll handlers must not read layout; prefer IntersectionObserver or CSS scroll timelines.

## Reference implementations

- Window chrome and menus: `styles/shell.css` (top of the window chrome section).
- Sidebar, home shelves, tiles: `styles/library.css` (Layout, Left panel, Library Home, Capsule sections).
- Game page: `styles/game-page.css`.
