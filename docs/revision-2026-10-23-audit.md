# Code and UI audit, 2026-10-23

Checked JavaScript declaration references across the application, CSS class and custom-property references, UI lifecycle code, and the existing server and browser regression suites. Dynamically generated classes and document migrations are retained.

## Fixes

- Connected navigation uses a fixed-size field anchored to the receiving edge. Panel width no longer scales the glow. CSS positions it directly, removing JavaScript width measurements and the copied seam width. Concave joins still sample the same field.
- Panel separators support End to expand and arrow keys to reopen a collapsed panel.
- Search invalidates pending responses as soon as input changes, clears stale links, and skips deferred searches after the dialog closes.
- Searchable submenus handle Up/Down and Left within their own list. Disabled groups cannot open on hover. Sibling cleanup is shared.
- Dialog submission supports requestSubmit without a submitter. Autosave clears the error colour on retry.
- Leaving an editor cancels its scheduled reload. An in-flight reload ignores a detached or replaced canvas.

## Cleanup

Removed unused numberField, remove-literal styles, raised/radius-lg tokens, imperceptible gradient stops, and the duplicate ResizeObserver. Browser smoke checks now produce a failing exit status on failed assertions.

## Validation

- 61 Node tests passed.
- Browser smoke, navigation and targeted UI regressions passed in Chromium.
- All application JavaScript files passed node --check.
- Receiving-field pixels were compared at panel widths 180, 300 and 420 px, with a one-channel-level tolerance for browser rasterization.

Browser checks use a static server and isolated browser storage; existing user data is not modified.
