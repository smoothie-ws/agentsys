# RC verification evidence

These logs record local executions collected during the audit, including the initial baseline and final targeted reruns.
They do not substitute for GitHub Actions. `ci-results.json` records the exact published implementation commit and remote jobs.

- `baseline-node.log`: original 443-test baseline.
- `node-regression.log`: final 460-test local regression, 459 passes and the original Windows POSIX-permissions skip.
- `node-serial.log`: all test files executed sequentially, with original latency and soak assertions intact.
- `chromium-suite.log`: all nine selected browser scenarios passed.
- `firefox-plugin-suite.log`, `webkit-plugin-suite.log`: platform, certification and security scenarios.
- `*-certification.log`: final expanded standalone-product fixture, two servers, bearer secret, lifecycle metrics and headless execution.
- `*-ux.log`: interface/browser compatibility checks.
- `storage.log`, `deployment.log`, `security.log`, `packaging.log`: targeted checks after the relevant fixes.

Local toolchain: Windows, Node 20.17.0, Python 3.12.6, Playwright 1.57.0.
The paths and temporary port numbers in logs belong to synthetic isolated test servers. Cancelled SSE/API requests during
switching, disable and reload are expected; the fixture separately asserts that no uncaught page errors remain.

Log line endings are normalized to LF; test results and measurements are preserved.
