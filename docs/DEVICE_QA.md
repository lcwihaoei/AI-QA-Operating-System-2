# Device QA

M5 is the provider-neutral mobile-device layer. It now contains both a non-interactive Appium smoke mode and the first **bounded risk-aware exploration** mode.

## Architecture

```text
QA Manager
  ↓
Device Agent
  ↓
DeviceProvider interface
  ↓
W3C Appium HTTP
  ↓
Android UiAutomator2 / iOS XCUITest
  ↓
page source → candidate parser → app boundary → risk policy
  ↓
bounded coordinate tap
  ↓
source + PNG evidence after each allowed action
  ↓
DELETE Appium session in finally
```

Device QA is `off` by default.

## Modes

- `off` — no device session
- `smoke` — start session, inspect source in memory, capture screenshot, close session
- `explore` — smoke plus bounded safe mobile taps and state capture

Android exploration example:

```bash
npm run qa -- \
  --url https://staging.example.com \
  --device-mode explore \
  --device-platform android \
  --max-device-actions 10 \
  --risk-mode safe \
  --appium-endpoint http://127.0.0.1:4723 \
  --device-capabilities-json '{"appium:deviceName":"emulator-5554","appium:appPackage":"com.example.app","appium:appActivity":".MainActivity"}'
```

`explore` requires an explicit autonomous app boundary: `appium:appPackage` on Android or `appium:bundleId` on iOS. If it is missing, DeviceAgent refuses exploration **before starting a session**.

## Provider transport

Core code depends on `DeviceProvider`, not a device-cloud vendor. The current provider speaks W3C WebDriver/Appium HTTP directly.

Defaults:

- Android → `platformName: Android`, `appium:automationName: UiAutomator2`
- iOS → `platformName: iOS`, `appium:automationName: XCUITest`

The selected platform is re-applied after custom capabilities are merged. Non-loopback Appium endpoints require HTTPS; loopback may use HTTP. Commands use `redirect: error`, bounded timeouts and bounded response sizes.

Coordinate taps use W3C touch pointer actions followed by action release. Coordinates outside the bounded viewport range are rejected.

## Candidate extraction

The page-source parser is bounded by source size, XML tag count and candidate count. It does not persist source XML.

Android candidates require clickable/long-clickable controls with usable bounds and labels from content description, text or resource ID. Android package identity is retained internally for app-boundary filtering.

iOS candidates are limited to known interactive XCUI element families such as Button, Cell, Link, Switch, Segment, TabBar, Toolbar and MenuItem, with visible/enabled geometry. If a bundle identifier is exposed in source it is retained for boundary filtering.

Malformed/out-of-range geometry is ignored.

## Application boundary

Autonomous mobile QA must not drift into system UI or another app.

When an application ID is declared, only candidates whose page-source application identity matches that boundary are eligible. Android permission-controller/system-settings controls are therefore excluded when their `package` differs from `appium:appPackage`.

Before making any autonomous tap, the current source must prove at least one candidate belongs to the declared application boundary. If it cannot, exploration stops and the Appium session is still cleaned up.

For iOS, this first slice is intentionally conservative: exploration requires a declared `appium:bundleId`, but if current Appium source does not expose a matching bundle identity the agent stops rather than guessing. A later provider capability can add an active-app identity query for broader iOS exploration.

Application IDs are used in memory for boundary decisions and are not copied into action-event metadata.

## Risk-aware tap policy

Each in-app candidate is mapped into the deterministic human-like risk policy and an additional mobile hard-block layer.

Permanently blocked examples include:

- delete/remove/close account or data
- payment/purchase/checkout/transfer/withdraw/deposit/payout
- deploy/publish or external messaging/webhook actions
- install/uninstall/factory reset/device wipe
- system permission allow/deny controls involving camera, microphone, photos, contacts, location, Bluetooth or notifications
- Traditional/Simplified Chinese equivalents of these destructive/financial/permission actions

CamelCase/resource IDs are normalized before evaluation, so controls such as `deleteAccount` and `payNow` cannot bypass word-based policy.

State-changing labels such as Save/Login/Register/Confirm are Medium. They remain blocked under the default `--risk-mode safe`; `standard` may allow Medium controls, but the permanent hard blocks above remain blocked in every mode.

Text entry, swipes, long-press gestures and system-permission handling are not implemented in this slice.

## Exploration loop

```text
source
 ↓
parse candidates
 ↓
filter outside app
 ↓
risk rank
 ↓
choose highest-value allowed unexercised control
 ↓
W3C tap
 ↓
new source + screenshot
 ↓
mark stateChanged
 ↓
repeat until no candidate or action budget exhausted
```

Candidate fingerprints include platform, app identity when present, class, label and bounds. Previously exercised fingerprints are skipped to avoid repeatedly tapping the same static control.

The default mobile action budget is 10 and CLI validation caps it at 50.

## Evidence and privacy

- Appium session ID stays in memory and is not serialized
- Appium bearer token is not serialized
- capability values are not serialized; only capability keys are recorded
- page source is not persisted
- source character count, element estimate and candidate counts are recorded
- screenshots are base64/size checked and must decode to a valid PNG
- after each allowed exploration tap, the resulting PNG and state-change metadata are recorded

At M5.2, Appium/provider failures remain tooling telemetry rather than product defects because the platform has not yet added a sufficiently deterministic crash/log oracle.

## Cleanup

Once a session is created, session deletion runs from `finally`. Page-source, screenshot or tap failures do not suppress cleanup.

The device summary records session/screenshot state, source/element counts, candidates observed, risk-blocked candidates, outside-app candidates, app-boundary state, actions, and cleanup status.

## Validation

M5 smoke foundation passed CI #99. The M4.6/M5 documentation checkpoint passed CI #102. M5.2 risk-aware mobile exploration passed CI #115, and the stronger app-boundary slice passed CI #119.

Tests cover Android/iOS candidate parsing, camelCase/Chinese risk rules, W3C touch actions, action limits, no tapping of delete/payment controls, exclusion of permission-controller controls, refusal without a declared app boundary, stop-without-tap when the current app cannot be verified, screenshot validation and session cleanup.

## Next device slice

M5.3 should add a deterministic **device defect oracle** rather than expanding gesture power first. Priority work:

1. app crash / ANR / termination evidence
2. active-application identity provider support, especially iOS
3. platform log capture with strict secret/size filtering
4. device visual regression/vision evidence after mobile actions
5. only then consider separately gated text entry, swipes and permission workflows
