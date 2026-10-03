# Steam Desktop Client (2023+ "new client") — UI Implementation Reference

Target: pixel-faithful React clone of the current Steam desktop client (library, game page, downloads, chrome, dialogs).

**How this was built.** Most values below come straight from Valve's shipped client stylesheets. These are the CSS-module files `steamui/css/sp.css` and `library.css`, mirrored by SteamDatabase/SteamTracking. Their hashed class names were mapped back to readable module keys through the webpack exports in `sp.js`, so names like `.PlayBar` or `.GameListEntry` below are the real source names. The rest comes from the shared web tokens (`shared_global.css`), the store CSS, the client string tables (`steamui_english.json`) and screenshots of the 2023+ client.

Confidence tags:
- **[CSS]**: copied from the client's shipped CSS. Treat as exact.
- **[SS]**: measured or observed from screenshots of the current client.
- **[EST]**: best estimate. Verify against a real client if it matters.

Window size used for the spec: 1280×800 or larger, Windows, 100% DPI. All px values are CSS px.

---

## 0. Quick reference (most-used values)

| Token | Value | Use |
|---|---|---|
| `--bg-chrome` | `#171d25` | Top bar, URL strip, left-panel header strip, footer [CSS] |
| `--bg-darkest` | `#0e141b` | Darkest grey: download active-item bg, `InitContainer` [CSS] |
| `--bg-darker` | `#23262e` | Dialog base, panels [CSS] |
| `--bg-dark` | `#3d4450` | Buttons, menus, hover rows [CSS] |
| `--bg-library` | `#24282f` | Library and game-page main surface [CSS] |
| `--text-lightest` | `#dcdedf` | Primary UI text [CSS] |
| `--text-lighter` | `#b8bcbf` | Secondary text [CSS] |
| `--text-light` | `#8b929a` | Labels, menu-row text [CSS] |
| `--text-grey` | `#67707b` | Disabled text, icons at rest [CSS] |
| `--accent-blue` | `#1a9fff` | Selected nav, progress, toggles [CSS] |
| `--accent-blue-hi` | `#00bbff` | Hover gradient end [CSS] |
| `--play-green` | `#70d61d → #01a75b` | PLAY button gradient [CSS] |
| Font | `"Motiva Sans", "Twemoji", "Noto Sans", Helvetica, sans-serif` | Everything [CSS] |
| Radius | 2px on buttons, 3–4px on inputs and menus, 9001px on pills | [CSS] |
| Standard transition | `0.15s ease-out` (chrome), `0.2s ease-out` (buttons), `0.21s ease-in-out` (library) | [CSS] |

---

## 1. Window chrome

### 1.1 Structure (top → bottom)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ TitleBar 32px: [Steam ▾][View][Friends][Games][Help]  ...drag...  [📢][🔔][avatar name ▾ $x.xx][⌂BPM][—][▢][✕] │
│ SuperNavBar 32px: [←][→]  STORE  LIBRARY  COMMUNITY  USERNAME                    │
│ URLBarReplacement 12px (library)  -or-  URL bar ~22px (store/community web pages)│
├───────────────────────────────────────────────────────────────────────────────┤
│ content (library / browser)                                                    │
├───────────────────────────────────────────────────────────────────────────────┤
│ BottomBar 50px (library only): [+ Add a Game]   [download status]   [Friends & Chat 👥] │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Frame [CSS]:**
- The outer `Wrapper` has `border: 0.5px solid #000; border-top: none`. Remove the border when maximized.
- Frameless window; draggable regions use `-webkit-app-region: drag`. In Electron, put `drag` on the DragArea and `no-drag` on every control.
- `FocusBar`: a 1px line at the very top. It appears only while the window is focused, with `background: linear-gradient(to right, transparent 10%, rgba(26,160,255,.33) 50%, transparent 90%)`.

**TopBar container [CSS]:**
- `background: #171d25`
- `box-shadow: inset rgba(61,68,80,.75) 1px 1px 1px 0, inset rgba(61,68,80,.25) -1px 0 1px 0`. This gives a subtle light bevel on the top and left edges.
- When maximized, the shadow becomes `inset rgba(61,68,80,.25) 0 0 1px 0`.

### 1.2 Menu row (`TitleBar`, height 32px) [CSS]

- **Layout:** `display:flex`.
  - `RootMenuBar`: `flex 0 0 auto`, `margin-top 2px`, `padding-left 9px`, `gap 6px`, `max-width calc(100% - 99px)`.
  - `DragArea`: `flex 1`.
  - `TitleBarControls`: `margin-top 5px; margin-right 4px`.
  - `WindowControls`: `flex: 0 0 99px`.
- **Menu buttons** (`RootMenuButton`):
  - Font 12px, colour `#8b929a`, `padding: 6px 4px`, full height.
  - Hover: `#fff`, `transition: color .15s ease-out`.
  - Disabled: `rgba(169,169,169,.5)`.
- **"Steam" menu:** an 18×18 Steam logo (margin-top 1px) with a 4px gap, then the text "Steam".
- **Items:** Steam · View · Friends · Games · Help. No uppercase; regular weight.
- **Menus open on click** and use the desktop context-menu style (§5.1). Contents, from the string tables:
  - **Steam:** Change Account… · Sign Out… · Go Offline… · Check for Steam Client Updates… · Restore Game Backup… · Settings · Exit
  - **View:** Small Mode / Large Mode · Big Picture Mode · Hidden Games · Soundtracks · Recordings & Screenshots · Players · Game Servers · Music Player · Update News. The order is [EST].
  - **Friends:** View Friends List (N Online) · Add a Friend… · Edit Profile Name/Avatar… · then status radio items Online / Away / Invisible / Offline
  - **Games:** View Games Library · Activate a Product on Steam… · Redeem a Steam Wallet Code… · Manage Gifts and Guest Passes… · Add a Non-Steam Game to My Library…
  - **Help:** Steam Support · Privacy Policy · Legal Information · Steam Subscriber Agreement · System Information · About Steam

### 1.3 Top-right controls (`TitleBarControls`) [CSS + SS]

From left to right, each separated by `margin-right: 8px`. Every pill is 24px tall with `border-radius: 2px`.

| Control | Rest | Hover | Active/special |
|---|---|---|---|
| **Announcements** (megaphone, icon 16×16) | bg `rgba(103,112,123,.2)`, icon `#8b929a`, `padding 0 12px` | bg `#3d4450`, icon `#fff` | Has unread: bg `#1999ff`, icon `#fff`; hover `rgb(76,176,255)`; animated "sound waves" SVG |
| **Notifications bell** (icon 14×14) | `NoNew`: bg `rgba(103,112,123,.2)`, icon `#8b929a` | bg `#3d4450`, icon `#b8bcbf` | `HasNew`: bg `#5c7e10` (green), icon white, hover `#7ea64b`. The bell swings (5s, ×12) |
| **Account menu** | bg `rgba(103,112,123,.2)`, 12px text, `padding-right 8px`, gap 4px, max-height 24px | bg `rgba(76,180,255,.2)` | Name colour follows presence: online `#4cb4ff`; in-game `#c2ffb3` on bg `rgba(92,126,16,.5)` |
| Wallet balance (inside account pill) | `#788a92`, 12px, e.g. "$4.40" | | |
| Chevron (inside account pill) | width 10px, `padding-top 2px` | | |
| VR toggle / **Big Picture toggle** | 32×24, icon `#67707b` 16–18px | bg `#3d4450` | VR running: bg `#5c7e10` |
| Low-disk / transport-error alerts | bg `#de3618` / `#c91613`, white icon | | |

- **Account pill content [SS]:** a 24×24 avatar (square, flush left, no radius), then the persona name, chevron and wallet balance.
- **Account dropdown:** context-menu style (§5.1). Name and wallet are coloured `#4cb4ff`. Items: View My Profile · Account Details: *name* · Store Preferences · View My Wallet (*$x.xx*) · Change Account… · Sign Out of Account…

### 1.4 Notifications flyout [CSS + SS]

- **Container:**
  - `width 300px; padding 2px; border 1px solid #000`
  - `background: radial-gradient(circle at top left, rgba(74,81,92,.4) 0%, rgba(75,81,92,0) 60%), #25282e`
  - `box-shadow: inset rgba(61,68,80,.75) 1px 1px 1px 0, inset rgba(61,68,80,.25) -1px -1px 1px 0`
- **Header:**
  - `padding 10px 4px 10px 15px`. Title "Notifications" is 16px bold.
  - "View All" button: bg `#3d4450`, white, `padding 5px 10px`, radius 2. Hover bg `#67707b` (250ms).
- **Summary rows** first, e.g. "9 New Friend Requests" or "3 New Comments". Each is a full-width row with a 13px icon, 13px text and a slightly lighter bg [SS].
- **Notification items:**
  - `min-height 50px; padding 10px; height 50px` with a 44×44 icon on the left. Hover bg `#3d4450`.
  - Header line, 11px weight 500: type icon (13×13) + type text + timestamp.
  - Title: 11–13px white, weight 500.
  - Description: `#b8bcbf`. Sub-text: `#67707b`.
  - Unread indicator: a green dot at the right edge [SS].
- **Scrolling:** the scroll area is `max-height 400px`.
- **Empty state:** centred 12px text; body colour `#b8bcbf`.

### 1.5 Big nav (`SuperNavBar`, height 32px) [CSS]

- **Container:** `padding: 2px 0 0 11px; display:flex; align-items:center`.
- **Back / forward arrows:**
  - SVG 16×16, `padding: 0 4px 6px`; the first arrow has `padding-left: 12px`.
  - Enabled: `#67707b`, hover `#dcdedf`. Disabled: `#3d4450`. Transition `color .15s ease-out`.
- **Tabs** (`SuperNavMenu`):
  - 18px, **weight 500, UPPERCASE**, `padding: 0 10px` (first `padding-left 4px`).
  - Text `#dcdedf`; hover `#fff` with `transition color .15s, text-shadow .15s`.
  - **Selected:** text `#1a9fff`, `text-shadow: 0 0 1px #1a9fff`, plus a 3px underline: `::after{display:block;width:100%;height:3px;background:#1a9fff;border-radius:3px}`. The underline animates in over 0.1s.
  - Disabled: `#3d4450`.
- **Tab order:** STORE · LIBRARY · COMMUNITY · *USERNAME* (the persona name, uppercased).
- **Tab hover menus:** hovering a tab drops a submenu with bg `#3d4450`, 13–14px, no uppercase, line-height 17px.
  - STORE → Featured, Discovery Queue, Wishlist, Points Shop, News, Charts
  - LIBRARY → Home, Collections, Downloads
  - COMMUNITY → Home, Discussions, Workshop, Market, Broadcasts
  - USERNAME → Activity, Profile, Friends, Groups, Content, Badges, Inventory, Steam Replay

### 1.6 URL strip [CSS]

- **Library view:** `URLBarReplacement` is an empty 12px strip, bg `#171d25`, with left and right inset bevel shadows.
- **Web views (Store, Community, profile):** a URL bar, bg `#171d25`, `padding 0 4px 4px 9px`.
  - Reload button: 16–18px icon `#67707b`. Hover bg `#23262e`, radius 16px, icon `#b8bcbf`.
  - Lock icon 16px.
  - URL text: 11px, `#67707b`, ellipsis, inside a pill (`padding 2px 16px 2px 8px; radius 16px`). Pill hover bg `#23262e`, text `#b8bcbf`.
  - Certificate error: `#de3618`.

### 1.7 Window controls [CSS]

