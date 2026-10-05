---
name: zmatrix-design
description: Use this skill to generate well-branded interfaces and assets for Z-Matrix — Blue Tokai's internal automation + new-store-opening platform — either for production code or throwaway prototypes / mocks / decks. Contains the full design system: colors (light "Digital Quartz" + dark "Deep Obsidian"), Plus Jakarta Sans / Inter / JetBrains Mono type, the "Dimension Shift" logo, Lucide iconography, motion guidelines, and React UI kits for the BD new-store folder and the Electron workspace.
user-invocable: true
---

# zmatrix-design skill

Read `README.md` first for the full design system, then explore the other files in this folder:

- `colors_and_type.css` — all CSS variables (color tokens for both themes, type scale, spacing, radii, shadows, motion). Import this in every artifact.
- `assets/` — `zmatrix-mark.svg` (+ `-dark`), `zmatrix-wordmark.svg` (+ `-dark`), `zmatrix-favicon.svg`, `blueprint-grid.svg`. Copy out by path, do not redraw.
- `fonts/` — note on Google Fonts CDN (Plus Jakarta Sans, Inter, JetBrains Mono).
- `preview/` — small standalone HTML cards documenting each token group (colors, type, spacing, radii, shadows, motion, components, brand). Useful as a visual reference and as starter snippets.
- `ui_kits/new-store-folder/` — React + Babel UI kit for the BD web module (light, structured, breathing-room). Includes Sidebar, TopBar, MetricStrip, SitesTable, SiteDrawer with tabs, ShortlistQueue, NewPipelineModal.
- `ui_kits/workspace/` — React + Babel UI kit for the Electron desktop "command center" (dark). Includes Titlebar, dark Sidebar, CommandBar (NL query) with Ask-Matrix reply card, HeroTiles with sparklines, Approvals queue, TracePanel.

## When the user invokes this skill

If they give no other guidance, ask them what they want to build or design (a slide, a screen, a flow, a production component), then ask a few sharpening questions, then act as an expert designer who outputs **HTML artifacts** for mocks/decks/prototypes _or_ **production code** that imports from the existing Z-Matrix tokens.

If creating visual artifacts: **copy** `colors_and_type.css` and any logo / icon assets into the working folder; do not link out. Re-use the React primitives from the UI kits where possible — they already follow the system.

## Non-negotiables

- **JetBrains Mono for every number** in a data context (metrics, IDs, table cells, currency, dates, percentages). Tabular numerals (`font-feature-settings: 'tnum' 1`).
- **No emoji** in UI chrome. Lucide icons only, 1.5px stroke, `currentColor`.
- **The blueprint grid** (4% alpha, 40px cell) on dashboard backgrounds — not on cards.
- **No bouncy / springy** motion. Default easing is `cubic-bezier(0.2, 0.7, 0.2, 1)`; default duration 200ms.
- **Copy is direct, numerate, low-affect.** State the fact, then the action.
- **Light = Digital Quartz** for web modules. **Dark = Deep Obsidian** for the desktop workspace.

## Source repos for deeper context

- `Adityashandilya555/Matrix` — Electron renderer this design system extends (already uses Plus Jakarta Sans + JetBrains Mono).
- `Adityashandilya555/designer-skills` — companion design-ops repo.
- See `website/blue-tokai/architecture.md` in the Matrix repo for the BD / Payments state machine, RBAC matrix, and module roadmap.
