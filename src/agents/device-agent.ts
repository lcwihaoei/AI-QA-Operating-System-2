import type { RiskMode } from '../core/types.js';
import type { DeviceMode, DevicePlatform, DeviceProvider, DeviceSession } from '../device/device-provider.js';
import type { DeviceQaSummary, QaEvent } from '../core/types.js';
import type { EvidenceStore } from '../evidence/evidence-store.js';
import { detectDeviceDefect } from '../device/device-defect-oracle.js';
import { detectDeviceLogDefect } from '../device/device-log-oracle.js';
import { parseDeviceElementCandidates } from '../device/device-page-source.js';
import { DeviceRiskPolicy } from '../device/device-risk-policy.js';
import { HttpAppiumDeviceProvider } from '../providers/http-appium-device-provider.js';

export interface DeviceAgentOptions {
  mode: DeviceMode;
  platform?: DevicePlatform;
  maxActions?: number;
  riskMode?: RiskMode;
  appiumEndpoint?: string;
  appiumToken?: string;
  capabilities?: Record<string, unknown>;
}

export interface DeviceAgentResult {
  events: QaEvent[];
  summary: DeviceQaSummary;
}

function estimateElements(source: string): number {
  const matches = source.match(/<(?![!?/])(?:[A-Za-z_][A-Za-z0-9_.:-]*)(?:\s|\/?>)/g);
  return Math.min(matches?.length ?? 0, 100_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedApplicationId(platform: DevicePlatform, capabilities: Record<string, unknown> | undefined): string | undefined {
  const key = platform === 'android' ? 'appium:appPackage' : 'appium:bundleId';
  const value = capabilities?.[key];
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 ? value.trim() : undefined;
}

function selectDefectLogType(platform: DevicePlatform, available: string[]): string | undefined {
  const lookup = new Map(available.map((value) => [value.toLowerCase(), value]));
  return platform === 'android' ? lookup.get('logcat') : lookup.get('crashlog');
}

export class DeviceAgent {
  constructor(
    private readonly evidence: EvidenceStore,
    private readonly injectedProvider?: DeviceProvider,
    private readonly riskPolicy: DeviceRiskPolicy = new DeviceRiskPolicy(),
  ) {}

  async run(options: DeviceAgentOptions): Promise<DeviceAgentResult> {
    const events: QaEvent[] = [];
    const expectedAppId = options.platform ? expectedApplicationId(options.platform, options.capabilities) : undefined;
    const summary: DeviceQaSummary = {
      enabled: options.mode !== 'off',
      mode: options.mode,
      platform: options.platform,
      provider: this.injectedProvider?.name,
      sessionStarted: false,
      screenshotCaptured: false,
      pageSourceChars: 0,
      elementEstimate: 0,
      candidatesObserved: 0,
      blockedCandidates: 0,
      outsideAppCandidates: 0,
      appBoundaryDeclared: Boolean(expectedAppId),
      appBoundaryObserved: false,
      appStateChecks: 0,
      appTerminationFindings: 0,
      crashDialogFindings: 0,
      logOracleEnabled: false,
      logChecks: 0,
      logCrashFindings: 0,
      actions: 0,
      cleanupAttempted: false,
      cleanupFailed: false,
    };

    if (options.mode === 'off') return { events, summary };
    if (!options.platform || (!this.injectedProvider && !options.appiumEndpoint)) {
      summary.toolingError = `device ${options.mode} mode requires a platform and Appium endpoint/provider`;
      events.push(this.telemetry(options.platform, `Device QA ${options.mode} mode could not start`, summary.toolingError));
      return { events, summary };
    }
    if (options.mode === 'explore' && !expectedAppId) {
      summary.toolingError = options.platform === 'android'
        ? 'device explore mode requires appium:appPackage to declare the autonomous app boundary'
        : 'device explore mode requires appium:bundleId to declare the autonomous app boundary';
      events.push(this.telemetry(options.platform, 'Device exploration refused without an explicit application boundary', summary.toolingError));
      return { events, summary };
    }

    const maxActions = Math.max(1, Math.min(options.maxActions ?? 10, 50));
    const riskMode = options.riskMode ?? 'safe';
    let provider: DeviceProvider;
    try {
      provider = this.injectedProvider ?? new HttpAppiumDeviceProvider(options.appiumEndpoint!, options.appiumToken);
      summary.provider = provider.name;
    } catch (error: unknown) {
      summary.toolingError = String(error);
      events.push(this.telemetry(options.platform, 'Device provider initialization failed', String(error)));
      return { events, summary };
    }

    let session: DeviceSession | undefined;
    let defectLogType: string | undefined;
    try {
      session = await provider.startSession({ platform: options.platform, capabilities: options.capabilities });
      summary.sessionStarted = true;
      events.push(this.event('snapshot', options.platform, 'Device Appium session started', {
        device: true,
        platform: options.platform,
        provider: provider.name,
        mode: options.mode,
        capabilityKeys: Object.keys(options.capabilities ?? {}).slice(0, 40),
        appBoundaryDeclared: Boolean(expectedAppId),
      }));

      if (options.mode === 'explore' && expectedAppId) {
        const initialState = await provider.queryApplicationState(session, expectedAppId);
        if (initialState !== undefined) {
          summary.appStateChecks += 1;
          events.push(this.event('snapshot', options.platform, 'Target application state checked before exploration', {
            device: true, platform: options.platform, appState: initialState, foreground: initialState === 4,
          }));
          if (initialState !== 4) {
            events.push(this.telemetry(options.platform,
              'Device exploration stopped because the target application was not foreground before autonomous actions',
              `initial target application state was ${initialState}`));
            return { events, summary };
          }
        }

        const logTypes = await provider.getAvailableLogTypes(session);
        defectLogType = selectDefectLogType(options.platform, logTypes);
        if (defectLogType) {
          summary.logOracleEnabled = true;
          await provider.getLogEntries(session, defectLogType); // Drain pre-existing entries; never persist raw logs.
          events.push(this.event('snapshot', options.platform, 'Device crash-log oracle initialized and pre-existing logs drained', {
            device: true,
            platform: options.platform,
            logOracle: true,
            logSource: defectLogType,
            rawLogsPersisted: false,
          }));
        }
      }

      let source = await provider.getPageSource(session);
      summary.pageSourceChars = source.length;
      summary.elementEstimate = estimateElements(source);
      events.push(this.event('snapshot', options.platform, 'Device page source inspected in memory', {
        device: true, platform: options.platform, sourceChars: source.length, elementEstimate: summary.elementEstimate, sourcePersisted: false,
      }));

      const initialShot = await this.captureScreenshot(provider, session, options.platform, options.mode === 'smoke' ? 'smoke' : 'explore-0');
      summary.screenshotCaptured = true;
      events.push(this.event('snapshot', options.platform, 'Device screenshot captured', {
        device: true, platform: options.platform, screenshot: initialShot, actionNumber: 0,
      }));

      if (options.mode === 'explore') {
        const exercised = new Set<string>();
        const observed = new Set<string>();
        const blocked = new Set<string>();
        const outsideApp = new Set<string>();

        while (summary.actions < maxActions) {
          const activeAppId = await provider.getActiveApplicationId(session);
          const activeIdentityKnown = activeAppId !== undefined;
          const activeIdentityMatches = activeAppId === expectedAppId;
          if (activeIdentityKnown && !activeIdentityMatches) {
            summary.appBoundaryObserved = false;
            events.push(this.event('snapshot', options.platform, 'Device exploration stopped because another application became active', {
              device: true, platform: options.platform, activeApplicationVerified: true, targetApplicationActive: false,
            }));
            break;
          }

          const candidates = parseDeviceElementCandidates(source, options.platform);
          for (const candidate of candidates) observed.add(candidate.id);
          let sourceBoundaryObserved = false;
          const appCandidates = candidates.filter((candidate) => {
            if (candidate.applicationId === expectedAppId) {
              sourceBoundaryObserved = true;
              return true;
            }
            if (!candidate.applicationId && options.platform === 'ios' && activeIdentityMatches) return true;
            outsideApp.add(candidate.id);
            return false;
          });
          const currentBoundaryObserved = sourceBoundaryObserved || (options.platform === 'ios' && activeIdentityMatches);
          summary.appBoundaryObserved = currentBoundaryObserved;
          summary.candidatesObserved = observed.size;
          summary.outsideAppCandidates = outsideApp.size;
          if (!currentBoundaryObserved) {
            events.push(this.telemetry(options.platform,
              'Device exploration stopped because the current state did not prove the declared application boundary',
              'application identity could not be verified from page source or active-app provider evidence'));
            break;
          }

          const ranked = appCandidates
            .map((candidate) => ({ candidate, decision: this.riskPolicy.evaluate(candidate, riskMode) }))
            .filter(({ candidate }) => !exercised.has(candidate.id))
            .sort((a, b) => b.decision.interestScore - a.decision.interestScore || a.candidate.y - b.candidate.y || a.candidate.x - b.candidate.x);
          for (const item of ranked) if (!item.decision.allowed) blocked.add(item.candidate.id);
          summary.blockedCandidates = blocked.size;
          const allowed = ranked.filter((item) => item.decision.allowed);
          events.push(this.event('planner', options.platform, `Device planner ranked ${ranked.length} in-app unexercised candidates`, {
            device: true, platform: options.platform, riskMode, allowed: allowed.length, blocked: ranked.length - allowed.length,
            outsideApp: summary.outsideAppCandidates, activeApplicationVerified: activeIdentityKnown,
            targetApplicationActive: activeIdentityKnown ? activeIdentityMatches : undefined,
            top: allowed.slice(0, 6).map(({ candidate, decision }) => ({ id: candidate.id, label: candidate.label, className: candidate.className, risk: decision.risk, interestScore: decision.interestScore, reasons: decision.reasons })),
            blockedExamples: ranked.filter((item) => !item.decision.allowed).slice(0, 5).map(({ candidate, decision }) => ({ label: candidate.label, reasons: decision.reasons })),
          }));

          const next = allowed[0];
          if (!next) break;
          exercised.add(next.candidate.id);
          const actionNumber = summary.actions + 1;
          const priorAction = `Tap mobile control: ${next.candidate.label}`;
          events.push(this.event('action', options.platform, priorAction, {
            device: true, platform: options.platform, candidateId: next.candidate.id, className: next.candidate.className,
            actionNumber, x: next.candidate.centerX, y: next.candidate.centerY, risk: next.decision.risk, reasons: next.decision.reasons,
          }));

          await provider.tap(session, next.candidate.centerX, next.candidate.centerY);
          summary.actions += 1;
          await delay(300);

          if (expectedAppId) {
            const postState = await provider.queryApplicationState(session, expectedAppId);
            if (postState !== undefined) {
              summary.appStateChecks += 1;
              events.push(this.event('snapshot', options.platform, `Target application state checked after action ${summary.actions}`, {
                device: true, platform: options.platform, actionNumber: summary.actions, appState: postState, foreground: postState === 4,
              }));
              if (postState === 0 || postState === 1) {
                const screenshot = await this.captureScreenshotBestEffort(provider, session, options.platform, `terminated-${summary.actions}`);
                if (screenshot) summary.screenshotCaptured = true;
                summary.appTerminationFindings += 1;
                events.push(this.event('assertion', options.platform, 'Target mobile application terminated after an allowed QA interaction', {
                  device: true, platform: options.platform, deviceDefect: 'app-terminated', severityHint: 'high', confidence: 'high',
                  actionNumber: summary.actions, candidateId: next.candidate.id, priorAction, appState: postState, screenshot,
                }));
                break;
              }
              if (postState === 2 || postState === 3) {
                events.push(this.event('snapshot', options.platform, 'Target mobile application left the foreground after an allowed interaction; exploration stopped without a product verdict', {
                  device: true, platform: options.platform, actionNumber: summary.actions, appState: postState, priorAction,
                }));
                break;
              }
            }
          }

          if (defectLogType && expectedAppId) {
            const entries = await provider.getLogEntries(session, defectLogType);
            summary.logChecks += 1;
            const logDefect = detectDeviceLogDefect(entries, options.platform, expectedAppId, defectLogType);
            if (logDefect) {
              const screenshot = await this.captureScreenshotBestEffort(provider, session, options.platform, `log-defect-${summary.actions}`);
              if (screenshot) summary.screenshotCaptured = true;
              summary.logCrashFindings += 1;
              events.push(this.event('assertion', options.platform,
                logDefect.kind === 'anr-log'
                  ? 'Device logs reported an application-not-responding failure after an allowed QA interaction'
                  : 'Device logs reported an application crash after an allowed QA interaction', {
                  device: true, platform: options.platform, deviceDefect: logDefect.kind, defectSignature: logDefect.signature,
                  severityHint: 'high', confidence: 'high', actionNumber: summary.actions, candidateId: next.candidate.id,
                  priorAction, screenshot, logSource: defectLogType, logEntriesConsidered: logDefect.entriesConsidered, rawLogsPersisted: false,
                }));
              break;
            }
          }

          const previousSource = source;
          source = await provider.getPageSource(session);
          summary.pageSourceChars = source.length;
          summary.elementEstimate = estimateElements(source);
          const screenshot = await this.captureScreenshot(provider, session, options.platform, `explore-${summary.actions}`);
          summary.screenshotCaptured = true;
          events.push(this.event('snapshot', options.platform, `Captured mobile state after action ${summary.actions}`, {
            device: true, platform: options.platform, candidateId: next.candidate.id, actionNumber: summary.actions, screenshot,
            sourceChars: source.length, elementEstimate: summary.elementEstimate, sourcePersisted: false, stateChanged: source !== previousSource,
          }));

          const defect = detectDeviceDefect(source, options.platform);
          if (defect) {
            summary.crashDialogFindings += 1;
            events.push(this.event('assertion', options.platform, defect.kind === 'anr-dialog'
              ? 'Android application-not-responding system dialog detected after an allowed QA interaction'
              : 'Android application crash system dialog detected after an allowed QA interaction', {
              device: true, platform: options.platform, deviceDefect: defect.kind, defectSignature: defect.signature,
              severityHint: 'high', confidence: 'high', actionNumber: summary.actions, candidateId: next.candidate.id,
              priorAction, screenshot, sourcePersisted: false,
            }));
            break;
          }
        }
      }
    } catch (error: unknown) {
      summary.toolingError = String(error);
      events.push(this.telemetry(options.platform, `Device QA ${options.mode} command failed without a product verdict`, String(error)));
    } finally {
      if (session) {
        summary.cleanupAttempted = true;
        try {
          await provider.stopSession(session);
          events.push(this.event('snapshot', options.platform, 'Device Appium session closed', { device: true, platform: options.platform, cleanup: true }));
        } catch (error: unknown) {
          summary.cleanupFailed = true;
          const message = String(error);
          summary.toolingError = summary.toolingError ? `${summary.toolingError}; ${message}` : message;
          events.push(this.telemetry(options.platform, 'Device Appium session cleanup failed', message));
        }
      }
    }

    return { events, summary };
  }

  private async captureScreenshot(provider: DeviceProvider, session: DeviceSession, platform: DevicePlatform, label: string): Promise<string> {
    const screenshotBase64 = await provider.getScreenshotBase64(session);
    return this.evidence.writePngBase64(screenshotBase64, `device-${platform}-${label}`);
  }

  private async captureScreenshotBestEffort(provider: DeviceProvider, session: DeviceSession, platform: DevicePlatform, label: string): Promise<string | undefined> {
    try { return await this.captureScreenshot(provider, session, platform, label); } catch { return undefined; }
  }

  private telemetry(platform: DevicePlatform | undefined, message: string, toolingError: string): QaEvent {
    return this.event('snapshot', platform, message, { device: true, platform, toolingError });
  }

  private event(kind: QaEvent['kind'], platform: DevicePlatform | undefined, message: string, details?: Record<string, unknown>): QaEvent {
    return { timestamp: new Date().toISOString(), kind, url: `device://${platform ?? 'unknown'}`, message, details };
  }
}