- **Main-window controls area:** 99px wide, at the far right of the TitleBar row.
- **Buttons:** minimize, maximize/restore and close are each about 32×32 [EST]. The icon SVG is 14×14 with stroke `rgb(120,138,146)` (`#788a92`) and stroke-width ~24 on a 256 viewBox.
- **Hover:**
  - Minimize and maximize: bg `#3d4450`, stroke `#fff`.
  - Close: bg `#e22a27`.
  - All with `transition .15s ease-out`.
- **Minimize icon** is nudged up `translateY(-4px)` in DesktopUI.
- **Popup dialogs** (Properties, Settings and similar) use smaller `.title-area-icon` buttons, 24×18, with the same colours.

---

## 2. Library left panel (game list)

### 2.1 Panel container [CSS]

- **Width:** default 272px, min 256px, max `min(50%, 100% - 400px)`. Drag to resize.
- **Divider** (`LibraryWindowDivider`): 2px wide, `#17191b`, `cursor: ew-resize`. Hover `#333741`; `#5c606d` while dragging.
- **Panel background:** `linear-gradient(to bottom, rgb(45,51,60) 0%, #24282f 30%)`.
- **Scrollbars inside the library:**
  - Track width 12px. Thumb `#606774` with a 3px transparent border, which makes the visible thumb about 6px.
  - Hover `#7b8392`. Active: border 2px (thicker thumb).
  - No track and no arrow buttons.
  - **The thumb is transparent unless the panel is hovered:** `.LeftList:not(:hover) ::-webkit-scrollbar-thumb {background: transparent}`.

### 2.2 Header block, top to bottom [CSS + SS]

**Row A — Home + Collections** (`GameListHomeAndSearch`):
- Container: height 36px, `padding 4px 6px 2px 6px`, bg `#171d25`.
- Container shadow: `inset 1px 0 rgba(61,68,80,.75), inset 0 -1px rgba(38,45,56,.42), 0 3px 3px rgba(0,0,0,.2)`.
- **Home bar:**
  - `flex:1`, height 32px, radius 2px, bg `#25272d`, border `1px solid transparent`.
  - Label "Home": 13px weight 400, colour `#aeaeaf`, `margin-left 6px`.
  - Hover and selected: bg `#3e4047`, label `#fff`. Transition `background-color .16s ease-in-out`.
  - Decorative house line-art: a large 222×134 SVG at `top:-64px; left:39px`, `fill rgba(255,255,255,.05)`, stroke `#9b9b9b`. It is masked with `linear-gradient(to right, rgba(14,14,14,.2) 30%, black 80%)`.
- **Collections button** (right, 4px gap):
  - 30×30, radius 4px, showing a 2×2 grid icon. The grid boxes are 9×9 / 9×8 with a 4px gap, bg `#4c4d50`; they turn `#fff` on hover or selected.
  - Opens the "Collections" view.

**Row B — Type dropdown + quick filters** (`ViewFiltersBar`, `padding-top 8px`, `margin 4px 0 4px 6px`):
- **Type dropdown** (`MenuHeader`):
  - Height 32px, radius 3px, bg `rgba(33,33,36,.6)`, `padding 3px 5px 3px 8px`.
  - 13px text `#aeaeaf`, **UPPERCASE** label, e.g. "GAMES".
  - Down-triangle on the right: 14px, fill `#a9a9a9`.
  - Hover: bg `#3e4047`, text and arrow `#fff` (`.12s ease-in-out`).
  - Options: Games, Software, Tools, Soundtracks, Videos, etc. Multiple can be ticked.
- **Toggle icons** to the right (`CheckboxWithImage`):
  - Each 20×20 with a 2px horizontal margin: ① clock (**Recent** sort / "Sort by recent activity"), ② play triangle in a circle (**Ready to play** = installed only).
  - Fill/stroke: rest `gray`, hover `#a9a9a9`, active `#09b9ff`, active-hover `rgb(162,229,255)`, disabled `dimgray`.

**Row C — Search + Advanced filter:**
- Search container: `margin 6px 6px 10px 6px`, bg `rgba(33,33,36,.6)`, radius 4px.
- **Input:**
  - Height 32px, 13px, `padding-left 32px`, `padding-right 24px`.
  - Magnifier icon: 16×17 SVG at `background-position: 8px center`, colour `#808080`.
  - `border-bottom: 1px solid #32353a`.
  - Hover: bg `#1d2026`, `box-shadow: inset 1px 2px 4px 1px rgba(15,15,15,.65)`.
  - Placeholder "Search" is invisible at rest. On hover it fades to `rgba(255,255,255,.25)`; on focus `rgba(255,255,255,.5)` (`.21s ease-in-out`).
  - Clear "×" button: 16×16 at `right:6px; top:8px`.
- **Advanced filter button** (sliders icon):
  - 32px square, icon 20×20 fill `gray`.
  - Hover or open: bg `#3e4047`, icon `#d3d3d3`.
  - When filters are active, an inner highlight shows: bg `#1e90ff`, radius 2px.
  - It opens a flyout panel: bg `#3f4047`, radius 4px, `box-shadow 0 2px 8px 1px #000`. The flyout has a 16×32 tab connecting it to the button and animates `scale(.1)→1`, `opacity 0→1` over `.21s ease-in-out`, with `transform-origin 0 0`.
- **Filter chips in the search box:** bg `#1e90ff`, radius 3px, `padding 2px 6px 6px`, small "×" at `opacity .3` (→ 1 on hover).
- **Bottom fade:** a 6px gradient below the header, `linear-gradient(to bottom, rgb(36,40,47), transparent)`.

### 2.3 List content [CSS + SS]

**Section headers** ("FAVORITES (3)", "UNCATEGORIZED (120)", "ALL (240)"; in Recent mode "RECENT (12)", "APRIL (12)", …):
- Background: `linear-gradient(to right, #292f3b 40%, rgba(62,78,105,0) 100%)`.
- Collapse glyph: a 16×16 "—" (expanded) or "+" (collapsed), fill `#a2a2a3`, margin 2px.
- Name: **12px UPPERCASE, letter-spacing 1px**, colour `#cae4fb`. Header text at rest is `#707379`; the name turns `#fff` on hover.
- Count: "(12)", 12px, `rgba(255,255,255,.2)`, `margin 0 4px 3px`.
- Padding `3px 9px 3px 0`; row height ~22px [EST].
- Hover bg `#3e4e69`. Selected: bg `#3e4e69` with `box-shadow 0 0 2px rgba(0,0,0,.33), 0 0 16px rgba(0,0,0,.27)`.

**Game rows** (`GameListEntry`):
- **Size:** row height **24px**: icon 20px + `padding 2px 4px` [CSS+SS]. 13px weight 400, single line, ellipsis. Left/right 1px transparent borders. Indent ~8px.
- **Icon:** 20×20, radius 2px, `margin-right 5px`. This is the 32×32 community icon scaled down.
- **Text colour by state:**

| State | Colour |
|---|---|
| Installed | `#f1f7ff` (selected `#fff`) |
| Not installed | `#a3aab9` (hover `#c8d0dc`, selected `#c3c9d8`) |
| Installed on another PC (remote) | `#e7effb` |
| Updating / syncing / cloud error | `#26b7ff`, **weight 300**, selected `#74d1ff` |
| **Running** | `#adff2f` (yellow-green) |

- **Download suffix:** a dash " - " in `#a9a9a9`, then e.g. "Update Queued", "Downloading 45%" or "Update Paused" in `#74d1ff`. For a running game the suffix is `#81c221`.
- **Downloading icon:** the 20×20 game icon is replaced by a round progress ring. The icon is clipped to a circle and darkened `brightness(.4)`. A circle stroke `#74d1ff` animates `stroke-dashoffset` (`.2s linear`).
- **Hover:** bg `#323a4b`, text `#fff`.
- **Selected:** bg `#3e4e69` with soft shadow; hover on selected `#586f96`.
- **Context-menu-open row:** border `1px solid #506588`, bg `#293344`, hover `#586f96`.
- **Status badges at the right end:**
  - Friend-playing person icon: 11px, fill `rgba(161,244,16,.7)`.
  - Stream icon: `#09b9ff`.
  - Invalid-OS icon: `#a9a9a9`.
- **Drag & drop into collections:** target row gets `1px solid #1e90ff` side borders and bg `rgb(0,59,117)`. Drop options get dashed `#1e90ff` borders. The last item has a bottom border and `border-radius 0 0 8px 8px`.
- **Behaviour:**
  - Single click selects and opens the game page. Double click launches.
  - Right click opens the context menu (§5).
  - Rows are virtualized. Ctrl/Shift multi-select is supported.
  - Arrow keys move the selection.

### 2.4 "+ Add a Game"

Lives in the **footer**, bottom-left (§9), not in the panel.

---

## 3. Library Home

### 3.1 Page surface [CSS]

- Outer container: `background-image: linear-gradient(to bottom, #2d333c 0%, #23272d 20%, #171d25 60%)`.
- `LibraryHome` inner: `padding 8px 14px 14px`, `background: linear-gradient(to bottom, #2d333c 0%, #24282f 20%)`.
- Scroll container: `overflow-y: auto`, GPU-layered with `translate3d(0,0,0)`.
- Text base `rgba(255,255,255,.8)`.
- **Display size setting** (Settings › Library) sets the capsule width:

| Size | Portrait capsule (2:3 ratio, 600×900 art) |
|---|---|
| Small | 110 × 165 |
| Medium | 154 × 231 |
| Large (default "Automatic" picks by width) | 220 × 330 |

### 3.2 Shelf header (shared by every shelf) [CSS]

- Row: `display:flex; padding:0 10px`; header height ~24px (`Body` = `calc(100% - 24px)`).
- Title: **16px, weight 100 (thin), UPPERCASE, letter-spacing 2px**, colour `#ddd`. Clickable titles go `#fff` on hover.
- Rule: `flex:1; height 2px; margin-left 16px; background rgba(255,255,255,.05)`, vertically centred.
- Right side: a shelf settings gear (icon `rgba(255,255,255,.5)` → `#fff`) and left/right pager arrows (polygon fill `#a3a4a7` → `#fff`, `.21s`).

### 3.3 "What's New" shelf [CSS]

- Container (`UpdatesContainer`):
  - Height **324px** (Medium 300, Small 283), `padding 16px 16px 0 24px`.
  - Background `linear-gradient(to top, #171d25 0%, #2d333c 80%)`.
- Header "WHAT'S NEW" plus a gear (shelf priority settings).
- Horizontal carousel with **3 event capsules per page**, gap 16px, paged by arrows; native scrollbar hidden.
- **Event capsule:** event image (16:9, ~300px wide) [EST], then a footer.
  - Footer: event type ("NEWS", "MAJOR UPDATE", "PATCH NOTES" …) in a small tag, then the title (white ~15px weight 500), then game icon (16px) + game name in grey.
  - The date or time span sits above the capsule, small and grey.
  - Hover: image brightens and a summary text overlay appears [EST].
- "Now showing fewer updates for X" notice: 15px, weight 300, `rgba(255,255,255,.5)`, with an **Undo** pill (bg `rgba(211,216,224,.14)`, hover `.26`, radius 4px, height 32px). It fades out after 28s.

### 3.4 "Recent Games" shelf [CSS + EST]

- Row: `display:flex; justify-content:space-between; margin-top 4px`. Items are `flex:none` with a 16px gap.
- **Time-bucket labels** above each column: "Today", "Yesterday", "This week", "1 week ago", "2 weeks ago", "March", …
  - `AddedDate`: 12px, **weight 100**, `rgba(255,255,255,.4)`, line-height 14px, ellipsis. The media sits `margin-top 6px` below.
  - Consecutive games in the same bucket share one label; the following columns get an empty 14px spacer.
