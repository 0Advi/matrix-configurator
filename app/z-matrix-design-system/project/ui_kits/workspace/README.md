# Z-Matrix · `workspace` UI kit

The Electron desktop workspace — the agentic surface that sits **on top of** the new-store-folder web app. This is where supervisors and admins live at 9pm: NL queries, dashboards, shortlist approvals streamed from `bd-mcp`, and Skills (PPTX / XLSX reports). Dark-mode "Deep Obsidian" is the default.

It does **not** mirror the new-store-folder. Instead it pulls a scoped, RBAC-respecting view of the same data via the `bd-mcp` server and lets you ask questions of it in natural language.

Open `index.html`. You'll see:

1. **Command bar** — natural-language input across the top. Type and hit Enter (or click a suggested prompt) and the agent stages a reply: text + a generated table card.
2. **Hero metric tiles** — the four KPIs supervisors check first; mono numerics with copper rule + sparkline.
3. **Shortlist approvals** — sites awaiting supervisor approval, with score, owner, and "details added" status; one-click approve / reject.
4. **Trace panel** (right) — live agent reasoning + MCP tool calls, in the spirit of the existing Matrix renderer's `TracePanel.tsx`.

## Components

- `Titlebar.jsx` — drag region, traffic lights, tenant indicator
- `Sidebar.jsx` — module nav, dark
- `CommandBar.jsx` — NL input + suggestion chips
- `HeroTiles.jsx` — 4-up metric grid with sparklines
- `Approvals.jsx` + `ApprovalCard.jsx` — shortlist approval queue
- `TracePanel.jsx` — agent activity stream
- `AskMatrixReply.jsx` — formatted agent response tile

## Out of scope

Payments / CA codes / KYC. Those live in a separate Payments module — the desktop workspace can _read_ a stream of payment events for context but does not own them.
