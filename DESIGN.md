# VoiceCraft — Design System
> a quiet studio instrument with one Fern-green signal light, built on shadcn/ui

**Theme:** dark only (`<html class="dark">`; semantic tokens live on `:root`)

VoiceCraft is a near-black (#08090a) desktop studio with paper-white type and one soft **Fern green** (#86d38f) used as a functional flashlight — the primary action, the active nav item, the thing currently playing, and "ready". Fern is calm rather than neon: it reads as a studio meter's "signal present" light, and it is the only chromatic colour that means "act here" or "all good".

The *structure* is a desktop app shell: a left sidebar, pages with a fixed toolbar, and a status bar at the bottom of the window. **There are no card boxes.** Sections are separated by whitespace and hairline borders; lists are divider rows; forms that don't belong to the page open in a Sheet. Components come from **shadcn/ui** (new-york, Tailwind v4, Radix, lucide icons), re-themed onto the tokens below.

## Stack

- React 19, Vite, Tailwind CSS v4 (`@theme` in `app/src/index.css`)
- shadcn/ui components in `app/src/components/ui/` (config: `app/components.json`, alias `@/` → `app/src/`)
- `lucide-react` for icons; `sonner` for toasts; `cmdk`/`radix-ui` underneath
- Tauri shell; the backend is FastAPI on `127.0.0.1:17610`

## Tokens — Colors

Raw palette (unchanged). Defined in `@theme` as `--color-ink-*` etc., still used by the custom timeline editor.

| Name | Value | Token | Role |
|------|-------|-------|------|
| Void | `#08090a` | `ink-950` | Page canvas |
| Carbon | `#0f1011` | `ink-900` | Elevated bars (top bar, dock, toolbar) |
| Obsidian | `#161718` | `ink-800` | Muted / secondary fills |
| Graphite | `#23252a` | `ink-700` | Hairline borders, dividers |
| Smoke | `#383b3f` | `ink-600` | Higher-contrast hairlines |
| Fog | `#8a8f98` | `ink-400` | Muted text, placeholders, icons |
| Mist | `#d0d6e0` | `ink-200` | Body text |
| Bone | `#e5e5e6` | `ink-100` | Near-white fills |
| Paper | `#ffffff` | — | Headings, max-contrast emphasis |
| Fern | `#86d38f` | `primary` | The one action colour |
| Fern (success) | `#86d38f` | `pulse-green` | Success / "ready" / "in use" — deliberately the same as `primary` |
| Coral Red | `#eb5757` | `coral-red` / `destructive` | Errors, destructive actions |
| Warning | `#e2b93b` | `warning` | Caution text and notices |
| Signal Teal | `#02b8cc` | `signal-teal` | Intro / outro accents in the editor |
| Iris Violet / Lavender | `#6366f1` / `#8b5cf6` | — | Reserved for tags |

### shadcn semantic tokens

Components consume these, never the raw palette. **Note: `accent` is shadcn's neutral hover surface, not Fern — Fern is `primary`.**

| Token | Value | Use |
|-------|-------|-----|
| `background` | `#08090a` | Canvas |
| `foreground` | `#d0d6e0` | Body text |
| `card` / `card-foreground` | `#0f1011` / `#e5e5e6` | Top bar, player dock, editor toolbar, media bin |
| `popover` | `#131415` | Menus, selects, tooltips, dialogs |
| `primary` / `primary-foreground` | `#86d38f` / `#08090a` | Primary button, active nav, focus ring, current track |
| `secondary`, `muted` | `#161718` | Quiet fills |
| `muted-foreground` | `#8a8f98` | Secondary text |
| `accent` / `accent-foreground` | `#1a1b1e` / `#ffffff` | Hover / selected row surface |
| `destructive` | `#eb5757` | Destructive |
| `border` | `#23252a` | Every hairline |
| `input` | `#2f3237` | Control borders |
| `ring` | `#86d38f` | Focus ring |
| `sidebar*` | `#0b0c0d` bg, `#a9aeb7` text, `#17181a` hover | Sidebar surfaces |

## Tokens — Typography

**Inter Variable** for everything (fallback: system-ui), `font-feature-settings: "cv01" on, "ss03" on, "zero" on`, base **14px**, tracking `-0.011em` (headings `-0.022em`). Monospace (Berkeley Mono → JetBrains Mono → ui-monospace) is for timecodes, paths and IDs only.

| Role | Size / weight |
|------|---------------|
| Page title (`PageHeader`) | 20px / 600 |
| Section title (`Section`) | 14px / 500 |
| Body, controls | 14px / 400 |
| Script textarea | 15px / 400, relaxed leading |
| Secondary / metadata | 12–13px / 400, `muted-foreground` |
| Micro labels | 10–11px, uppercase, wide tracking |

Weights stay in the 400–600 band; nothing is bold (700+).

## Tokens — Spacing & Shapes

Base unit 4px. `--radius: 0.5rem` → `sm 4px`, `md 6px` (controls), `lg 8px`, `xl 12px` (dialogs, sheets). Pills (`9999px`) are for play buttons and status chips only.

Elevation is **hairlines, not shadows**: surfaces step up `background → card → popover`, and edges are `1px border`. Overlays (dialog, sheet, popover) use the shadcn default shadow; nothing in the page body does.

## App shell

```
┌────────────┬──────────────────────────────────────────────┐
│ VoiceCraft ▣│ Page  one-line hint     [actions] │ ─  ▢  ✕ │  ← top row = title bar (h-11)
├────────────┼──────────────────────────────────────────────┤
│ CREATE     │                                              │
│  Generate  │   page content, full width, scrolls          │
│  Profiles  │   (Generate: form │ results panes;           │
│ AUDIO      │    Settings: categories │ one category;      │
│  Library   │    Editor: tool strip + flush panels)        │
│  Editor    │                                              │
│ SYSTEM     ├──────────────────────────────────────────────┤
│  Models    │ ▶ now playing   0:12 ━━━●━━━━  0:42       ✕  │  ← player dock (in flow)
│  Settings  ├──────────────────────────────────────────────┤
│  Setup     │ ● 2 setup issues       RAM ▬▬  CPU ▬▬  GPU ▬▬ │  ← status bar (h-6)
└────────────┴──────────────────────────────────────────────┘
```

- **Title bar.** On Windows the window is undecorated (`src-tauri/tauri.windows.conf.json`) and the app's top row *is* the title bar: the sidebar header and the page bar are drag regions (`data-tauri-drag-region`; text inside is `pointer-events-none` so it drags too), and `WindowControls` draws the minimise / maximise / close buttons with the system Segoe caption glyphs. macOS and Linux keep native chrome (`customTitleBar()` in `lib/tauri.ts`). Screens outside the shell (start-up, engine setup) use `BareTitleBar`.
- **Sidebar** (`AppSidebar`, shadcn `Sidebar`, 14rem, collapses to an icon rail with the header button or `Ctrl+B`): three nav groups; "Engine setup" (Tauri only) is the last item of System. Its header is the same height as the top row so the hairlines line up.
- **Page bar** (`PageHeader`): title, one-line hint, optional inline controls and actions. It is portalled into the top row (`PageBarSlot`), so pages never draw their own header strip and content scrolls below it.
- **Status bar** (`StatusBar`): backend / engine state on the left (`EngineStatus`, engine ids shown by display name; several problems collapse into "N setup issues"), live RAM / CPU / GPU readouts on the right (`SystemResources`, polled every 3 s from `GET /api/settings/resources`). Each side is a button that opens a details popover above it: every issue with what it means and a fix action (Open Models / Run engine setup) plus each engine's state; or memory, CPU and GPU in full.
- **Player dock** (`PlayerDock`): one shared `<audio>` element above the status bar. Appears only while a track is loaded.
- **Full-bleed views** (`FULL_BLEED` in `App.tsx`) lay out their own panes: Generate (form pane beside results, stacked below `lg`), Settings (category list beside the selected category, remembered; the category content keeps `max-w-3xl`), Editor (one fixed-height tool strip, then media bin / timeline / inspector flush, separated by hairlines — no floating cards). Other pages scroll as one full-width column.
- **Desktop behaviour** (`use-desktop-behavior.ts`): `Ctrl/⌘ 1…6` switches view in sidebar order and `Ctrl/⌘ ,` opens Settings. In the packaged app only, the browser context menu, reload, page zoom and view-source keys are disabled. Buttons use the arrow cursor (only real links get the hand).

## Page patterns

- **`PageHeader`** — the page bar in the window's top row: title, one-line hint, actions on the right. No box.
- **`Section`** — title + description + actions, then content. Separated from the next section by whitespace or a `Separator`, never a border box.
- **Lists** — `divide-y border-y` rows (`TrackRow`, model rows, directory rows). Row hover is `bg-accent/40`. Expandable detail uses `Collapsible`.
- **Settings** — `SettingRow` (label + help left, control right) in a divided list.
- **Create/edit forms** that aren't the page's main job open in a `Sheet` (e.g. New profile). The main task of a page (e.g. the Generate script) is inline.
- **Empty states** — quiet centred text (`Empty`), no dashed boxes.
- **Confirmations** — `useConfirm()` (shadcn `AlertDialog`); never `window.confirm` / `window.prompt`.
- **Feedback** — `useToast()` (sonner) for results, `Notice` (shadcn `Alert`) for inline advisories.

## Components

shadcn primitives in use: `alert`, `alert-dialog`, `badge`, `button`, `checkbox`, `collapsible`, `command`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`, `progress`, `scroll-area`, `select`, `separator`, `sheet`, `sidebar`, `skeleton`, `slider`, `sonner`, `switch`, `table`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip`.

Thin app-level compositions live in `app/src/components/common.tsx` — use these rather than re-styling primitives:

| Component | What it is |
|-----------|------------|
| `PageHeader`, `Section`, `SettingRow` | Layout blocks above |
| `Field` | `Label` + control + hint |
| `OptionSelect` | shadcn `Select` driven by an `options` array (replaces native `<select>`) |
| `Segmented` | `ToggleGroup` (single, can't be emptied) |
| `IconButton` | Ghost icon `Button` with a `Tooltip` (`icon-sm`, or `icon-xs` in dense toolbars) |
| `Badge` | Quiet chip; tone (`good`/`warn`/`bad`/`busy`) is carried by text colour only |
| `StatusDot`, `Notice`, `Empty` | Status dot, inline alert, empty state |

Other shared pieces: `TrackRow` (play · title/meta · actions), `Dialog` (shadcn dialog behind the old editor-dialog API), `Confirm`, `Toaster`, `SystemResources`, `EngineStatus`, `icons.tsx` (lucide, 16px default).

### Buttons
- **Primary** (`variant="default"`): Fern fill, `#08090a` text. **One per view** — Generate, New profile, Export, Save.
- **Outline**: secondary actions. **Ghost**: toolbar text actions and row actions. **Destructive actions** are outline with `text-coral-red`, or `destructive` inside a confirm.
- Radius 6px; play buttons are circular (`rounded-full`) and turn Fern when they are the current track.

### Inputs
shadcn `Input`/`Textarea`/`Select`: transparent fill, `input` border, Fern focus ring. Sliders are Fern on a `muted` track.

## Do's and Don'ts

### Do
- Keep surfaces flat: separate with whitespace and `border` hairlines.
- Use Fern only for the primary action, the active nav item, focus, the currently playing track, and success / "ready" states.
- Use semantic tokens (`bg-card`, `text-muted-foreground`, `border`) in new UI; raw `ink-*` is for the timeline internals.
- Use `PageHeader` + `Section` for every new page, and add it to `NAV_GROUPS` in `AppSidebar.tsx`.
- Reach for an existing shadcn component (`npx shadcn@latest add <name>` from `app/`) before writing a custom control.
- Run confirmations through `useConfirm()` and results through `useToast()`.

### Don't
- Don't wrap page content in bordered/rounded "card" boxes or put a card inside a card.
- Don't add a second chromatic accent as an action colour, and don't introduce a second green for success.
- Don't use bold (700+) weights or decorative gradients.
- Don't use shadows to separate page content from the canvas.
- Don't use native `<select>`, `window.confirm` or `window.prompt`.
- Don't use `accent` expecting Fern — in this system `accent` is the neutral hover surface; Fern is `primary`.

## Quick Start

`app/src/index.css` (abridged):

```css
@import "tailwindcss";
@import "tw-animate-css";
@custom-variant dark (&:is(.dark *));

@theme {
  /* raw palette: --color-ink-950 … --color-ink-100, --color-pulse-green,
     --color-coral-red, --color-signal-teal, --color-warning, fonts */
}

:root {
  --radius: 0.5rem;
  --background: #08090a;   --foreground: #d0d6e0;
  --card: #0f1011;         --popover: #131415;
  --primary: #86d38f;      --primary-foreground: #08090a;
  --secondary: #161718;    --muted: #161718;  --muted-foreground: #8a8f98;
  --accent: #1a1b1e;       --accent-foreground: #ffffff;
  --destructive: #eb5757;
  --border: #23252a;       --input: #2f3237;  --ring: #86d38f;
  --sidebar: #0b0c0d;      --sidebar-foreground: #a9aeb7;
  --sidebar-accent: #17181a;  --sidebar-border: #1b1c1f;
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-primary: var(--primary);
  /* …every semantic token mapped to --color-* */
}
```