- **First (most recent) game is a big LANDSCAPE card:**
  - Width ≈ 2× portrait width + gap, same height as the portraits, e.g. 456×330 at Large [EST].
  - Shows the header or hero art cropped to the top.
  - Footer: 90px tall (76 Medium, 57 Small), showing a 200%-wide **blurred, darkened copy of the art** (`FooterBlurImage`, opacity .8).
  - Over the footer: a 60×60 green PLAY button (bottom-left, `left 8px; bottom 16px`), then text lines 12px: "LAST TWO WEEKS: 3.4 hrs" / "TOTAL: 120 hrs". The header line is uppercase, letter-spacing 1px; the values are `rgba(255,255,255,.51)`.
  - Hover: the image zooms `scale(1.06)` and gets `brightness(1.1) contrast(.95)`; the footer zooms too. `.6s cubic-bezier(0,.73,.48,1)`.
- **Remaining items:** portrait capsules (§3.7).
- The carousel shows as many as fit, with pager arrows. Extra height for labels is 75px (`CarouselExtraHeight`).

### 3.5 "Play Next" shelf

- Same carousel mechanics as Recent Games (portrait capsules).
- Subhead text explaining the suggestions, `rgba(255,255,255,.5)`.
- Each capsule has a context option "Dismiss from Play Next suggestions" [CSS keys + strings].

### 3.6 Other shelves

- **Friends Activity** (portrait capsules with a friends bar), **Special Offers** and user-added **collection shelves**.
- **Collection shelf header:** 16px, weight 100, uppercase, letter-spacing 2px, `#d3d3d3`. The count is `dimgray`, 8px gap. Rule: 1px `linear-gradient(to right, rgba(255,255,255,.2), transparent)` with `margin-left 16px`.
- **Dynamic collections:** a blue funnel icon (22px, fill `#5af`) before the name and an edit pencil. The hover pill is `rgba(255,255,255,.13)`, radius 2px.

### 3.7 "All Games" grid + header [CSS]

- **Header row:** "ALL GAMES (N)" uses the shelf header style.
  - At the right: **SORT BY** label (12px, weight 100, letter-spacing 1px, uppercase, `#a0a1a5`) then the sort dropdown.
  - Sort dropdown (12px, `#ccc`): value segment bg `rgba(255,255,255,.1)` with left radius 3px, `padding 1px 6px 0`. Arrow segment: same bg, 14px wide, right radius 3px, arrow fill `#969696`.
  - Dropdown menu (desktop): bg `#3d4450`, `box-shadow 0 10px 32px rgba(0,0,0,.67)`, items `padding 8px 18px; 13px; #dcdedf`, min-width 230px.
- **Sort options:** Alphabetical · Friends Playing · % of Achievements Complete · Hours Played · Last Played · Release Date · Date Added to Library · Size on Disk · Metacritic Score · Steam Review · Last Updated (· Favorites First).
- **Grid:**
  - `grid-template-columns: repeat(auto-fill, <capsuleWidth>)`, `justify-content: space-between`, row gap ~16px, `padding 8px 0`.
  - Sorting creates labelled subgroups: "Over 100 Hours", "Over 10 Hours", "Unplayed", "Not Installed", "10+ years ago" …
- **Grid size control:** the current client has **no zoom slider** in the grid header. Size comes from Settings › Library › "Library display size" (Small/Medium/Large/Automatic). A slider in your clone is optional and non-canonical [EST].

### 3.8 Portrait capsule (`LibraryItemBox`) [CSS]

- **Box:** `position:relative; overflow:hidden; cursor:pointer`.
  - `border-top: 1px solid rgba(201,201,201,.06); border-bottom: 1px solid rgba(0,0,0,.5)`
  - `box-shadow: 0 4px 8px rgba(0,0,0,.5)`
  - `transform-style: preserve-3d`
  - Parent (`Draggable`) has `perspective: 300px`.
  - Transition: `filter, box-shadow, transform .6s cubic-bezier(0,.73,.48,1)`.
- **Image:** `object-fit: contain`. It fades in from `blur(18px)` to `blur(0)` when loaded (`.4s cubic-bezier(0,.7,.8,1)`).
- **Missing art:** game name text centred on a dark tile.
- **Hover (3-D lift):**
  ```css
  transform: rotateX(3deg) translateZ(15px);
  filter: brightness(1.1) contrast(.95) saturate(1);
  box-shadow: 0 14px 12px 0 rgba(0,0,0,.3);
  z-index: 12;
  ```
  - Active/pressed: `brightness(.8) contrast(1.05)`, `.05s ease-out`. Click flash: `brightness(1.2)`.
- **Shine sweep** (`LibraryItemBoxShine`):
  - 220%-wide gradient `rgba(235,245,255,0) → .85 at 12px → .75 at 20% → transparent 60% → rgba(10,10,10,.8) 100%`.
  - Rest: `rotateZ(212deg) translate(12%,59%)`, opacity .1.
  - Hover: `rotateZ(210deg) translate(12%,32%)`, opacity .2.
- **Background glow** (`LibraryImageBackgroundGlow`): a copy of the art behind the card at `z-index:-99`, `filter: saturate(3) brightness(200%) blur(50px)`, `transform: translateY(20%) scale(.8)`. Opacity 0 → 1 on hover (`.4s ease-in-out`). This is the coloured halo under hovered capsules.
- **Hover action button** (`LibraryItemActionButton`):
  - 32×32, `left 8px; bottom 16px`, radius 2px.
  - Rest: `opacity 0; transform scale(.75)`. Card hover: `opacity 1; scale(1)` (`.21s ease-in-out`).
  - **Play** (installed): `radial-gradient(circle farthest-corner at 50% 50%, rgb(112,214,29) 0%, rgb(1,167,91) 100%)`. Triangle 56% of the box, fill `#c1ffcb`; on hover it scales 1.08 and turns `#fff`.
  - **Install/Download/Update:** `radial-gradient(ellipse at 50% 40%, rgb(12,53,71), rgb(8,39,53))`. Hover: `radial-gradient(… rgb(102,207,255) 0%, rgb(24,131,177) 100%)`. Download-arrow icon.
  - `box-shadow 1px 1px 4px 1px rgba(0,0,0,.5)`.
- **Uninstalled indicator:** a small download icon (32×32 max 20%, opacity .2) bottom-right. It hides on hover.
- **Download progress bar** under the art: `UninstalledBar` 4px, radius 4px, track `rgba(0,0,0,.7)`, fill `#20aaeb`, `width` transitions `.8s ease-in-out`.
- **"Update available" badge:** a top-right corner triangle (`linear-gradient(45deg, transparent 50%, rgba(1,1,1,.3) 50%, #000 100%)`) holding a 4px glowing dot `#9cffff` with `box-shadow 0 0 24px 8px #2e32ff, 0 0 64px 4px #2e32ff`.
- **Banner pill on the top edge** (e.g. "NEW", "FREE WEEKEND", "PRE-LOAD"):
  - bg `#1a9fff`, 10px bold uppercase, letter-spacing .5px, `padding 2px 12px`, `box-shadow 0 1px 8px #253553`.
  - "Coming soon" variant: bg `#3d4450`, text `#1a9fff`.
- **Subscript pill under the card** (when sorting by review, achievements, etc.):
  - 12px, bg `#3d4450`, radius 3px, `padding 2px 13px`, `margin-top -16px`, `box-shadow 0 0 5px rgba(0,0,0,.6)`.
  - It lifts with the card on hover.
  - Review colours: positive `#1a9fff`; mixed `#b9a074` with dark text; negative `#a34c25`.
  - Metacritic: green `#00ce7a`, orange `#ffbd3f`, red `#ff6874`, fully rounded.
- **Hover popover** (`AppPortraitHover`): after ~0.5s hover a floating card appears [EST timing]. It shows a larger capsule, game name, playtime, friends playing, and last update.

---

## 4. Game details page

### 4.1 Page structure [CSS]

```
ScrollContainer (bg #24282f, overflow-y: scroll)
 ├─ Header / hero (height = min(24vw, 320px)), logo overlaid
 ├─ PlayBar (action bar)  — becomes sticky at top when scrolled
 ├─ LinksSection (sub-nav: Store Page | DLC | Community Hub | Points Shop | Discussions | Guides | Support)
 └─ ColumnContainer (padding 10px)
     ├─ LeftColumn  (flex: rest)  — activity feed
     └─ RightColumn (width 33%, margin-left 32px; 22px in narrow windows; stacks below in ultra-narrow)
```

### 4.2 Hero banner and background [CSS + SS]

- **Height:** `--header-height: 24vw`, clamped by `max-height: 320px` (hero art is 3840×1240, ratio 3.1:1). Use `height: min(24vw, 320px)` relative to the window.
  - With no hero art: a 24vw placeholder using the header capsule art, or flat `#141414`.
- **Image** (`ImgSrc`): `object-fit: cover; width: calc(100% + 128px); max-width: 1660px`, centred.
  - It is masked by a vignette PNG on all sides (`mask-size: 100% 100%`). Emulate with `mask-image: radial-gradient(ellipse 120% 100% at 50% 0%, #000 60%, transparent 100%)` combined with a bottom fade [EST].
- **Blur backdrop ("Glassy" mode, default since 2023):**
  - A second copy of the hero (`ImgBlur`) is absolutely positioned at 130% height under the page with a blur, plus a vertically flipped copy (`ImgBlurBackdrop`: `transform: scaleY(-1); height: 200%; opacity: .2; filter: saturate(2)`) faded with `mask: linear-gradient(to top, #000 80%, transparent)`.
  - Result: the art's colours bleed softly down behind the action bar and the top of the body.
  - Glassy page base: `radial-gradient(100% 100% at 45% 35%, rgb(44,50,61) 0%, rgb(21,22,22) 100%)`.
  - Body backdrop panel: 450px tall, `backdrop-filter: blur(8px)`, `linear-gradient(to bottom, rgba(39,44,53,.1) 0%, rgba(39,44,53,.7) 82px, rgba(39,44,53,.3) 80%, transparent 100%)`.
- **Parallax:** the hero sits at `translateZ(-1px) scale(2)` in a `perspective: 1px` scroll container (HighPerf mode), so it scrolls at half speed. A simple `transform: translateY(scrollTop * .5)` is fine.
- **Logo placement** (`TitleLogo`):
  - An absolutely positioned PNG logo inside the hero safe area (`top 16px; left 26px; right 26px; bottom 16px`).
  - The developer-supplied `logo_position` object gives `pinnedPosition` (`BottomLeft` default | `UpperLeft` | `CenterCenter` | `UpperCenter` | `BottomCenter`) plus `nWidthPct` / `nHeightPct` (e.g. 40% × 60%).
  - Default when unknown: **BottomLeft**, width ≈ 40%, height ≈ 55%, `object-fit: contain; object-position: bottom left`.
  - No logo: draw the game name as SVG text, white, `letter-spacing 1px`, `text-shadow 1px 1px 10px #000, 0 0 22px rgba(0,0,0,.53)`, bottom-left `padding 0 0 20px 24px`.
- **Top-right on the hero:** collection tags (`InCollection`), e.g. "INSTALLED LOCALLY", "FAVORITES".
  - 12px uppercase, `rgba(255,255,255,.6)`, `border 1px solid rgba(255,255,255,.1)`, bg `rgba(0,0,0,.1)`, `backdrop-filter: blur(6px)`, `padding 0 6px`, 6px gap.
  - Hover: white text, border `.3`, bg `.3`. Max 33% of the width; wraps.
  - Hidden-game tag: 18px, lilac `rgba(237,196,253,.8)`.
