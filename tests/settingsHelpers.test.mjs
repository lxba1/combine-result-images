import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  areSettingsDefault,
  createDefaultSettings,
  cropRectToSettings,
  parseSavedSettings,
} from '../src/settingsHelpers.ts';

describe('cropRectToSettings', () => {
  it('maps detected { x, y, width, height } to cropX, cropY, cropWidth, cropHeight', () => {
    const mapped = cropRectToSettings({ x: 10, y: 50, width: 980, height: 500 });

    assert.deepEqual(mapped, {
      cropX: 10,
      cropY: 50,
      cropWidth: 980,
      cropHeight: 500,
    });
    assert.equal('x' in mapped, false);
    assert.equal('y' in mapped, false);
    assert.equal('width' in mapped, false);
    assert.equal('height' in mapped, false);
  });
});

describe('parseSavedSettings', () => {
  it('returns defaults on null, invalid JSON, or non-object JSON', () => {
    assert.deepEqual(parseSavedSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(parseSavedSettings('{invalid json'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSavedSettings('[]'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSavedSettings('"string"'), DEFAULT_SETTINGS);
  });

  it('strips extraneous x, y, width, height and unknown keys while keeping valid settings', () => {
    const rawJson = JSON.stringify({
      cropAuto: false,
      cropX: 10,
      cropY: 50,
      cropWidth: 980,
      cropHeight: 500,
      x: 10,
      y: 50,
      width: 980,
      height: 500,
      unexpectedKey: 'stale',
    });

    const restored = parseSavedSettings(rawJson);

    assert.equal(restored.cropAuto, false);
    assert.equal(restored.cropX, 10);
    assert.equal(restored.cropY, 50);
    assert.equal(restored.cropWidth, 980);
    assert.equal(restored.cropHeight, 500);
    assert.equal('x' in restored, false);
    assert.equal('y' in restored, false);
    assert.equal('width' in restored, false);
    assert.equal('height' in restored, false);
    assert.equal('unexpectedKey' in restored, false);
    assert.deepEqual(Object.keys(restored).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('migrates legacy maskAuto/selfMaskAuto and strips legacy keys', () => {
    const rawJson = JSON.stringify({
      maskAuto: true,
      selfMaskAuto: false,
    });

    const restored = parseSavedSettings(rawJson);

    assert.equal(restored.maskMode, 'ocr');
    assert.equal(restored.selfMaskMode, 'manual');
    assert.equal('maskAuto' in restored, false);
    assert.equal('selfMaskAuto' in restored, false);
  });

  it('clamps invalid numeric/enum/ratio fields to safe bounds', () => {
    const rawJson = JSON.stringify({
      colCount: 0,
      quality: 999,
      sortOrder: 'bogus',
      cropWidth: -20,
      maskRatioRect: { rx0: 0.8, ry0: -0.2, rx1: 0.3, ry1: 1.5 },
    });

    const restored = parseSavedSettings(rawJson);

    assert.equal(restored.colCount, 1);
    assert.equal(restored.quality, 100);
    assert.equal(restored.sortOrder, DEFAULT_SETTINGS.sortOrder);
    assert.equal(restored.cropWidth, 1);
    assert.deepEqual(restored.maskRatioRect, { rx0: 0.3, ry0: 0, rx1: 0.8, ry1: 1 });
    assert.equal(areSettingsDefault(createDefaultSettings()), true);
  });
});
