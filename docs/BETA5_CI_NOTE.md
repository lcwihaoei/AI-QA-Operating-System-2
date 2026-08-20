# beta.5 CI stability note

The integration-branch verification exposed a Chromium startup variance: the BrowserExplorer real-browser regression can exceed Vitest's default 5-second timeout on a cold hosted runner even though the same test passed on the hardening PR. The release gate therefore gives this browser integration test an explicit bounded timeout rather than relying on the unit-test default.