- **Bottom-right on the hero:** a "friends in-game" badge (`#59bf40` pill, 21px tall, with count) at `right 24px; bottom 16px`.

### 4.3 Action bar (`PlayBar`) [CSS + SS]

- **Container:**
  - `padding: 10px 20px 7px`. Row height = **46px** controls, so the total bar is ~63px [CSS].
  - Background over the hero: `linear-gradient(to top, #24282f 18px, transparent 100%), rgba(29,34,39,.75)`. In Glassy mode it is mostly transparent with a hairline top highlight `rgba(193,202,207,.1)`.
  - **Sticky state** (scrolled past the hero): bg `#222830` plus `linear-gradient(to top, #24282f 18px, transparent)`, `box-shadow 0 6px 16px rgba(0,0,0,.27), 0 2px 6px rgba(0,0,0,.53)`, height compresses to 32px.
    - The game icon (32×32, radius 3px) + name fade in at the left.
    - The stats fade out with `translateY(-24px)`, `.16s ease-out`.
    - Glassy sticky: `backdrop-filter: blur(8px); background: rgba(39,44,53,.7)`.
- **Main button** (`PlayButton`):
  - `min-width: 164px; height: 46px; padding: 4px 12px; border-radius: 2px`.
  - 20×20 icon with `margin-right 8px`, then label **20px, weight 300, UPPERCASE, letter-spacing 1px**, white, line-height 32px.
  - Background (both variants): `background-size: 330% 100%; background-position: 25%`. On hover `background-position: 0%` (a lighter sweep) with `transition: background .2s ease-out`.

| State | Label | Background |
|---|---|---|
| Installed | ▶ PLAY | `linear-gradient(to right, #70d61d 0%, #01a75b 60%)`, icon fill `#c1ffcb` |
| Not installed | ⤓ INSTALL | `linear-gradient(to right, #47bfff 0%, #1a44c2 60%)`, icon `#cbeeff` |
| Update required | ⤓ UPDATE | blue gradient (as Install) |
| Downloading | ❚❚ PAUSE (or RESUME) | blue gradient |
| Running | ✕ STOP | blue gradient. The context-menu CSS puts Stop in the blue group; the play-bar colour is [EST] |
| Launching | "LAUNCHING" + throbber | blue/green at .5 opacity throbber |
| Unavailable | label | `#2e3136`, text `rgba(255,255,255,.5)` |

- **Stream / launch-target split:** a 25px segment on the right edge of the button (`margin-left 3px`). It is darker (`rgb(25,177,78)` on green, `rgb(35,94,207)` on blue) and has a ▾ that opens "Play from / Stream from <PC>".
- **Running game:** add a square **Shutdown button** right of the main button: 48×48, radius 2px, bg `rgba(172,178,201,.14)`, hover `rgba(205,213,226,.26)`, X icon `rgba(255,255,255,.5)`. While stopping, a 40px spinner ring with border `2px solid #1a9fff` (right/bottom transparent) rotates (2s linear infinite).
- **Inline download progress** (`DetailsSection.Downloading`, clickable → Downloads page). It sits next to the button, replacing the stats:
  - Label "DOWNLOADING" / "UPDATE QUEUED" / "PAUSED": 14px uppercase, letter-spacing 1px, white.
  - Detail line "1.4 GB of 7.02 GB": 13px, `rgba(255,255,255,.32)`.
  - Progress bar 170×4, radius 3px, track `#151619`, fill `#2d73ff` (paused `#535c70`), `width` animates `.1s linear`.
- **Stats** (`GameStatsSection`): each `GameStat` is `padding 6px; margin 0 5px; radius 4px`. A 30×30 icon (stroke/fill `rgba(255,255,255,.4)`) then two lines:
  - Label: **14px UPPERCASE, letter-spacing 1px**, `rgba(255,255,255,.52)`, e.g. "LAST PLAYED".
  - Value: 13px, `rgba(255,255,255,.32)`, e.g. "Today", "5.5 hours", "3/51".
  - Order: (CLOUD STATUS "Up to date") · LAST PLAYED · PLAY TIME (clock icon) · ACHIEVEMENTS ("3/51" plus a mini progress bar, track `#151619`, fill `#2d73ff`).
  - Stats hide progressively as the panel narrows: ACHIEVEMENTS first, then LAST PLAYED.
  - Clickable stats (cloud, achievements): bg `rgba(172,178,201,.14)`, hover `.26`.
- **Right-side icon buttons** (`AppButtonsContainer`, pushed right with `margin-left:auto`):
  - Each 32×32, `padding 7px`, radius 4px, bg `rgba(172,178,201,.14)`, `margin-right 10px` (last 0). Hover bg `rgba(205,213,226,.26)` with the icon going white. Menu-open: `rgba(172,178,201,.28)`. Icons `rgba(255,255,255,.5)`.
  - Buttons, in order:
    1. **Controller** layout (only if a controller is connected)
    2. **Gear**: opens the Manage menu (same as context menu › Manage + Properties…)
    3. **Info (i)**: toggles the "game info" panel (store-like description/features), `transform .32s`
    4. **Favorite ☆**: stroke `rgba(255,255,255,.5)`; favorited → filled `#67b3ff` with a 0.8s pop animation

### 4.4 Sub-nav links row (`LinksSection`) [CSS + SS]

- **Box:** a full-width rounded box (radius 2px) under the play bar, `margin 0 10px`, `padding 4px 10px 2px`.
  - Background `radial-gradient(100% 80% at 64% 95%, rgba(108,119,134,.1) 40%, rgba(83,104,104,.1) 100%)`.
- **Links:** 13px, `rgba(255,255,255,.32)`, `padding 2px 12px 4px`, radius 2px. Evenly distributed across the width [SS].
  - Hover: bg `rgba(101,113,128,.36)`, text `#fff` (`.2s ease-out`). Disabled: `rgba(255,255,255,.15)`.
- **Items:** Store Page · DLC · Community Hub · Points Shop · Discussions · Guides · Support. Optional: Workshop · Market · Find Groups.
- **Overflow:** links that don't fit collapse into a "⋯" menu at the right (26px wide).

### 4.5 Body two-column layout [CSS + SS]

- **Section header** (`SectionHeader`): **14px UPPERCASE, letter-spacing 1px, `#94a1a6`**, `padding-left 10px`. Optional "›" arrow 14px fill `#717070`. Sections are `margin-bottom 26px`; the inner box is `margin 10px`.
- **Panel background** for section boxes:
  - `radial-gradient(100% 80% at 64% 95%, rgba(58,75,99,.6) 0%, rgba(35,48,66,.3) 40%, rgba(21,22,22,.1) 100%)`
  - plus a 1px "glass" border image. Approximate with `border:1px solid rgba(255,255,255,.04)`.
  - `padding 12px 12px 10px`, radius 2px.
- **Highlight card** (`Highlight`): `linear-gradient(to right, rgb(59,65,74) 0%, rgb(44,49,56) 95%)`, `box-shadow 1px 2px 12px 1px rgba(26,27,37,.25)`, 13px `#ccc`, padding 10px.

**Left column (activity feed):**
- POST-GAME SUMMARY (when just played): screenshots, achievements earned, "Did you enjoy playing X? Yes / No / Maybe Later" review prompt.
- ACTIVITY: "Say something about this game to your friends…" input. It is a 40px-tall dark field, bg `rgba(0,0,0,.2)`, with a 14px italic placeholder `#8b929a` [EST].
- Date-grouped feed ("TODAY", "JUNE 5"): headers in the section-header style. Event cards: news, patch notes, friend achievements, screenshots, reviews.
- Footer: "View Latest News" link.

**Right column:**
- FRIENDS WHO PLAY:
  - Subheads 13px `#cacbcd` ("3 friends are playing now", "1 friend has X on their wishlist").
  - Avatars 32–36px in a row (a "+N" remainder tile 36×36 bg `#0e141b`); "Friends in game" rows 36px tall with name/status.
  - "View all friends who play" link bottom-right, 13px `#888`.
  - Playtime header card: `radial-gradient(circle at top left, rgba(81,148,255,.5), rgba(0,39,112,.075))`, cyan text `#b5ffff`.
- ACHIEVEMENTS:
  - "You've unlocked 4/46 (8%)" (the percentage in grey), with a 10px progress bar (black track, blue `#1a9fff` → `#2d73ff` fill).
  - Then a row of the most recent achievement icons (64px), "Locked achievements" icons (greyed), and a "View My Achievements" button.
- SCREENSHOTS / RECORDINGS, NOTES ("Create a note"), TRADING CARDS:
  - Badge 80×80, name 14px weight 300 `#ccc`, level `#888`.
  - Cards are ~31% width (max 85px) in a wrapping row, gap 8px. Unowned cards are 30% opacity and desaturated; hover tilts the card with shine.
  - "N cards remaining" in `#888`. Can-level-up state: blue gradient box.
- ADDITIONAL CONTENT / DLC (2-col grid of DLC header art, gap 8px), SOUNDTRACKS, WORKSHOP.
- "Game info" side box (release date, developer, features).

---

## 5. Context menu, Manage submenu, Properties

### 5.1 Desktop context-menu style (global) [CSS]

- **Menu:** bg `#3d4450`, `box-shadow: 0 10px 32px 0 rgba(0,0,0,.67)`, `padding 4px` [EST from the base rule], square corners, `z-index 1600`. Fades `opacity .2s`.
- **Item:** `padding 8px 18px`, 13px, `#dcdedf`, `display:flex; align-items:center`, no borders, min-width fit-content.
  - Hover or keyboard focus: **bg `#dcdedf`, text `#3d4450`** (an inverted light highlight).
  - Disabled: `#67707b`, no hover.
  - Checked: `#6dcff6` (or a leading ✓).
- **Separator:** `border-bottom: 0.2px solid #67707b` (a hairline).
- **Submenu items:** a trailing chevron (14×14 down-arrow rotated −90°, fill `#9ca4a7`). The submenu opens on hover to the right, same style.
- **Section header items:** 12px uppercase.

### 5.2 Game right-click menu (installed game) [CSS strings + EST order]

1. **PLAY** (action item, see below)
2. *(separator)*
3. Add to Favorites / Remove from Favorites
4. Add to ▸ → list of user collections (checkable) · New collection…
5. Remove from ▸ (only if in a collection)
6. Manage ▸ (see 5.3)
7. Properties…

**Action item** (`ContextMenuAction`):
- Rounded 3px, white, UPPERCASE, letter-spacing 1px.
- Green variant (PLAY / LAUNCH / STREAM): `linear-gradient(-45deg, #236c39 0%, #59bf40 70%)`, hover `linear-gradient(-45deg, #59bf40 0%, #5be33a 70%)`.
- Blue variant (INSTALL / UPDATE / DOWNLOAD / PAUSE / RESUME / STOP / CANCEL / PURCHASE / BORROW / PRELOAD): `linear-gradient(-45deg, #0056d6 8%, #1a9fff 90%)`, hover `linear-gradient(-45deg, #1a9fff 8%, #00bbff 90%)`.

**Variants:**
- Uninstalled: INSTALL replaces PLAY.
- Running: STOP (blue).
- Downloading: PAUSE / RESUME, CANCEL.
- Multi-select: "Install selected", "Uninstall selected", Add to ▸ …

### 5.3 Manage ▸ submenu [strings; order EST]

