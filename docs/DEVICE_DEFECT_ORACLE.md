# M5.3 Device Defect Oracle

M5.3 adds deterministic product-defect evidence to the bounded Appium exploration layer. The goal is not to collect every device log or infer crashes from weak symptoms; the oracle reports a High finding only when a signal is tightly connected to an allowed QA action and has a strong platform-specific failure signature.

## Evidence chain

```text
verified target app foreground
        ↓
allowed risk-policy mobile tap
        ↓
        ├── query target app state
        ├── inspect only new platform-log batch
        └── inspect new page source / screenshot
        ↓
strong deterministic defect signal?
        ↓
High finding + action-specific reproduction + screenshot
```

Intentional app-exit controls are permanently blocked so an expected Exit/Quit action cannot masquerade as an application-termination defect.

## Application-state oracle

When supported by the Appium provider, Device Agent queries the configured target application's platform state before exploration and after every allowed action.

The normalized states are treated conservatively:

- foreground — continue exploration
- background/suspended — stop exploration without a product verdict
- not installed/not running after an allowed interaction — High `app-terminated` finding
- non-foreground before autonomous interaction begins — environment/tooling stop, not a product defect
- unsupported state query — fall back to the existing app-boundary/source evidence

Only the numeric state and boolean foreground result are recorded. The package/bundle identifier is not copied into events.

## Active-application boundary

Android normally proves the application boundary from page-source `package` attributes.

iOS page source often lacks a per-element bundle identifier. The W3C Appium provider therefore supports an optional active-application query. When a verified active iOS bundle equals the explicitly configured `appium:bundleId`, unlabeled XCUI candidates may be treated as in-app. When another app/SpringBoard becomes active, exploration stops before another tap.

Raw active application identifiers are kept in memory and are represented in evidence only as booleans such as `activeApplicationVerified` and `targetApplicationActive`.

## Android crash / ANR page-source oracle

After an allowed action, Android page source is inspected in memory for narrowly scoped OS failure-dialog signatures.

Crash examples include equivalents of:

- keeps stopping
- has stopped / stopped working
- Traditional/Simplified Chinese stopped-running system text

ANR examples include equivalents of:

- isn't responding / is not responding
- Traditional/Simplified Chinese no-response system text

The source XML and matched raw dialog text are not persisted. A finding records only the categorical signature (`android-crash-dialog` or `android-anr-dialog`) plus action number and screenshot.

## Privacy-preserving platform-log oracle

The log oracle is optional. At session start Device Agent asks the provider for available log types and selects only a narrow crash source:

- Android: `logcat`
- iOS: `crashlog`

Before any autonomous action, the selected log stream is read once and discarded to drain pre-existing records. This prevents an old crash from being attributed to the current QA action.

After each allowed tap, the agent retrieves only the next bounded batch and checks it in memory. A High finding requires both:

1. the same batch explicitly names the configured target application identity, and
2. a deterministic crash/ANR signature is present.

Android crash signatures include `FATAL EXCEPTION`, fatal signals, process-death and force-finishing markers. Android ANR signatures include `ANR in`, application-not-responding and input-dispatch timeout markers. iOS accepts crash-report signatures only from the `crashlog` stream, such as Exception Type / Termination Reason / Triggered Thread / Exception Codes.

A generic error, network failure, SEVERE log level, or crash signature belonging to another app does not produce a product finding.

### Log privacy bounds

Raw platform log text is never copied into `events.json`, `result.json`, findings or reproduction steps. Evidence includes only:

- defect kind (`crash-log` / `anr-log`)
- categorical signature
- selected log source name
- bounded number of entries considered
- `rawLogsPersisted: false`
- associated allowed action number/candidate
- best-effort screenshot

The HTTP provider bounds log response size, type count, entry count and individual message length before in-memory analysis.

## Finding severity

High findings are currently limited to:

- target application becomes not-running immediately after an allowed interaction
- deterministic Android crash dialog after an allowed interaction
- deterministic Android ANR dialog after an allowed interaction
- target-app Android logcat batch with fatal/ANR signature after an allowed interaction
- target-app iOS crashlog batch with crash-report signature after an allowed interaction

Leaving the foreground, unsupported Appium extensions, log retrieval failure, or inability to prove app identity stop or degrade exploration without being mislabeled as an application defect.

## Cleanup

The Appium session still closes from `finally` after any oracle finding or tooling failure. Oracle detection does not bypass session cleanup.

## Test coverage

The M5.3 test suite locks the following behavior:

- foreground → not-running after allowed tap produces High application-termination finding
- foreground → background stops with no product finding
- Android crash-dialog signatures produce High without persisting source XML
- Android/iOS app-state execute arguments are platform-correct
- iOS active-app identity enables boundary-safe XCUI exploration and stops on SpringBoard/other app
- old log entries are drained before the first action
- Android target-app fatal/ANR log batches are detected
- identical crash markers for another app are ignored
- iOS crash signatures are accepted only from `crashlog`
- generic SEVERE/network errors are ignored
- raw exception/log messages and app identifiers are absent from serialized device events

M5.3 is deliberately a defect-oracle milestone. Text entry, swipes, long press and autonomous permission workflows remain out of scope until separately gated.
