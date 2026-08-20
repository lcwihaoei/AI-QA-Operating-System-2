export type DevicePlatform = 'android' | 'ios';
export type DeviceMode = 'off' | 'smoke' | 'explore';

export interface DeviceSessionRequest {
  platform: DevicePlatform;
  capabilities?: Record<string, unknown>;
}

export interface DeviceSession {
  id: string;
  platform: DevicePlatform;
}

export interface DeviceLogEntry {
  level?: string;
  message: string;
  timestamp?: number;
}

export interface DeviceProvider {
  readonly name: string;
  startSession(request: DeviceSessionRequest): Promise<DeviceSession>;
  getPageSource(session: DeviceSession): Promise<string>;
  getScreenshotBase64(session: DeviceSession): Promise<string>;
  queryApplicationState(session: DeviceSession, applicationId: string): Promise<number | undefined>;
  getActiveApplicationId(session: DeviceSession): Promise<string | undefined>;
  getAvailableLogTypes(session: DeviceSession): Promise<string[]>;
  getLogEntries(session: DeviceSession, logType: string): Promise<DeviceLogEntry[]>;
  tap(session: DeviceSession, x: number, y: number): Promise<void>;
  stopSession(session: DeviceSession): Promise<void>;
}
