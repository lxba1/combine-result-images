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
  SETTINGS_STORAGE_KEY,
  areSettingsDefault,
  areSettingsEqual,
  cloneSettings,
  commitRatioRectField,
  computeRatioMaskOverlayBox,
  computeRatioMaskRect,
  createDefaultSettings,
  cropRectToSettings,
  evaluateMontageCanvasSize,
  formatRatioPercent,
  getResultStaleReason,
  hasCropOverlapWithImage,
  intersectPixelRects,
  loadSettingsFromStorage,
  normalizeHexColor,
  normalizeRatioRect,
  parseSavedSettings,
  percentInputToRatio,
  ratioToPercentInput,
  resolveCanvasSizeErrorUiTarget,
  saveSettingsToStorage,
  validateSettingsBeforeProcess,
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
      webpMethod: 6,
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
    assert.equal('webpMethod' in restored, false);
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

  it('ignores auto-computed pixel coordinates while preserving manual-mode and user option diffs in areSettingsDefault', () => {
    // Auto-crop on non-1600x900 images populates cropX/Y/W/H via settingsPatch
    const afterAutoCrop = {
      ...createDefaultSettings(),
      cropAuto: true,
      cropX: 37,
      cropY: 140,
      cropWidth: 1846,
      cropHeight: 798,
    };
    assert.equal(areSettingsDefault(afterAutoCrop), true);

    // Turning off auto-crop is a user modification even if crop coords match defaults
    assert.equal(areSettingsDefault({ ...createDefaultSettings(), cropAuto: false }), false);

    // Mask/self-mask pixel coords written by ratio/ocr runs are ignored when disabled
    const afterDisabledAutoMasks = {
      ...createDefaultSettings(),
      maskEnabled: false,
      maskMode: 'ratio',
      maskX: 1207,
      maskY: 93,
      maskWidth: 330,
      maskHeight: 40,
      selfMaskEnabled: false,
      selfMaskMode: 'ratio',
      selfMaskX: 414,
      selfMaskY: 93,
      selfMaskWidth: 355,
      selfMaskHeight: 40,
    };
    assert.equal(areSettingsDefault(afterDisabledAutoMasks), true);

    // Changing mask mode away from default (even while disabled) or enabling a mask stays non-default
    assert.equal(areSettingsDefault({ ...createDefaultSettings(), maskMode: 'ocr' }), false);
    assert.equal(areSettingsDefault({ ...createDefaultSettings(), selfMaskMode: 'manual' }), false);
    assert.equal(areSettingsDefault({ ...createDefaultSettings(), maskEnabled: true }), false);
    assert.equal(areSettingsDefault({ ...createDefaultSettings(), selfMaskEnabled: true }), false);
    assert.equal(
      areSettingsDefault({ ...createDefaultSettings(), maskColor: '#000000' }),
      false
    );
  });

  it('compares settings snapshots and reports stale reason across settings and image list changes', () => {
    const base = cloneSettings(createDefaultSettings());
    base.maskRatioRect.rx0 = 0.25;
    assert.notEqual(base.maskRatioRect.rx0, DEFAULT_SETTINGS.maskRatioRect.rx0);

    const snapshot = cloneSettings(createDefaultSettings());
    const fileA = { name: 'a.png' };
    const fileB = { name: 'b.png' };
    const snapshotImages = [fileA, fileB];

    assert.equal(areSettingsEqual(snapshot, cloneSettings(snapshot)), true);
    assert.equal(
      getResultStaleReason({
        currentSettings: cloneSettings(snapshot),
        snapshotSettings: snapshot,
        currentImages: [fileA, fileB],
        snapshotImages,
      }),
      'none'
    );

    assert.equal(
      getResultStaleReason({
        currentSettings: { ...snapshot, outputFormat: 'png' },
        snapshotSettings: snapshot,
        currentImages: [fileA, fileB],
        snapshotImages,
      }),
      'settings'
    );

    assert.equal(
      getResultStaleReason({
        currentSettings: cloneSettings(snapshot),
        snapshotSettings: snapshot,
        currentImages: [fileA],
        snapshotImages,
      }),
      'images'
    );

    assert.equal(
      getResultStaleReason({
        currentSettings: { ...snapshot, colCount: 4 },
        snapshotSettings: snapshot,
        currentImages: [fileA],
        snapshotImages,
      }),
      'both'
    );

    // Ignoring runtime auto-managed coordinates keeps snapshot fresh when cropAuto stays true
    assert.equal(
      getResultStaleReason({
        currentSettings: { ...snapshot, cropAuto: true, cropX: 99 },
        snapshotSettings: { ...snapshot, cropAuto: true, cropX: 31 },
        currentImages: [fileA, fileB],
        snapshotImages,
      }),
      'none'
    );
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

  it('blocks WebP when exceeding 16383 px (even above canvas limits), while allowing PNG/JPEG up to canvas limits', () => {
    const okWebpBoundary = evaluateMontageCanvasSize(
      48,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );
    assert.equal(okWebpBoundary.height, 16160);
    assert.equal(okWebpBoundary.status, 'ok');

    const webpResult = evaluateMontageCanvasSize(
      49,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );
    assert.equal(webpResult.height > MAX_WEBP_DIMENSION, true);
    assert.equal(webpResult.status, 'invalid');
    assert.equal(webpResult.reason, 'exceeds_webp_dimension');

    const singleColWebp = evaluateMontageCanvasSize(
      25,
      { width: 1538, height: 665 },
      { colCount: 1, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );
    assert.equal(singleColWebp.height, 16833);
    assert.equal(singleColWebp.status, 'invalid');
    assert.equal(singleColWebp.reason, 'exceeds_webp_dimension');

    const wideWebp = evaluateMontageCanvasSize(
      2,
      { width: 10000, height: 100 },
      { colCount: 2, offsetX: 0, offsetY: 0, outputFormat: 'webp' }
    );
    assert.equal(wideWebp.width, 20000);
    assert.equal(wideWebp.status, 'invalid');
    assert.equal(wideWebp.reason, 'exceeds_webp_dimension');

    const pngResult = evaluateMontageCanvasSize(
      49,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'png' }
    );
    assert.equal(pngResult.status, 'ok');

    const jpegResult = evaluateMontageCanvasSize(
      49,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'jpeg' }
    );
    assert.equal(jpegResult.status, 'ok');
  });

  it('requests confirmation with canvas limit reason for PNG/JPEG exceeding 32767 px side or 268M px area, while still blocking WebP', () => {
    const tallWebp = evaluateMontageCanvasSize(
      100,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'webp' }
    );
    assert.equal(tallWebp.height > MAX_RECOMMENDED_CANVAS_SIDE, true);
    assert.equal(tallWebp.status, 'invalid');
    assert.equal(tallWebp.reason, 'exceeds_webp_dimension');

    const tallPng = evaluateMontageCanvasSize(
      100,
      { width: 1538, height: 665 },
      { colCount: 2, offsetX: 8, offsetY: 8, outputFormat: 'png' }
    );
    assert.equal(tallPng.height > MAX_RECOMMENDED_CANVAS_SIDE, true);
    assert.equal(tallPng.status, 'confirm_required');
    assert.equal(tallPng.reason, 'exceeds_canvas_limits');

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

describe('loadSettingsFromStorage and saveSettingsToStorage', () => {
  it('loads valid settings and falls back to defaults when localStorage access or getItem throws', () => {
    const valid = loadSettingsFromStorage(() => ({
      getItem: (key) => (key === SETTINGS_STORAGE_KEY ? JSON.stringify({ colCount: 4 }) : null),
      setItem: () => {},
    }));
    assert.equal(valid.colCount, 4);

    assert.deepEqual(loadSettingsFromStorage(() => null), DEFAULT_SETTINGS);

    const originalWarn = console.warn;
    let warnCount = 0;
    console.warn = () => {
      warnCount++;
    };
    try {
      const getterBlocked = loadSettingsFromStorage(() => {
        throw new Error('SecurityError: storage access denied');
      });
      assert.deepEqual(getterBlocked, DEFAULT_SETTINGS);

      const getItemBlocked = loadSettingsFromStorage(() => ({
        getItem: () => {
          throw new Error('SecurityError: blocked');
        },
        setItem: () => {},
      }));
      assert.deepEqual(getItemBlocked, DEFAULT_SETTINGS);
      assert.equal(warnCount, 2);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('persists serialized settings and returns false cleanly when setItem or storage access throws', () => {
    const written = new Map();
    const ok = saveSettingsToStorage(createDefaultSettings(), () => ({
      getItem: () => null,
      setItem: (k, v) => {
        written.set(k, v);
      },
    }));
    assert.equal(ok, true);
    assert.equal(JSON.parse(written.get(SETTINGS_STORAGE_KEY)).colCount, DEFAULT_SETTINGS.colCount);

    assert.equal(saveSettingsToStorage(createDefaultSettings(), () => null), false);

    const originalWarn = console.warn;
    let warnCount = 0;
    console.warn = () => {
      warnCount++;
    };
    try {
      const quotaExceeded = saveSettingsToStorage(createDefaultSettings(), () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      }));
      assert.equal(quotaExceeded, false);

      const storageDenied = saveSettingsToStorage(createDefaultSettings(), () => {
        throw new Error('SecurityError');
      });
      assert.equal(storageDenied, false);
      assert.equal(warnCount, 2);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('validateSettingsBeforeProcess, computeRatioMaskRect, and hasCropOverlapWithImage', () => {
  it('accepts valid defaults and rejects invalid colCount, offsets, colors, crop, and zero-area masks with target accordion/fields', () => {
    assert.deepEqual(validateSettingsBeforeProcess(createDefaultSettings()), { valid: true });

    const invalidCols = { ...createDefaultSettings(), colCount: 0 };
    assert.deepEqual(validateSettingsBeforeProcess(invalidCols), {
      valid: false,
      alertKey: 'alert_columns_must_be_positive',
      accordion: 'settings',
      fields: ['colCount'],
    });

    const fractionalCols = { ...createDefaultSettings(), colCount: 2.5 };
    assert.deepEqual(validateSettingsBeforeProcess(fractionalCols), {
      valid: false,
      alertKey: 'alert_columns_must_be_positive',
      accordion: 'settings',
      fields: ['colCount'],
    });

    const invalidOffset = { ...createDefaultSettings(), offsetY: -1 };
    assert.deepEqual(validateSettingsBeforeProcess(invalidOffset), {
      valid: false,
      alertKey: 'alert_offset_cannot_be_empty_or_negative',
      accordion: 'settings',
      fields: ['offsetX'],
    });

    const fractionalOffsetX = { ...createDefaultSettings(), offsetX: 1.5 };
    assert.deepEqual(validateSettingsBeforeProcess(fractionalOffsetX), {
      valid: false,
      alertKey: 'alert_offset_cannot_be_empty_or_negative',
      accordion: 'settings',
      fields: ['offsetX'],
    });

    const fractionalOffsetY = { ...createDefaultSettings(), offsetY: 2.5 };
    assert.deepEqual(validateSettingsBeforeProcess(fractionalOffsetY), {
      valid: false,
      alertKey: 'alert_offset_cannot_be_empty_or_negative',
      accordion: 'settings',
      fields: ['offsetX'],
    });

    const oversizedOffsetX = { ...createDefaultSettings(), offsetX: MAX_OFFSET_PX + 1 };
    assert.deepEqual(validateSettingsBeforeProcess(oversizedOffsetX), {
      valid: false,
      alertKey: 'alert_offset_cannot_be_empty_or_negative',
      accordion: 'settings',
      fields: ['offsetX'],
    });

    const oversizedOffsetY = { ...createDefaultSettings(), offsetY: MAX_OFFSET_PX + 1 };
    assert.deepEqual(validateSettingsBeforeProcess(oversizedOffsetY), {
      valid: false,
      alertKey: 'alert_offset_cannot_be_empty_or_negative',
      accordion: 'settings',
      fields: ['offsetX'],
    });

    assert.deepEqual(
      validateSettingsBeforeProcess({
        ...createDefaultSettings(),
        offsetX: MIN_OFFSET_PX,
        offsetY: MAX_OFFSET_PX,
      }),
      { valid: true }
    );

    const transparentBg = { ...createDefaultSettings(), bgColor: 'transparent' };
    assert.deepEqual(validateSettingsBeforeProcess(transparentBg), {
      valid: false,
      alertKey: 'alert_invalid_color_setting',
      accordion: 'settings',
      fields: ['bgColor'],
    });

    const inactiveBadMaskColor = { ...createDefaultSettings(), maskEnabled: false, maskColor: 'transparent' };
    assert.deepEqual(validateSettingsBeforeProcess(inactiveBadMaskColor), { valid: true });

    const activeBadMaskColor = { ...createDefaultSettings(), maskEnabled: true, maskColor: 'transparent' };
    assert.deepEqual(validateSettingsBeforeProcess(activeBadMaskColor), {
      valid: false,
      alertKey: 'alert_invalid_color_setting',
      accordion: 'mask',
      fields: ['maskColor'],
    });

    const activeBadSelfMaskColor = {
      ...createDefaultSettings(),
      selfMaskEnabled: true,
      selfMaskColor: 'invalid',
    };
    assert.deepEqual(validateSettingsBeforeProcess(activeBadSelfMaskColor), {
      valid: false,
      alertKey: 'alert_invalid_color_setting',
      accordion: 'selfMask',
      fields: ['selfMaskColor'],
    });

    const zeroManualCrop = { ...createDefaultSettings(), cropAuto: false, cropX: -1, cropWidth: 0 };
    assert.deepEqual(validateSettingsBeforeProcess(zeroManualCrop), {
      valid: false,
      alertKey: 'alert_invalid_crop_setting',
      accordion: 'crop',
      fields: ['cropX', 'cropWidth'],
    });

    const invalidCropIgnoredWhenAuto = { ...createDefaultSettings(), cropAuto: true, cropWidth: 0 };
    assert.deepEqual(validateSettingsBeforeProcess(invalidCropIgnoredWhenAuto), { valid: true });

    const zeroRatioEnemyMask = {
      ...createDefaultSettings(),
      maskEnabled: true,
      maskMode: 'ratio',
      maskRatioRect: { rx0: 0.5, ry0: 0.1, rx1: 0.5, ry1: 0.3 },
    };
    assert.deepEqual(validateSettingsBeforeProcess(zeroRatioEnemyMask), {
      valid: false,
      alertKey: 'alert_invalid_mask_area',
      accordion: 'mask',
      fields: ['maskRatioRect.rx0', 'maskRatioRect.rx1'],
    });

    const zeroManualSelfMask = {
      ...createDefaultSettings(),
      selfMaskEnabled: true,
      selfMaskMode: 'manual',
      selfMaskHeight: 0,
    };
    assert.deepEqual(validateSettingsBeforeProcess(zeroManualSelfMask), {
      valid: false,
      alertKey: 'alert_invalid_mask_area',
      accordion: 'selfMask',
      fields: ['selfMaskHeight'],
    });
  });

  it('resolves canvas size error UI targets for WebP limits and general overflow', () => {
    assert.deepEqual(resolveCanvasSizeErrorUiTarget('exceeds_webp_dimension', true), {
      accordions: ['settings'],
      fields: ['outputFormat', 'colCount'],
    });
    assert.deepEqual(resolveCanvasSizeErrorUiTarget('non_positive_or_overflow', true), {
      accordions: ['settings'],
      fields: ['colCount', 'offsetX'],
    });
    assert.deepEqual(resolveCanvasSizeErrorUiTarget('non_positive_or_overflow', false), {
      accordions: ['settings', 'crop'],
      fields: ['colCount', 'offsetX', 'cropWidth', 'cropHeight'],
    });
  });

  it('computes ratio masks and returns null when equal or collapsed to 0 px after rounding', () => {
    const valid = computeRatioMaskRect(
      { rx0: 0.25, ry0: 0.1, rx1: 0.75, ry1: 0.3 },
      { x: 100, y: 50, width: 800, height: 600 }
    );
    assert.deepEqual(valid, { x: 300, y: 110, width: 400, height: 120 });

    assert.equal(
      computeRatioMaskRect(
        { rx0: 0.5, ry0: 0.1, rx1: 0.5, ry1: 0.4 },
        { x: 0, y: 0, width: 1000, height: 1000 }
      ),
      null
    );

    // Collapses width to 0 px after rounding against small crop width
    assert.equal(
      computeRatioMaskRect(
        { rx0: 0.5, ry0: 0.1, rx1: 0.501, ry1: 0.4 },
        { x: 0, y: 0, width: 100, height: 100 }
      ),
      null
    );
  });

  it('allows partial crop overhang while rejecting zero overlap with image bounds', () => {
    const image = { width: 1600, height: 900 };
    assert.equal(hasCropOverlapWithImage({ x: 31, y: 117, width: 1538, height: 665 }, image), true);
    // Partial overhang on right/bottom should be tolerated
    assert.equal(hasCropOverlapWithImage({ x: 1500, y: 800, width: 300, height: 300 }, image), true);
    // Completely outside right or bottom edge must fail
    assert.equal(hasCropOverlapWithImage({ x: 1600, y: 100, width: 200, height: 200 }, image), false);
    assert.equal(hasCropOverlapWithImage({ x: 100, y: 900, width: 200, height: 200 }, image), false);
    assert.equal(hasCropOverlapWithImage({ x: 0, y: 0, width: 0, height: 200 }, image), false);
  });

  it('computes intersecting pixel rectangles and returns null for disjoint or empty rects', () => {
    assert.deepEqual(
      intersectPixelRects(
        { x: 0, y: 100, width: 100, height: 100 },
        { x: 31, y: 117, width: 1538, height: 665 }
      ),
      { x: 31, y: 117, width: 69, height: 83 }
    );
    // Disjoint default manual mask (y=0..100) vs default crop (y=117..782)
    assert.equal(
      intersectPixelRects(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 31, y: 117, width: 1538, height: 665 }
      ),
      null
    );
    // Touching edges without area overlap
    assert.equal(
      intersectPixelRects(
        { x: 0, y: 17, width: 100, height: 100 },
        { x: 31, y: 117, width: 1538, height: 665 }
      ),
      null
    );
    assert.equal(
      intersectPixelRects(
        { x: 10, y: 10, width: 0, height: 50 },
        { x: 0, y: 0, width: 100, height: 100 }
      ),
      null
    );
  });

  it('swaps inverted ratio endpoints on finalize instead of collapsing width or height to 0', () => {
    const initial = { rx0: 0.5, ry0: 0.2, rx1: 0.8, ry1: 0.6 };

    // Mid-edit keeps raw endpoints so user can finish typing without field jumping
    const midEdit = commitRatioRectField(initial, 'rx0', 0.9, { finalize: false });
    assert.deepEqual(midEdit, { rx0: 0.9, ry0: 0.2, rx1: 0.8, ry1: 0.6 });

    // Blur/Enter finalize swaps Left (0.9) and Right (0.8) -> [0.8, 0.9]
    const finalizedLeft = commitRatioRectField(initial, 'rx0', 0.9, { finalize: true });
    assert.deepEqual(finalizedLeft, { rx0: 0.8, ry0: 0.2, rx1: 0.9, ry1: 0.6 });

    // Entering Right < Left swaps into [0.3, 0.5]
    const finalizedRight = commitRatioRectField(initial, 'rx1', 0.3, { finalize: true });
    assert.deepEqual(finalizedRight, { rx0: 0.3, ry0: 0.2, rx1: 0.5, ry1: 0.6 });

    // Entering Top > Bottom swaps into [0.6, 0.75]
    const finalizedTop = commitRatioRectField(initial, 'ry0', 0.75, { finalize: true });
    assert.deepEqual(finalizedTop, { rx0: 0.5, ry0: 0.6, rx1: 0.8, ry1: 0.75 });

    // Entering Bottom < Top swaps into [0.1, 0.2]
    const finalizedBottom = commitRatioRectField(initial, 'ry1', 0.1, { finalize: true });
    assert.deepEqual(finalizedBottom, { rx0: 0.5, ry0: 0.1, rx1: 0.8, ry1: 0.2 });

    // Resulting swapped rect stays valid for process validation
    assert.deepEqual(
      validateSettingsBeforeProcess({
        ...createDefaultSettings(),
        maskEnabled: true,
        maskMode: 'ratio',
        maskRatioRect: finalizedLeft,
      }),
      { valid: true }
    );

    assert.deepEqual(normalizeRatioRect({ rx0: 1.4, ry0: 0.9, rx1: -0.2, ry1: 0.3 }), {
      rx0: 0,
      ry0: 0.3,
      rx1: 1,
      ry1: 0.9,
    });
  });
});

describe('formatRatioPercent', () => {
  it('formats 0..1 ratio values as compact percentages without float noise', () => {
    assert.equal(formatRatioPercent(0), '0%');
    assert.equal(formatRatioPercent(0.14), '14%');
    assert.equal(formatRatioPercent(0.269), '26.9%');
    assert.equal(formatRatioPercent(0.785), '78.5%');
    assert.equal(formatRatioPercent(1), '100%');
    assert.equal(formatRatioPercent(-0.2), '0%');
    assert.equal(formatRatioPercent(1.5), '100%');
    assert.equal(formatRatioPercent(Number.NaN), '0%');
  });
});

describe('ratioToPercentInput / percentInputToRatio', () => {
  it('converts ratios to percent input values without float noise', () => {
    assert.equal(ratioToPercentInput(0), 0);
    assert.equal(ratioToPercentInput(0.785), 78.5);
    assert.equal(ratioToPercentInput(0.14), 14);
    assert.equal(ratioToPercentInput(0.1 + 0.2), 30);
    assert.equal(ratioToPercentInput(0.7555), 75.55);
    assert.equal(ratioToPercentInput(1), 100);
  });

  it('converts percent input values back to ratios without float noise', () => {
    assert.equal(percentInputToRatio(0), 0);
    assert.equal(percentInputToRatio(75.5), 0.755);
    assert.equal(percentInputToRatio(78.5), 0.785);
    assert.equal(percentInputToRatio(14), 0.14);
    assert.equal(percentInputToRatio(33.3333), 0.333333);
    assert.equal(percentInputToRatio(100), 1);
  });

  it('round-trips every 0.1% step of the ratio slider', () => {
    for (let i = 0; i <= 1000; i += 1) {
      const ratio = i / 1000;
      assert.equal(percentInputToRatio(ratioToPercentInput(ratio)), ratio);
    }
  });
});

describe('computeRatioMaskOverlayBox', () => {
  it('computes clamped CSS percentages and rejects collapsed or invalid rectangles', () => {
    const normal = computeRatioMaskOverlayBox({ rx0: 0.785, ry0: 0.14, rx1: 1, ry1: 0.2 });
    assert.ok(normal !== null);
    assert.ok(Math.abs(normal.leftPct - 78.5) < 1e-9);
    assert.ok(Math.abs(normal.topPct - 14) < 1e-9);
    assert.ok(Math.abs(normal.widthPct - 21.5) < 1e-9);
    assert.ok(Math.abs(normal.heightPct - 6) < 1e-9);

    assert.deepEqual(computeRatioMaskOverlayBox({ rx0: 0.5, ry0: 0.4, rx1: 0.2, ry1: 0.1 }), {
      leftPct: 20,
      topPct: 10,
      widthPct: 30,
      heightPct: 30,
    });

    assert.equal(computeRatioMaskOverlayBox({ rx0: 0.5, ry0: 0.1, rx1: 0.5, ry1: 0.4 }), null);
    assert.equal(computeRatioMaskOverlayBox({ rx0: 0.1, ry0: 0.2, rx1: 0.5, ry1: 0.2 }), null);
    assert.equal(computeRatioMaskOverlayBox({ rx0: Number.NaN, ry0: 0.1, rx1: 0.5, ry1: 0.4 }), null);
  });
});
