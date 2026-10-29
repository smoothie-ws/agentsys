# Interface follow-up — 29 October 2026

Follow-up to the [full audit](full-audit-2026-10-29.md). The audit records the earlier baseline; this page records the subsequent interface changes.

- Dashboard and Runs subscribe to backend changes and use a three-second fallback poll. Hidden pages skip polling; leaving a page releases its subscriptions. Connection errors are visible and retry automatically.
- Runs filters by workflow, status and time before pagination. Filters are reflected in the URL, and cursor pagination reaches the retained history beyond the first 50 rows. Metrics cover all retained summaries, not only the current page.
- Live updates replace the relevant list/status regions, preserving policy fields and Dashboard plugin frames. Policy and limit forms autosave; failed saves block navigation until the user resolves or discards them.
- Empty workspaces offer a small runnable starter workflow. Dashboard states whether execution uses the server or browser workspace.
- Workflow permission controls explicitly identify their project-wide scope. Intervention explains that resuming a wait restarts the script and can repeat external effects.
- Canvas run callbacks check that their canvas is still mounted before updating it. Empty version history has a dedicated message.

Validation: 306 Node tests and 16 browser scenarios passed using disposable data. Additional focused checks cover the final Runs, layout and navigation-guard changes. Layouts were checked at 320/390 px and desktop widths.

The 100-project performance probe reduced initial Runs API requests from 203 to 2; Dashboard uses 3. A run completed outside the page appeared automatically. Timing measurements are diagnostic, not performance guarantees; graph rendering has not been optimized in this follow-up.

Runs remains available, including workflow controls, versions and limits. Trace details are loaded on selection rather than streamed. A broader templates gallery, richer workflow settings, authentication UI and storage scaling remain separate audit follow-ups.