- Add desktop shortcut
- Set custom artwork / Clear custom artwork (when used from the hero)
- Browse local files *(installed only)*
- Back up game files… *(installed only)*
- Uninstall *(installed only)*
- *(separator)*
- Hide this game / Remove from Hidden
- Mark as Private / Unmark as Private
- Remove from account
- Family ▸ (Allow / Deny for child) *(Steam Family only)*
- Controller layout · CD keys *(when applicable)*

### 5.4 Properties dialog [strings + EST layout]

- **Window:** a separate popup, ~**850 × 620** [EST]. Title "Properties - *Game Name*". Dialog chrome as in §10.1.
- **Layout:** paged settings. Left nav column ~220px [EST] with tabs; right page `padding 24px`, scrollable.
- **Row style:** label + description on the left, control on the right, 1px separators (same as Settings §8.2).

| Tab | Contents |
|---|---|
| **General** | Toggle "Enable the Steam Overlay while in-game" · "Use Desktop Game Theatre while SteamVR is active" · **Language** dropdown ("Select the language you want X to use") · **Launch Options** text field (+ "Selected launch option" dropdown if the game defines several) · **Steam Cloud** toggle "Keep game's saves in the Steam Cloud for X" with "N MB stored / N GB available" · **Game Recording**: Background Recording (Enabled / Disabled / Use global) |
| Compatibility *(Linux/macOS)* | "Force the use of a specific Steam Play compatibility tool" + tool dropdown |
| **Updates** | **Automatic Updates** dropdown: Use global setting / Let Steam decide when to update / Wait until I launch the game / Immediately download updates (with description) · **Background Downloads** dropdown: per-global / Always allow / Never allow · footer text "Build ID: N" and "Installed content updated: date at time" |
| **Installed Files** | "Size of installation: 7.02 GB on C:" + **Browse…** · **Backup game files** · **Verify integrity of game files** (shows progress "Verifying integrity of files…" / "All N files successfully validated") · **Move install folder** — each a full-width row with a right-aligned button |
| **Game Versions & Betas** (formerly "Betas") | "Selected Game Version" list: Default Public Version + each beta as a selectable row (Name & Description · Last Updated), selected = blue highlight · **Private Versions**: access-code input + **Check Code** button ("Success! Beta unlocked.") |
| **Controller** | "Override for *Game*" dropdown: Use default settings / Enable Steam Input / Disable Steam Input · status table per controller type (Xbox, PlayStation, Nintendo Switch, Generic): Enabled/Disabled + reason · Rumble intensity · "Controller Configurator" link |
| **DLC** *(if any)* | Search box · sortable table: [checkbox Install] Name · Added · Size · State (Installed / Uninstalled / Downloading) · "View more in Store" |
| Workshop *(if any)* | Subscribed items list with enable/disable, load order, size, sort/filter |
| **Privacy** | Toggle "Mark as Private" ("Your activity in this game is not visible to others") · Toggle "Hide in library" |
| **Customization** | **Artwork**: preview tiles for Capsule (portrait), Hero, Logo, Header, each with Change / Reset · **Miscellaneous**: "Custom Sort Name" + Change |
| Shortcut *(non-Steam games)* | Name field, icon picker, Target, Start In, Launch Options, "Include in VR Library" |

---

## 6. Downloads page

Opened from Library › Downloads or by clicking the footer download status.

### 6.1 Page [CSS]

- Background: `radial-gradient(farthest-corner at 0 0, #3d4450 0%, #23262e 90%)`.
- Structure, top to bottom:
  - **TopSection (graph), 200px fixed**
  - **Active item** (when downloading)
  - Scrollable **ItemLists**: Up Next / Scheduled / Unscheduled / Completed
  - **SectionJumpBar**, 36px, at the bottom

### 6.2 Network / disk graph (TopSection, 200px) [CSS + SS]

- **Left: active-download hero.**
  - The current game's hero art is scaled 1.5× and masked `linear-gradient(to right, #0e141b 40%, transparent 100%)`.
  - Tinted by an overlay `linear-gradient(to right, transparent 15%, #0056d6 90%)` with `mix-blend-mode: multiply` (a blue wash).
  - The game logo sits on top at `left 20px`, 50% width (max 530px), 90% height, with a blurred black drop-shadow copy (`brightness(0) blur(4px)`, opacity .75, offset 4px).
  - Nothing downloading: a blue gradient blob `#0056d6 → #1a9fff`, opacity .3.
