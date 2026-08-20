import { describe, expect, it } from 'vitest';
import { parseDeviceElementCandidates } from '../src/device/device-page-source.js';

describe('device page source candidate parser', () => {
  it('extracts bounded clickable Android controls and decodes labels', () => {
    const source = `<?xml version="1.0"?><hierarchy>
      <node class="android.widget.Button" text="Settings &amp; Help" clickable="true" enabled="true" displayed="true" bounds="[10,20][210,100]" />
      <node class="android.widget.Button" text="Disabled" clickable="true" enabled="false" bounds="[10,120][210,200]" />
      <node class="android.widget.TextView" text="Plain" clickable="false" enabled="true" bounds="[10,220][210,300]" />
      <node class="android.widget.ImageButton" resource-id="com.example:id/deleteAccount" clickable="true" enabled="true" bounds="[10,320][210,400]" />
    </hierarchy>`;
    const candidates = parseDeviceElementCandidates(source, 'android');
    expect(candidates.map((candidate) => candidate.label)).toEqual(['Settings & Help', 'com.example:id/deleteAccount']);
    expect(candidates[0]).toMatchObject({ centerX: 110, centerY: 60, width: 200, height: 80 });
  });

  it('extracts iOS buttons/cells with geometry and ignores static text', () => {
    const source = `<AppiumAUT>
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="Settings" label="Settings" enabled="true" visible="true" x="20" y="50" width="120" height="44" />
      <XCUIElementTypeCell type="XCUIElementTypeCell" name="Profile" label="Profile" enabled="true" visible="true" x="0" y="120" width="390" height="60" />
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="Title" label="Title" enabled="true" visible="true" x="20" y="200" width="120" height="40" />
    </AppiumAUT>`;
    const candidates = parseDeviceElementCandidates(source, 'ios');
    expect(candidates.map((candidate) => candidate.label)).toEqual(['Settings', 'Profile']);
    expect(candidates[0]).toMatchObject({ centerX: 80, centerY: 72 });
  });
});
