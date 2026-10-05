# Z-Matrix · `new-store-folder` UI kit

The internal automation app for Blue Tokai's store-opening workflow. Three sequential stages, plus an overview:

| View | Who | What |
|---|---|---|
| **Sites in motion** (overview) | All | Single dashboard pulling drafts + shortlist + staging together; metric strip + filter chips. |
| **Pipeline** | BD execs create, supervisors decide | Drafts only. Each row = a pipeline draft with the creator's avatar, city, visit month, days waiting. Filters across all four. Supervisor sees **Yes / No / View**; BD exec sees **View**. |
| **Shortlist queue** | Both | Cards for shortlisted sites. Buttons: **View** (eye), **Add details** (20-field site form), **Approve shortlist** (supervisor only — disabled until details added). Approve opens a modal asking the expected LOI timeline in days. |
| **Staging** | Both | Sites approved out of shortlist, awaiting LOI upload. Filters by city / month / status. **Sites past their expected LOI date are highlighted** with a copper rail + tinted row + LOI-OVERDUE pill. **Upload LOI** button per site. |

Open `index.html`. Use the **View as** segmented control in the bottom-left of the sidebar to toggle between Supervisor and BD exec.

## Components

- `Primitives.jsx` — `Icon`, `STAGES`, `StageDot`, `StatusPill`, `Avatar`
- `Chrome.jsx` — `TopBar` (with user / role badge), `Sidebar` (with role switcher)
- `Pipeline.jsx` — `MetricStrip`, `PipelineFilter`, `MetricCard` (used by Sites in motion)
- `Drafts.jsx` — `DraftsView`, `DraftRow`, `DraftsFilterBar` (Pipeline page)
- `Shortlist.jsx` — `ShortlistQueue`, `ShortlistCard`, `LOITimelineModal`, `NewPipelineModal`
- `Staging.jsx` — `StagingView`, `StagingRow`, `StagingFilterBar`
- `SiteDrawer.jsx` — slide-over with Overview / Activity / Documents / Payments tabs
- `App.jsx` — orchestration, mock data, role + view state, toast notifications

## Out of scope

Payments / CA codes / KYC. Those live in a separate Payments module.