- **Graph** (`DownloadGraph`): starts at `margin-left 200px`, about 64% wide (55% in narrow windows), full 200px height. It is masked so it fades in from the left (`transparent 0–80px → opaque 145px`) and uses `mix-blend-mode: screen`.
  - **Network:** one bar per sample (1px wide columns, bar 0.5px), colour `rgba(26,159,255,.5)` (#1a9fff at 50%). Hovering a column brightens it.
  - **Upload** bars: `rgba(83,64,166,.8)` (purple).
  - **Disk usage:** a **green line** `#59bf40`, 2px, `vector-effect: non-scaling-stroke`, in the bottom 60% of the area. Hover points: 8px round caps, white.
  - No visible axes or gridlines. Hover tooltip shows "Network 12.4 MB/s" or "Disk Usage 8.1 MB/s" with the game icon.
- **Legend** (top or bottom-left of the graph): `■ NETWORK` (14px square icon, `rgba(26,159,255,.9)`) and `— DISK USAGE` (2px green line). 10px bold uppercase, letter-spacing .5px, `#b8bcbf`, 24px apart.
- **Stats** (right of the legend, `gap 10px`, each min 100px):
  - Figure line: 12px bold white, e.g. "28.3 MB/s".
  - Label: 10px bold uppercase `#8b929a`, letter-spacing .5px.
  - Items: **CURRENT · PEAK · TOTAL · DISK USAGE**.
- **Settings gear:** top-right (`top 20px; right 24px`), 16px icon in a 28px square, bg `#3d4450`, hover `#67707b`, radius 2px. Opens Settings › Downloads.

### 6.3 Active download item [CSS + SS]

- **Box:** a full-width block, bg `#0e141b`, `padding 20px 24px 14px` (right column).
- **Left:** game header capsule (~161×75 or larger).
- **Title:** game name **28px**, white, normal weight. Content-type tags at the top-right of the box: "Game content", "Workshop content", "Shader pre-caching update" (12px bold uppercase `#67707b`, check icon `#59bf40` when done).
- **Status line:** "DOWNLOADING" / "PAUSED" / "VERIFYING" etc., 14px bold uppercase, letter-spacing 1px, left aligned. Then "Estimated 4 min remaining" in 12px light `#67707b`.
- **Progress bars** (stacked, gap 10px):
  - Track `#3d4450` (row hover `rgba(103,112,123,.5)`).
  - Network-phase fill `rgba(26,159,255,.5)`, disk-phase fill `#59bf40`, overall fill `#1a9fff`, not-active `#67707b`.
  - About 6px tall [EST], with "1.4 GB / 7.02 GB" (12px bold uppercase `#8b929a`; in-progress number `#dcdedf`) and the % at the right.
- **Buttons:**
  - Primary **PAUSE / RESUME**: `padding 10px 16px`, icon 16px + uppercase text. Background `linear-gradient(314deg, #0056d6 -23%, #1a9fff 120%)`, `background-size 330% 100%`, position 25% → 0% on hover.
  - Remove-from-queue X: `#67707b` → `#8b929a`.
- **Throttle note:** "Downloads limited to: 10 MB/s" (12px bold uppercase `#67707b`, value `#8b929a`, hover `#1a9fff`) and "Auto-updates enabled" / "Auto-updates scheduled from 1 AM to 5 AM" (12px, `#8b929a`; hours `#dcdedf` → hover `#1a9fff`).

### 6.4 Queue sections [CSS]

- **Section title row:** `padding 0 40px 0 24px`.
  - Title: **20px bold, letter-spacing 1px, UPPERCASE, white**, line-height 34px, e.g. "UP NEXT".
  - Count: weight 500, uppercase, `#8b929a`, e.g. "(3)".
  - Rule: `flex:1; height 2px; margin 0 10px; background rgba(103,112,123,.3)`.
  - Right-side button: **CLEAR ALL** (Completed) or **PAUSE ALL / RESUME ALL**. `#3d4450`, white, 16px, `padding 10px 24px`, min-width 118px, radius 2px, hover `#67707b`.
- **Section order:** **Up Next** · **Scheduled** · **Unscheduled** · **Completed**. Sections are 24px apart and `padding-bottom 24px`. Empty sections are hidden. Empty queue message: "There are no downloads in the queue".
- **Row** (`SectionItem`):
  - **Height 75px**, `padding 8px 0 8px 12px`, `gap 24px`, radius 2px when hovered.
  - Hover bg `#3d4450`; dragging uses the same.
  - **Capsule:** the header image at **161×75** (no borders or shadow).
  - **Name:** 18px/22px, weight 500, white, ellipsis. A content-type suffix in `#67707b` may follow.
  - **Details line** (22px high, gap 10px): "1.2 GB / 7.0 GB" or "7.02 GB" · "Patch notes" link (12px bold uppercase, hover `#99d4ff`, with a 16px news icon) · auto-update/throttle text.
  - **Right column** (max 33vw): status text 14px bold uppercase, letter-spacing 1px: "QUEUED", "PAUSED", "NEXT", "Completed: 3:42 PM", or the scheduled time; error state `#de3618`. A thin progress bar for partially downloaded items.
  - **Buttons** (36px slots):
    - ▶/❚❚ "Download now" (move to top) and the pause/resume toggle: 20px icon in a square with 8px padding (36×36 total), bg `#3d4450`, radius 2. Row hover → `#67707b`; button hover → `#8b929a`.
    - **✕ Remove from queue**: 12px icon, visible only on row hover.
    - Completed rows add "Go to game page" / "Launch" (▶ green play).
  - **Drag handle:** a 24×24 grip icon `#67707b`, centred horizontally (`left: calc(50% - 12px)`), opacity 0 → 1 on hover. Rows reorder by dragging between Up Next and Unscheduled. Drop zones use a dashed `#1e90ff` outline and `radial-gradient(100% 100% at 33% 45%, rgb(17,89,148), rgb(8,37,61))` when dragging over.
- **SectionJumpBar:** a 36px bar pinned at the bottom of the list. It slides up after .25s when a section header scrolls off and shows "VIEW: <section> (n)" in 14–16px uppercase.

### 6.5 "Paused while playing" banner

- The **current string table has no "Downloads paused while playing" string.**
- **What the client actually does** when a game runs with "Allow downloads during gameplay" off:
  - Footer: "Downloads Paused - N Items Queued".
  - The active item status reads PAUSED.
  - The bar fill uses the paused colour `#535c70`.
- **If you want a banner** [EST]: a 40px strip at the top of the list, bg `rgba(26,159,255,.15)`, `border-left: 3px solid #1a9fff`, 13px `#dcdedf`, with a "Resume" button in DialogButton style.

---

## 7. Store tab header

The Store tab is the web store inside the client browser view. It sits under the client chrome (§1), with a URL row showing `https://store.steampowered.com/`.

**Current (late-2025) store nav [SS, Nov-2025 screenshot]:**
- A full-width **dark navy bar**, ~49px tall, centred content (max ~1100px, older layout 940px).
- Left to right: **Browse ▾ · Recommendations ▾ · Categories ▾ · Ways to Play ▾ · Special Sections ▾**.
  - 13px, white-ish `#d9dadd`, `padding 0 15px`, small chevrons.
  - Each opens a mega-dropdown.
- **Search:** "Search the store" field (italic placeholder) with a **blue square search button** (magnifier) on the right.
- Then **★ Wishlist** (and a **Cart (n)** button when the cart has items, green `rgba(164,208,7,.4)` style).

**Classic nav** (what the brief lists; still found on older pages and in Valve's CSS):
- Tabs: **Your Store ▾ · New & Noteworthy ▾ · Categories ▾ · Points Shop · News · Labs** + search box.
- Bar: `height 35px; margin 7px 0`, background `linear-gradient(90deg, rgba(62,103,150,.919) 11.38%, rgba(58,120,177,.8) 25.23%, rgb(15,33,110) 100%)`, `box-shadow 0 0 3px rgba(0,0,0,.4)` [CSS store.css].
- Tab text: 13px **bold** `#d9dadd`, line-height 33px, `padding 0 15px`.
- Tab hover/focus: `background: linear-gradient(135deg, #67c1f5 0%, #417a9b 100%)`, white text.
- Above the bar, right-aligned: "Wishlist (n)" and cart pills, 11px, bg `rgba(103,193,245,.2)`-ish. The cart pill is green `rgba(164,208,7,.4)`.
- Store page background: `--gpGradient-StoreBackground: linear-gradient(180deg, #2A475E 0%, #1B2838 80%)`. Store greys: `#CCD8E3 #A7BACC #7C8EA3 #4e697d #2A475E #1B2838 #000F18`.

**Recommendation for a clone:** render the store as an embedded webview, or as a React page that uses the new 5-dropdown nav.

---

## 8. Settings window

### 8.1 Window [CSS + EST]

- **Window:** a separate popup, ~**1000 × 720** default [EST], resizable. Title bar height `calc(1rem + 24px)` ≈ 40px containing "Steam Settings" [CSS] and controls 24×18.
- **Background:** dialog gradient `radial-gradient(circle at top left, rgba(74,81,92,.4) 0%, transparent 60%), #25282e`.
- **Focus hairline:** 1px top bar `linear-gradient(to right, #00ccff, #3366ff)`, shown only while the window is focused.
- **Left column** (`PageListColumn`): min-width 240px, max 40%, bg `rgba(255,255,255,.1)` over the dialog bg (≈ `#3b3e45`). The list has `padding 16px 0` and scrolls.
- **Nav item:**
  - `padding 10px calc(12px + 1.4vw)`, 16px (desktop renders ~14–15px [EST]), colour `#b8bcbf`, line-height 22px.
  - Hover bg `rgba(255,255,255,.05)`.
  - **Active:** bg `rgba(255,255,255,.15)`, text `#fff`, and the gamepad build adds `transform: scale(1.1)`. On desktop use a plain lighter row without scaling [EST].
  - Optional 20×20 icon with `margin-right 16px`. Big Picture shows icons; desktop shows text only [EST].
- **Categories:** Account · Family · Privacy · Security · Notifications · Interface · Library · Downloads · Storage · Cloud · In Game · Game Recording · Friends & Chat · Controller · Voice · Remote Play · Broadcast · Music · (Compatibility on Linux) · (Customization).
- **Right page:** `padding 24px` with a top fade mask (`linear-gradient(to bottom, transparent, black 25px)`).
  - Page title: DialogHeader 22px bold white, `margin-bottom 8px`.
  - Sub-section header: **15px, weight 500, `#8b929a`**, letter-spacing .5px.

### 8.2 Setting row (`Field`) [CSS]

```
┌──────────────────────────────────────────────────────────────┐
│ Label (14px/18px #dcdedf)                       [control]    │
│ Description (13px/18px #8b929a, weight 400)                  │
└──────────────────────────────────────────────────────────────┘  ← 1px rgba(255,255,255,.1) separator
```

- `padding: 10px 0`; label row `display:flex; justify-content:flex-end; align-items:flex-start; column-gap 10px`.
- Label: `flex-grow:1`. Description `margin-top 4px`.
- Disabled: label and description `#67707b`.
- Separator: `::after` 1px `rgba(255,255,255,.1)`, full width. Indented children get 18–20px left indent per level.
- Children-below variant (e.g. a text field under the label): `margin-bottom 6px` between them.

### 8.3 Controls [CSS]

- **Toggle:**
  - 38×22. Rail bg `rgba(255,255,255,.15)`, radius 9001px; when on, the rail is `#1a9fff` (a `::before` that slides `translateX(-27px → -11px)`, `.2s ease-out`).
  - Knob: 22px white circle, `box-shadow 0 0 5px rgba(0,0,0,.35)`, `transform translateX(0 → 16px)` with a springy `cubic-bezier(.1,.12,.53,1.72)` .2s.
  - Hover ring: `box-shadow 0 0 0 4px rgba(255,255,255,.3)`, radius 16px.
  - Disabled: rail `#67707b`, knob `#8b929a`.
- **Dropdown** (`DialogDropDown` in SettingsModal):
  - Bg `rgba(59,63,72,.5)`, radius 3px, `padding 8px 14px`, 13px/18px `#dfe3e6`, gap 16px between value and arrow.
  - Arrow: 1em, fill `rgb(24,156,255)` (blue) [CSS].
  - Hover: bg `#464d58`, white, `box-shadow 0 6px 8px rgba(0,0,0,.16)`.
  - Menu: bg `#373c44`, `box-shadow 0 8px 26px 2px rgba(0,0,0,.2)`. Items `padding 10px 15px`, focus/hover bg `#3e444d`. Separator 1px `rgba(103,112,123,.3)` with 10px margin.
- **Button** (`SettingsDialogButton`): bg `rgba(59,63,72,.5)`, `#dfe3e6`, `padding 8px 14px`, 13px/18px, radius 2px. Hover `#464d58` (see §10.1 DialogButton).
- **Text input** (`DialogTextInputBase`):
  - Bg `rgba(59,63,72,.5)`, radius 3px, 14px weight 300 `#dfe3e6`, `padding 10px` (line-height 22px).
  - Hover `rgba(67,73,83,.6)`.
  - Focus: bg `#23262e`, `box-shadow inset 1px 1px 4px rgba(0,0,0,.67)`, `padding-left 11px`.
  - Placeholder `#969696` italic.
- **Links:** `#1a9fff` 14px.

### 8.4 Storage manager (Settings › Storage) [CSS]

- **Top: drive selector.**
  - Dropdown showing "Local Drive (C:)" in 14px weight 500 `#b8bcbf` and "123.4 GB free of 931.5 GB" in 12px bold uppercase. The default drive gets a yellow ★ (`#ffc82c`).
  - The selected option bg is `#3d4450`.
  - A "⋯" menu holds Make Default / Repair / Remove / Rename / Add Drive.
- **Usage bar:**
  - Full width, `min-height 8px`, radius 10px.
  - Empty background: diagonal stripes `repeating-linear-gradient(315deg, #363d48 0 10px, #3d4450 10px 20px)`.
  - Segments, left to right: **Games `#1a9fff`** · DLC `#5340a6` · Workshop `#59bf40` · Updates `#ef806c` · Shaders `#ad66bb` · Media `#236c39` · Non-Steam/Other `#ffc82c` · Free `#3d4450`.
- **Legend under the bar:** 8px coloured dots + label (white) + size (`#b8bcbf`), 10px apart, wrapping.
- **Game list:**
  - Sticky column header (`padding 8px`): "N Games" + sortable columns **Last Played** · **Size** (8px triangles `gray`), with a 2px rule `rgba(103,112,123,.3)`.
  - **Row:** 46px tall, `padding 6px 8px`.
    - Checkbox: 18×18, bg `#3d4450`, radius 2; row hover → `#67707b`.
    - Capsule: header image max 98×45.
    - Name: 14px weight 500 white.
    - Sub-info: 16px icons `#8b929a` with usage text, e.g. "+ 1.2 GB DLC", "Workshop 230 MB".
    - Last played: 14px.
    - Size: 12px bold uppercase, hover `#add8e6`.
  - Row hover bg `rgba(61,68,80,.58)` (`.2s linear`).
- **Footer actions** (appear when rows are checked): **Uninstall** · **Move** (DialogButton, §10.1).

---

## 9. Library bottom bar (footer) [CSS + SS]

- **Bar:** height **50px**, bg `#171d25`, `padding 0 11px`, `display:flex; align-items:center`.
  - Bevel: `box-shadow: inset rgba(61,68,80,.65) 1px 1px 0 0, inset rgba(61,68,80,.45) -1px -1px 0 0`.
- **Left: "+ Add a Game"** (`AddGameButton`):
  - `padding 5px 10px 5px 5px`, gap 8px.
  - Icon: circled plus, 16×16, `#67707b`. Text: 12px weight 400 `#8b929a`. Both turn `#fff` on hover (`.1s ease-in-out`).
  - Click opens an **upward** desktop context menu: **Add a Non-Steam Game…** · **Activate a Product on Steam…** · **Browse the Steam Store for Games…**
- **Centre: download status** (`DownloadStatus`, `flex-grow:1`, centred, max-width 30vw, `gap 10px`, `padding 5px`, clickable → Downloads page). States:
  - *Idle:* 16px download icon `#67707b` + **"MANAGE DOWNLOADS"** (12px uppercase `#8b929a`). Hover: both white.
  - *Downloading:* a 26×26 game icon with a bevel overlay (white 2px top/left highlight, dark 2px bottom/right) and `box-shadow 2px 2px 4px rgba(0,0,0,.6)`. Next to it, a column (gap 2px):
    - Status line, 12px, colour **`#1a9fff`**: "Downloading 1 of 3" on the left, "45%" on the right.
    - Progress bar: **3px tall**, radius 10px, fg `#1a9fff`, bg `#000`.
    - Hover turns the text white.
  - *Queue complete:* "Downloads - 2 of 5 Items Complete" (12px `#8b929a`).
  - *Paused:* "Downloads Paused - 3 Items Queued".
  - *Offline:* "Offline Mode" / "No Connection".
- **Right: "Friends & Chat"** (`FriendsButton`):
  - `padding 5px 5px 5px 10px`. Text 12px `#8b929a`, then a 16px friends icon (two-person glyph in a rounded square) [SS]. Hover white.
  - Click opens the separate Friends List window.
  - Disabled (offline): `rgba(169,169,169,.5)`.
- A resize-grip glyph sits at the very bottom-right corner (dots, `#67707b`) [SS].

---

## 10. Dialogs, toasts, confirmations

### 10.1 Global dialog chrome and buttons [CSS library.css]

- **Popup dialog window:** frameless.
  - 1px focus line at the top `linear-gradient(to right, #00ccff, #3366ff)`. Destructive dialogs use a `#c44848` line. It is hidden when the window is not focused.
  - Title-bar buttons at the top right (24×18 each, X stroke `#788a92`; hover bg `#3d4450`, close hover `#e22a27`).
- **Dialog content:**
  - `padding 24px`, `font-family "Motiva Sans", Arial, Helvetica, sans-serif`.
  - Background `radial-gradient(circle at top left, rgba(74,81,92,.4) 0%, rgba(75,81,92,0) 60%), #25282e`.
- **In-window modal:**
  - Overlay `position:fixed; inset:0; z-index:1500` with a dark scrim `rgba(0,0,0,.6–.8)` [EST].
  - Content max 88vw × 90vh, centred. Close × at `right 4px; top 4px`.
- **Typography:**
  - Header (`DialogHeader`): **22px bold white, line-height 28px**, `margin-bottom 4px`.
  - Sub-header: 24px weight 300 uppercase, letter-spacing 2px (rare).
  - Body (`DialogBodyText`): 14–16px weight 300, `#acb2b8`, line-height 22px (desktop), `margin-bottom 32px`. Links `rgb(109,207,246)` → hover `rgb(176,233,255)`.
  - Field label (`DialogLabel`): 13px weight 300 UPPERCASE `#acb2b8`, `margin-bottom 4px`.
  - Divider (`DialogHBar`): 1px `linear-gradient(to right, #393e47, #40464f 20%, #393e47)`.
- **Footer** (desktop): `display:flex; justify-content:flex-end; gap:14px; padding-top 16px; margin-top:auto`. Buttons are auto-width, `padding 0 12px`, min ~100px.
- **DialogButton:**

| Variant | Rest | Hover | Active |
|---|---|---|---|
| Default | bg `#3d4450`, text `#dfe3e6` 14px, line-height 32px (height 32px), radius 2px | bg `#464d58`, white, plus a `0 8px 16px rgba(0,0,0,.3)` drop shadow fading in (`::before`, 200ms) | bg `#393f49`, `box-shadow 0 1px 4px rgba(0,0,0,.6)`, 0.04s |
| **Primary** (blue) | `linear-gradient(to right, #47bfff 0%, #1a44c2 60%)`, `background-size 330% 100%`, `background-position 25%` | `background-position 0%` (lighter), white | `background-position 40%` |
| GreenPlay | `linear-gradient(to right, rgb(138,195,41) 0%, rgb(74,122,22) 60%)`, same sweep | | |
| Disabled | bg `rgba(61,67,77,.35)`, text `rgb(70,77,88)`, no pointer events | | |

- Transition for all: `opacity, background, color, box-shadow .2s ease-out`. "Tall" variant height 44px; Small line-height 22px.
- **Checkbox** (`DialogCheckbox`):
  - 22×22, radius 2px, bg `rgba(0,0,0,.27)`, `box-shadow inset 1px .5px 3px rgba(1,1,1,.4)`.
  - Checked: a check SVG (18px, `#1a9fff`-to-white gradient stroke) drawn on via `stroke-dashoffset` (.18s).
  - Label 13–14px `#dcdedf`, 8–12px gap.
  - Disabled: opacity .5, `saturate(.35)`.

### 10.2 Install dialog [CSS + strings]

- **Modal:** min **500×400** (`InstallRequestModal`). Title "Install *Game Name*" (centred DialogHeader).
- **Apps-to-install list:**
  - `border-top 1px rgba(103,112,123,.3)`; each row `padding 8px 0`, line-height 40px, bottom border the same.
  - Each row: **header logo 88×40** (`margin-right 8px`), name 14px weight 400 `#b8bcbf` (ellipsis), size required right-aligned (min 68px), e.g. "7.02 GB".
- **Disk-space line:** "DISK SPACE REQUIRED: 7.02 GB · DISK SPACE AVAILABLE: 120 GB" in 12px **bold uppercase** [EST strings].
- **"INSTALL TO:"** header (`FolderSelector`, `padding 16px 0 8px`): 12px bold uppercase, letter-spacing .5px, line-height 22px. A gear (30×30) at the right opens the storage manager ("Manage Storage").
- **Install-location dropdown**, each option a row:
  - `padding 12px 16px`, radius 2px, `margin 4px 0`, 16px. Bg `#3d4450`, hover `#67707b`, **selected `#1a9fff` white**.
  - Shows a drive flag icon (★ default, ⚠ `#ffc82c` when low space), folder name `C:\Program Files (x86)\Steam` (ellipsis), and free space right-aligned (min 64px), e.g. "120.4 GB free".
  - Not enough space: name `#8b929a` and a yellow notice "⚠ NOT ENOUGH SPACE" (12px bold uppercase `#ffc82c`, right-aligned).
- **Shortcuts** (`CreateShortcuts`, row, gap 12px, `margin-top 12px`): ☑ **Create desktop shortcut** · ☑ **Create start menu shortcut** (13px `#dcdedf`).
- **Footer:** **Cancel** (default) · **Install** (Primary blue).
- **Afterwards:** an EULA step may appear (scrollable EULA, "Accept"). Then the dialog closes and the download is queued. A progress variant ("Installing *X*", 8px bar track `#3d4450` fill `#1a9fff` radius 10px, "1.2 GB of 7.0 GB") is used for backups and removable media.

### 10.3 Uninstall confirmation [CSS + EST copy]

- **Modal:** min-width 600px, destructive red focus line `#c44848`.
- **Content:**
  - Title: "Uninstall"
  - Body [EST wording]: "Are you sure you want to uninstall *Game* from *Drive*? Game files will be deleted from this device, however your save data stored in the Steam Cloud will remain."
  - Buttons: **Uninstall** (Primary) · **Cancel**.
- **During uninstall:** centred "Uninstalling *Game*" + throbber.
- **On error:** "Failed to uninstall *X* due to:" + reason, `margin-top 20px`.

### 10.4 Add a Non-Steam Game dialog [CSS]

- **Window:** min-width **600px**, flex column, ~600×560 [EST].
  - Header "Add Non-Steam Game", centred.
  - Body 14px/22px weight 400 `#b8bcbf`: "Select a program to add to your Steam Library".
  - Optional filter field "Search list…" above the table.
- **Table header:** `margin-top 8px; padding 10px 0`, bg `#3d4450`, `border 1px solid #0e141b`, no bottom border. Columns, 13px weight 500 UPPERCASE and sortable (arrow 14px; hover `#b8bcbf`):
  - checkbox 5%
  - icon 6%
  - **PROGRAM** 32%
  - **LOCATION** 62%
- **List:**
  - `flex:1; overflow-y: scroll`, bg `#23262e`, `border 1px solid #0e141b`, `box-shadow inset 0 4px 4px rgba(0,0,0,.25)`, radius 2px.
  - **Row:** `padding 2px 0`, hover bg `rgba(61,68,80,.5)`.
    - Checkbox with border `.5px solid #3d4450`, `padding 4px 8px`.
    - Icon 26×26.
    - Name 13px weight 500 `#dcdedf`.
    - Path 12px **italic**, `#dcdedf` at 50% opacity, nowrap.
  - Loading: centred throbber "Loading…".
- **Footer** (row, gap 10px, `padding-top 12px`): **Browse…** (left) · spacer · **Add Selected Programs** (Primary) · **Cancel**. Buttons min-width 100px, `padding 0 12px`.

### 10.5 Desktop toasts (bottom-right) [CSS]

- **Size:** **283 × 70**, stacked upward from the bottom-right of the screen (not the window).
- **Background:** `radial-gradient(155.42% 100% at 0% 0%, #23262e 0 0%, #0e141b 100%)`.
  - A faint large Steam logo in the background at opacity .05 (→ .1 tinted `#1a9fff` on hover).
  - On hover a blue glow `::before` fades in: `radial-gradient(155.42% 100% at 0 0, #1f2a39 0 0%, rgba(26,160,255,.33) 100%)`, opacity .5.
- **Layout** (`StandardTemplate`): `padding 10px; height 50px; display:flex; align-items:center`.
  - **44×44** icon or avatar (avatar has a 2px status-coloured edge: online `#4cb4ff`, in-game `#90ba3c` [EST]).
  - `margin-left 12px`, then:
    - Header row (14px high): 13px type icon + **title 11px weight 500 white**, then a timestamp 11px weight 500 `#3d4450`.
    - Description: 13–14px `#b8bcbf`, single line ellipsis (or 2-line clamp).
    - Sub-text `#67707b`.
  - Count pill: bg `#1a9fff`, radius 26px, `padding 0 8px`.
- **Animation:**
  - Slide/fade in from below: transform + opacity, `cubic-bezier(.17,.45,.14,.83)` 0.32–0.5s.
  - Auto-dismiss after ~5s [EST]. Click opens the related page.
  - Achievement and friend-in-game toasts use the same template.

### 10.6 Tooltips [EST]

- Bg `#3d4450` (or `#23262e`), 12–13px `#dcdedf`, `padding 6px 10px`, radius 2–3px, `box-shadow 0 0 12px #000`.
- Appear after ~400ms with no arrow.

---

## 11. Global design tokens

### 11.1 Official token names (Valve `shared_global.css` `:root`) [CSS]

```css
:root {
  /* System greys (client UI) */
  --gpSystemLightestGrey: #DCDEDF;  --gpSystemLighterGrey: #B8BCBF;
  --gpSystemLightGrey:    #8B929A;  --gpSystemGrey:        #67707B;
  --gpSystemDarkGrey:     #3D4450;  --gpSystemDarkerGrey:  #23262E;
  --gpSystemDarkestGrey:  #0E141B;
  /* Store blue-greys */
  --gpStoreLightestGrey: #CCD8E3; --gpStoreLighterGrey: #A7BACC; --gpStoreLightGrey: #7C8EA3;
  --gpStoreGrey: #4e697d; --gpStoreDarkGrey: #2A475E; --gpStoreDarkerGrey: #1B2838; --gpStoreDarkestGrey: #000F18;
  /* Gradients */
  --gpGradient-StoreBackground: linear-gradient(180deg, #2A475E 0%, #1B2838 80%);
  --gpGradient-LibraryBackground: radial-gradient(farthest-corner at 40px 40px, #3D4450 0%, #23262E 80%);
  /* Colours */
  --gpColor-Blue: #1A9FFF;  --gpColor-BlueHi: #00BBFF;
  --gpColor-Green: #5ba32b; --gpColor-GreenHi: #59BF40;
  --gpColor-Orange: #E35E1C; --gpColor-Red: #D94126; --gpColor-RedHi: #EE563B;
  --gpColor-DustyBlue: #417a9b; --gpColor-LightBlue: #B3DFFF; --gpColor-Yellow: #FFC82C; --gpColor-ChalkyBlue: #66C0F4;
  /* Translucent backgrounds */
  --gpBackground-DarkSofter: #0e141b33; --gpBackground-DarkSoft: #0e141b66;
  --gpBackground-DarkMedium: #0e141b99; --gpBackground-DarkHard: #0e141bcc;
  --gpBackground-Neutral-LightSofter: rgba(235,246,255,.10); --gpBackground-Neutral-LightSoft: rgba(235,246,255,.20);
  --gpBackground-Neutral-LightMedium: rgba(235,246,255,.30);
  /* Corners */
  --gpCorner-Small: 1px; --gpCorner-Medium: 2px; --gpCorner-Large: 3px;
  /* Spacing */
  --gpSpace-Gutter: 24px; --gpSpace-Gap: 12px;
  /* Shadows */
  --gpShadow-Small:  0 2px 2px 0 #0000003D;  --gpShadow-Medium: 0 3px 6px 0 #0000003D;
  --gpShadow-Large:  0 12px 16px 0 #0000003D; --gpShadow-XLarge: 0 24px 32px 0 #0000003D;
  /* Type */
  --gpText-HeadingLarge:  normal 700 26px/1.4 "Motiva Sans", Arial, sans-serif;
  --gpText-HeadingMedium: normal 700 22px/1.4 "Motiva Sans", Arial, sans-serif;
  --gpText-HeadingSmall:  normal 700 18px/1.4 "Motiva Sans", Arial, sans-serif;
  --gpText-BodyLarge:     normal 400 16px/1.4 "Motiva Sans", Arial, sans-serif;
  --gpText-BodyMedium:    normal 400 14px/1.4 "Motiva Sans", Arial, sans-serif;
  --gpText-BodySmall:     normal 400 12px/1.4 "Motiva Sans", Arial, sans-serif;
}
```

### 11.2 Client-specific surfaces (observed in client CSS) [CSS]

| Surface | Value |
|---|---|
| Top bar / URL strip / footer / left-header strip | `#171d25` |
| Chrome bevel (top/left light edge) | `inset rgba(61,68,80,.75) 1px 1px 1px 0` + `inset rgba(61,68,80,.25) -1px 0 1px 0` |
| Library left panel | `linear-gradient(to bottom, rgb(45,51,60) 0%, #24282f 30%)` |
| Library home | `linear-gradient(to bottom, #2d333c 0%, #23272d 20%, #171d25 60%)` |
| Game page base | `#24282f`; Glassy: `radial-gradient(100% 100% at 45% 35%, rgb(44,50,61) 0%, rgb(21,22,22) 100%)` |
| Collections page | `radial-gradient(100% 100% at 33% 45%, rgb(49,61,83) 0%, rgb(16,19,20) 100%)` |
| Downloads page | `radial-gradient(farthest-corner at 0 0, #3d4450 0%, #23262e 90%)` |
| Dialog / popup / notifications | `radial-gradient(circle at top left, rgba(74,81,92,.4) 0%, rgba(75,81,92,0) 60%), #25282e` |
| Context menu | `#3d4450` + `0 10px 32px rgba(0,0,0,.67)` |
| Toast | `radial-gradient(155.42% 100% at 0% 0%, #23262e 0 0%, #0e141b 100%)` |
| Splitter | `#17191b` (hover `#333741`) |
| Top inner shadow under chrome | 6px `linear-gradient(to bottom, rgba(0,0,0,.3), transparent)` |

### 11.3 Blues [CSS]

| Use | Value |
|---|---|
| Primary accent, selected tab, progress, toggle on | `#1a9fff` |
| Hover highlight end | `#00bbff` |
| Primary button gradient | `#47bfff → #1a44c2` (to right, 60%) |
| Context/blue action gradient | `-45deg, #0056d6 8% → #1a9fff 90%`; hover `#1a9fff → #00bbff` |
| Downloads pause button | `314deg, #0056d6 → #1a9fff` |
| Inline progress fill (play bar) | `#2d73ff` |
| Library list "updating" text | `#26b7ff` / `#74d1ff` |
| Filter active / chips | `#09b9ff` / `#1e90ff` |
| Online persona | `#4cb4ff`; links `#6dcff6` / `rgb(109,207,246)` |
| Store classic tab hover | `135deg, #67c1f5 → #417a9b` |
| Focus line on dialogs | `#00ccff → #3366ff` |

### 11.4 Greens [CSS]

| Use | Value |
|---|---|
| PLAY button | `linear-gradient(to right, #70d61d 0%, #01a75b 60%)`, size 330%, pos 25% → 0% hover |
| Capsule play button | `radial-gradient(circle, rgb(112,214,29) 0%, rgb(1,167,91) 100%)` |
| Context-menu PLAY | `-45deg, #236c39 0% → #59bf40 70%`; hover `#59bf40 → #5be33a` |
| Running game name | `#adff2f`; running progress `#81c221` |
| Notification "has new" / VR running | `#5c7e10` (hover `#7ea64b`) |
| Disk-usage line, completed check | `#59bf40` |
| In-game persona | `#c2ffb3` on `rgba(92,126,16,.5)` |

### 11.5 Text greys [CSS]

`#ffffff` (titles), `#f1f7ff` (installed game), `#dcdedf` (primary), `#dfe3e6` (button text), `#b8bcbf` (secondary), `#acb2b8` (dialog body), `#a3aab9` (uninstalled game), `#8b929a` (labels), `#67707b` (disabled/icons). Translucent whites: `rgba(255,255,255,.52)` labels, `.32` values, `.4` dates, `.8` body.

### 11.6 Status and alert colours [CSS]

Error `#de3618` · alert `#9a3130` (hover `#d75a5a`) · warning `#ffc82c` · ack `#bb9d2f` · transport error `#c91613` · close-hover `#e22a27` · music playing `#ad66bb`.

### 11.7 Borders and separators [CSS]

- Field separator: `rgba(255,255,255,.1)` (1px).
- Section rules: `rgba(103,112,123,.3)` 2px, or `rgba(255,255,255,.05)` 2px (library shelves).
- Context separator: `#67707b` hairline.
- Table and list borders: `#0e141b`.
- Dialog list borders: `rgba(103,112,123,.3)`.
- Hairline under the app-details area: `.5px rgba(38,45,56,.42)`.

### 11.8 Scrollbars [CSS]

```css
.lib *::-webkit-scrollbar        { width: 12px; }
.lib *::-webkit-scrollbar-thumb  { border: 3px solid transparent; background-clip: padding-box; background-color: #606774; }
.lib *::-webkit-scrollbar-thumb:hover  { background-color: #7b8392; }
.lib *::-webkit-scrollbar-thumb:active { background-color: #7b8392; border-width: 2px; }
.lib *::-webkit-scrollbar-track, .lib *::-webkit-scrollbar-button { display: none; }
.lib *::-webkit-scrollbar-corner { background: #434953; }
/* left list: thumb invisible until panel hover */
.leftList:not(:hover) ::-webkit-scrollbar-thumb { background-color: transparent; }
```

- Storage list thumb: `#3d4450` / hover `#464d58`.
- Library home scrollbar track: `rgba(32,34,36,.2)`.

### 11.9 Typography

- **Family:** `"Motiva Sans", "Twemoji", "Noto Sans", Helvetica, sans-serif` (client body). Dialogs use `"Motiva Sans", Arial, Helvetica, sans-serif`.
  - Weights used: 100/200 (thin: shelf titles, dates), 300 (light: PLAY label, dialog body), 400, 500 (medium: nav tabs, names), 700 (bold: headers, stats).
  - Motiva Sans is a **commercial typeface licensed by Valve**. Valve serves it from `store.akamai.steamstatic.com/public/shared/fonts/MotivaSans-*.ttf`, but bundling it in your app needs your own licence. Use fallbacks: **"Inter" or "Figtree"** (closest open metrics) → `"Noto Sans", Arial, sans-serif` [EST].
- **Scale in use:**

| Size | Uses |
|---|---|
| 10px | Bold uppercase graph labels, banners |
| 11px | URL, toast title |
| 12px | Menu row, footer, section names, stats labels (downloads), dates |
| 13px | Game list, sub-nav links, context menu, descriptions |
| 14px | Settings labels, play-bar stat labels, section headers |
| 15–16px | Shelf titles, dialog body, What's New titles |
| 18px | Super nav, download row names |
| 20px | PLAY label, section titles (downloads) |
| 22px | Dialog headers, download status |
| 28px | Active download name |

- **Casing and tracking:**
  - UPPERCASE everywhere for section headers (letter-spacing 1–2px), stat labels, nav tabs, button labels.
  - Sentence case for menus, dialog text and game names.
  - Numbers in counters use `font-variant-numeric: tabular-nums`.

### 11.10 Radii

- 2px: buttons, pills, rows, play button.
- 3px: inputs, dropdown, list hover, filter tags.
- 4px: icon buttons in the play bar, search box, capsule action states.
- 10px: progress tracks, drive bar.
- 9001px: toggles.
- 50%: avatars in notifications (round); friend avatars in lists are square.

### 11.11 Shadows

- Menus: `0 10px 32px rgba(0,0,0,.67)`.
- Capsules: `0 4px 8px rgba(0,0,0,.5)`; on hover `0 14px 12px rgba(0,0,0,.3)`.
- Sticky play bar: `0 6px 16px rgba(0,0,0,.27), 0 2px 6px rgba(0,0,0,.53)`.
- Button hover lift: `0 8px 16px rgba(0,0,0,.3)`.
- Advanced-filter flyout: `0 2px 8px 1px #000`.
- Selected list row: `0 0 2px rgba(0,0,0,.33), 0 0 16px rgba(0,0,0,.27)`.

### 11.12 Motion

| What | Timing |
|---|---|
| Chrome hover colours | `.15s ease-out` |
| Buttons / DialogButton | `.2s ease-out`; press `.04s` |
| Library bars, search, flyouts | `.16–.21s ease-in-out` |
| Capsule lift / shine / glow | `.6s cubic-bezier(0,.73,.48,1)`; glow opacity `.4s ease-in-out`; press `.05s` |
| Capsule image load-in | `.4s cubic-bezier(0,.7,.8,1)` (blur 18px → 0) |
| Toggle | rail `.2s ease-out`; knob `.2s cubic-bezier(.1,.12,.53,1.72)` |
| Sticky play bar swap | `.16s ease-out` |
| Hero fullscreen / app launch | `800ms cubic-bezier(0,0,.1,1)` |
| Toast | `.32–.5s cubic-bezier(.17,.45,.14,.83)` |
| Progress widths | `.1–.2s linear` (footer/list), `.8s ease-in-out` (capsule bar) |
| Throbbers | fade in after a 2s delay (`opacity 0 → 1`, 2s ease-in) |

- **Responsive breakpoints** (client constants):
  - Window: BreakNarrow 1158px, BreakWide 1774px, BreakUltraWide 2100px, BreakShort 600px, BreakTall 1200px.
  - Right panel: UltraNarrow 600px, Narrow 884px, Wide 1500px, UltraWide 1826px.
  - Narrow right panel shrinks the play bar to 32px, the button min-width to 114px and the PLAY label to 16px, and hides stats.

---

## 12. Implementation notes for React

- Build a token file from §11, as CSS variables, and keep components on CSS Modules or vanilla-extract, as Valve does (CSS modules + SCSS).
- **Virtualize** the left list (react-window, `itemSize = 24` for game rows; headers about 22–24px) and the All Games grid.
- Capsule hover needs `perspective` on the wrapper and `transform-style: preserve-3d` on the card. Without it the `rotateX(3deg) translateZ(15px)` lift looks flat.
- For the play-bar "sweep" gradient, keep `background-size: 330% 100%` and only animate `background-position`.
- Use Electron `-webkit-app-region` for the frameless chrome. Mark every interactive child `no-drag`.
- Image assets per app (Steam CDN naming):
  - `library_600x900.jpg` (portrait capsule)
  - `library_hero.jpg` (3840×1240)
  - `logo.png`
  - `header.jpg` (460×215: downloads rows, landscape cards)
  - 32×32 icon (list)

---

## Sources

- SteamDatabase/SteamTracking: extracted client UI (`ClientExtracted/steamui/css/sp.css`, `css/library.css`, `sp.js` class maps, `localization/steamui_english.json`, `shared_english.json`): https://github.com/SteamDatabase/SteamTracking/tree/master/ClientExtracted/steamui
- Valve shared web tokens: https://community.cloudflare.steamstatic.com/public/shared/css/shared_global.css
- Valve store CSS (classic store nav): https://store.fastly.steamstatic.com/public/css/v6/store.css
- Motiva Sans font-face declarations: https://store.fastly.steamstatic.com/public/shared/css/motiva_sans.css
- Steam client update news feed: https://store.steampowered.com/oldnews/?feed=steam_client
- Release coverage of the June 2023 client update:
  - https://dataconomy.com/2023/06/15/new-steam-ui-update-what-you-need/ (screenshots: library game page, notifications flyout)
  - https://gamerant.com/steam-user-interface-changes-update-june-14-patch-notes/
  - https://www.phoronix.com/news/Steam-Client-Major-Update
  - https://www.pcgamesn.com/steam/update-summer
- Wikipedia, Steam (service): Nov-2025 client/store screenshot showing the new store nav: https://en.wikipedia.org/wiki/Steam_(service)
- Millennium (Steam theming framework) docs, for class/theming context: https://docs.steambrew.app/themes/basics/config and https://github.com/SteamClientHomebrew/Millennium
