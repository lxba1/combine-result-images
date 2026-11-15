import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  MAX_COL_COUNT,
  MAX_OFFSET_PX,
  MAX_RECOMMENDED_CANVAS_PIXELS,
  MAX_RECOMMENDED_CANVAS_SIDE,
  MAX_WEBP_DIMENSION,
  MIN_COL_COUNT,
  MIN_OFFSET_PX,
  areSettingsDefault,
  createDefaultSettings,
  cropRectToSettings,
  evaluateMontageCanvasSize,
  normalizeHexColor,
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

    assert.equal(restored.colCount, MIN_COL_COUNT);
    assert.equal(restored.quality, 100);
    assert.equal(restored.sortOrder, DEFAULT_SETTINGS.sortOrder);
    assert.equal(restored.cropWidth, 1);
    assert.deepEqual(restored.maskRatioRect, { rx0: 0.3, ry0: 0, rx1: 0.8, ry1: 1 });
    assert.equal(areSettingsDefault(createDefaultSettings()), true);
  });

  it('clamps colCount/offsetX upper bounds and synchronizes offsetY with offsetX', () => {
    const clampedHigh = parseSavedSettings(
      JSON.stringify({
        colCount: 99,
        offsetX: 120,
        offsetY: 5,
      })
    );
    assert.equal(clampedHigh.colCount, MAX_COL_COUNT);
    assert.equal(clampedHigh.offsetX, MAX_OFFSET_PX);
    assert.equal(clampedHigh.offsetY, MAX_OFFSET_PX);

    const clampedLow = parseSavedSettings(
      JSON.stringify({
        offsetX: -10,
        offsetY: 24,
      })
    );
    assert.equal(clampedLow.offsetX, MIN_OFFSET_PX);
    assert.equal(clampedLow.offsetY, MIN_OFFSET_PX);

    const fallbackToOffsetY = parseSavedSettings(
      JSON.stringify({
        offsetY: 24,
      })
    );
    assert.equal(fallbackToOffsetY.offsetX, 24);
    assert.equal(fallbackToOffsetY.offsetY, 24);
  });

  it('normalizes valid hex colors and rejects invalid color values', () => {
    const normalized = parseSavedSettings(
      JSON.stringify({
        bgColor: ' #ABC ',
        maskColor: '#FFFFFF',
        selfMaskColor: '#fff',
      })
    );
    assert.equal(normalized.bgColor, '#aabbcc');
    assert.equal(normalized.maskColor, '#ffffff');
    assert.equal(normalized.selfMaskColor, '#ffffff');

    const fallbackOnInvalid = parseSavedSettings(
      JSON.stringify({
        bgColor: '',
        maskColor: 'not-a-color',
        selfMaskColor: '#12345',
      })
    );
    assert.equal(fallbackOnInvalid.bgColor, DEFAULT_SETTINGS.bgColor);
    assert.equal(fallbackOnInvalid.maskColor, DEFAULT_SETTINGS.maskColor);
    assert.equal(fallbackOnInvalid.selfMaskColor, DEFAULT_SETTINGS.selfMaskColor);
  });
});

describe('hex color normalization and default comparison', () => {
  it('normalizes #rgb and #rrggbb strings and rejects malformed values', () => {
    assert.equal(normalizeHexColor('#ABCDEF'), '#abcdef');
    assert.equal(normalizeHexColor(' #0f8 '), '#00ff88');
    assert.equal(normalizeHexColor('#12345'), null);
    assert.equal(normalizeHexColor('red'), null);
    assert.equal(normalizeHexColor(''), null);
    assert.equal(normalizeHexColor(null), null);
  });

  it('treats uppercase or shorthand hex equivalents as default settings', () => {
    const withUppercaseWhite = createDefaultSettings();
    withUppercaseWhite.maskColor = '#FFFFFF';
    withUppercaseWhite.selfMaskColor = '#fff';
    withUppercaseWhite.bgColor = '#000';

    assert.equal(areSettingsDefault(withUppercaseWhite), true);
  });
});

describe('evaluateMontageCanvasSize', () => {
  it('allows large multi-image outputs above old 16M pixel limit without confirmation', () => {
    const result = evaluateMontageCanvasSize(
      30,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );

    assert.equal(result.width, 3100);
    assert.equal(result.height, 10103);
    assert.equal(result.pixels, 3100 * 10103);
    assert.equal(result.status, 'ok');
  });

  it('requests confirmation instead of blocking when WebP exceeds 16383 px, while allowing PNG/JPEG silently', () => {
    const webpResult = evaluateMontageCanvasSize(
      50,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );
    assert.equal(webpResult.height > MAX_WEBP_DIMENSION, true);
    assert.equal(webpResult.status, 'confirm_required');
    assert.equal(webpResult.reason, 'exceeds_webp_dimension');

    const pngResult = evaluateMontageCanvasSize(
      50,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'png' }
    );
    assert.equal(pngResult.status, 'ok');
  });

  it('requests confirmation with canvas limit reason when exceeding 32767 px side or 268M px area', () => {
    const tallWebp = evaluateMontageCanvasSize(
      100,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );
    assert.equal(tallWebp.height > MAX_RECOMMENDED_CANVAS_SIDE, true);
    assert.equal(tallWebp.status, 'confirm_required');
    assert.equal(tallWebp.reason, 'exceeds_canvas_limits');

    const wideArea = evaluateMontageCanvasSize(
      16,
      { width: 4500, height: 4500 },
      { colCount: 4, offsetX: 0, offsetY: 0, outputFormat: 'png' }
    );
    assert.equal(wideArea.pixels > MAX_RECOMMENDED_CANVAS_PIXELS, true);
    assert.equal(wideArea.status, 'confirm_required');
    assert.equal(wideArea.reason, 'exceeds_canvas_limits');
  });

  it('rejects non-positive or integer-overflow dimensions as invalid', () => {
    assert.equal(
      evaluateMontageCanvasSize(0, { width: 100, height: 100 }, { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }).status,
      'invalid'
    );
    assert.equal(
      evaluateMontageCanvasSize(2, { width: 0, height: 100 }, { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }).status,
      'invalid'
    );
    assert.equal(
      evaluateMontageCanvasSize(2, { width: Number.MAX_SAFE_INTEGER, height: 100 }, { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'png' }).status,
      'invalid'
    );
  });
});
