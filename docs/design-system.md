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

Section labels (Steam's uppercase vibe): `font-size: 11–12.5px; font-weight: 650; letter-spacing: 0.08–0.09em; text-transform: uppercase; color: var(--text-2 or --text-3)`. Body text 13–14px. Titles 600–800 weight with `letter-spacing: -0.01em` to `-0.02em`.

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
