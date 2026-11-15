import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImageDecodeError,
  ImageResolutionMismatchError,
  MONTAGE_MEMORY_RELEASE_DELAY_MS,
  OCR_MEMORY_RELEASE_DELAY_MS,
  buildTileMaskRects,
  decodeImageWithFallback,
  getMemoryReleaseDelayMs,
  prepareMontagePlan,
  renderMontageTiles,
  renderMontageToBlob,
  resolveOutputExtension,
} from '../src/montageHelpers.ts';
import { areSettingsDefault, createDefaultSettings } from '../src/settingsHelpers.ts';

function createMockTempCanvas({ returnNullContext = false, throwOnDraw = false } = {}) {
  const widthWrites = [];
  const heightWrites = [];
  const ops = [];
  let currentWidth = 0;
  let currentHeight = 0;

  const ctx = {
    _fillStyle: '#000000',
    get fillStyle() {
      return this._fillStyle;
    },
    set fillStyle(v) {
      this._fillStyle = v;
      ops.push({ type: 'fillStyle', value: v });
    },
    clearRect(x, y, w, h) {
      ops.push({ type: 'clearRect', args: [x, y, w, h] });
    },
    drawImage(...args) {
      if (throwOnDraw) {
        throw new Error('simulated temp draw error');
      }
      ops.push({ type: 'tempDrawImage', args });
    },
    fillRect(x, y, w, h) {
      ops.push({ type: 'fillRect', color: this._fillStyle, args: [x, y, w, h] });
    },
  };

  const contextCalls = [];
  const canvas = {
    get width() {
      return currentWidth;
    },
    set width(v) {
      currentWidth = v;
      widthWrites.push(v);
    },
    get height() {
      return currentHeight;
    },
    set height(v) {
      currentHeight = v;
      heightWrites.push(v);
    },
    getContext(id, options) {
      contextCalls.push({ id, options });
      return returnNullContext ? null : ctx;
    },
  };

  return { canvas, ctx, ops, widthWrites, heightWrites, contextCalls };
}

describe('buildTileMaskRects', () => {
  it('translates enabled positive masks to crop-relative coordinates and skips disabled/empty ones', () => {
    const masks = buildTileMaskRects({
      cropRect: { x: 100, y: 50, width: 800, height: 600 },
      maskEnabled: true,
      maskRect: { x: 140, y: 80, width: 120, height: 30 },
      maskColor: '#112233',
      selfMaskEnabled: true,
      selfMaskRect: { x: 500, y: 200, width: 0, height: 30 },
      selfMaskColor: '#445566',
    });

    assert.deepEqual(masks, [
      { x: 40, y: 30, width: 120, height: 30, color: '#112233' },
    ]);

    const both = buildTileMaskRects({
      cropRect: { x: 10, y: 20, width: 400, height: 300 },
      maskEnabled: true,
      maskRect: { x: 30, y: 40, width: 50, height: 20 },
      maskColor: '#000000',
      selfMaskEnabled: true,
      selfMaskRect: { x: 200, y: 100, width: 60, height: 25 },
      selfMaskColor: '#ffffff',
    });

    assert.deepEqual(both, [
      { x: 20, y: 20, width: 50, height: 20, color: '#000000' },
      { x: 190, y: 80, width: 60, height: 25, color: '#ffffff' },
    ]);
  });

  it('clips partially overlapping masks to crop bounds and skips disjoint masks', () => {
    const masks = buildTileMaskRects({
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      maskEnabled: true,
      maskRect: { x: 0, y: 100, width: 100, height: 100 },
      maskColor: '#112233',
      selfMaskEnabled: true,
      selfMaskRect: { x: 0, y: 0, width: 100, height: 100 },
      selfMaskColor: '#445566',
    });

    assert.deepEqual(masks, [
      { x: 0, y: 0, width: 69, height: 83, color: '#112233' },
    ]);
  });
});

const createMockMontageContext = ({ throwOnDraw = false, events } = {}) => {
  const ops = [];
  let fillStyle = '#000000';
  return {
    ops,
    ctx: {
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(v) {
        fillStyle = v;
      },
      drawImage(...args) {
        if (throwOnDraw) {
          throw new Error('montage draw failed');
        }
        ops.push({ type: 'drawImage', args });
        events?.push({ type: 'montageDrawImage', args });
      },
      fillRect(x, y, width, height) {
        ops.push({ type: 'fillRect', color: fillStyle, args: [x, y, width, height] });
        events?.push({ type: 'montageFillRect', color: fillStyle, args: [x, y, width, height] });
      },
    },
  };
};

describe('renderMontageTiles', () => {
  it('draws directly onto montageCtx without touching fillRect when no masks are active', async () => {
    const events = [];
    const montage = createMockMontageContext({ events });

    await renderMontageTiles({
      files: ['img-0', 'img-1', 'img-2'],
      colCount: 2,
      offsetX: 10,
      offsetY: 20,
      cropRect: { x: 5, y: 15, width: 100, height: 80 },
      masks: [],
      decodeImage: async (file) => ({
        id: file,
        close() {
          events.push({ type: 'close', id: file });
        },
      }),
      montageCtx: montage.ctx,
      yieldFrame: async () => {
        events.push({ type: 'yield' });
      },
    });

    assert.equal(
      montage.ops.filter((op) => op.type === 'fillRect').length,
      0
    );
    assert.deepEqual(
      events.filter((e) => e.type !== 'montageDrawImage'),
      [
        { type: 'close', id: 'img-0' },
        { type: 'yield' },
        { type: 'close', id: 'img-1' },
        { type: 'yield' },
        { type: 'close', id: 'img-2' },
        { type: 'yield' },
      ]
    );

    const drawCalls = events.filter((e) => e.type === 'montageDrawImage').map((e) => e.args);
    assert.equal(drawCalls.length, 3);
    assert.deepEqual(drawCalls[0].slice(1), [5, 15, 100, 80, 10, 20, 100, 80]);
    assert.deepEqual(drawCalls[1].slice(1), [5, 15, 100, 80, 120, 20, 100, 80]);
    assert.deepEqual(drawCalls[2].slice(1), [5, 15, 100, 80, 10, 120, 100, 80]);
  });

  it('guarantees ImageBitmap.close runs in finally when direct drawImage throws', async () => {
    const montage = createMockMontageContext({ throwOnDraw: true });
    let closed = false;

    await assert.rejects(
      () =>
        renderMontageTiles({
          files: ['img-0'],
          colCount: 1,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          masks: [{ x: 10, y: 10, width: 20, height: 20, color: '#000000' }],
          decodeImage: async () => ({
            close() {
              closed = true;
            },
          }),
          montageCtx: montage.ctx,
          yieldFrame: async () => {},
        }),
      /montage draw failed/
    );

    assert.equal(closed, true);
    assert.equal(montage.ops.filter((op) => op.type === 'fillRect').length, 0);
  });

  it('draws tiles and clipped masks directly onto montageCtx without allocating a temp canvas', async () => {
    const lifecycle = [];
    const montage = createMockMontageContext({ events: lifecycle });

    await renderMontageTiles({
      files: ['a', 'b', 'c'],
      colCount: 2,
      offsetX: 8,
      offsetY: 12,
      cropRect: { x: 10, y: 20, width: 200, height: 150 },
      masks: [
        { x: 30, y: 40, width: 50, height: 20, color: '#112233' },
        { x: 10, y: 15, width: 40, height: 12, color: '#ffffff' },
      ],
      decodeImage: async (name) => ({
        name,
        close() {
          lifecycle.push({ type: 'close', name });
        },
      }),
      montageCtx: montage.ctx,
      yieldFrame: async () => {
        lifecycle.push({ type: 'yield' });
      },
    });

    assert.deepEqual(
      lifecycle.map((e) => e.type),
      [
        'montageDrawImage',
        'close',
        'montageFillRect',
        'montageFillRect',
        'yield',
        'montageDrawImage',
        'close',
        'montageFillRect',
        'montageFillRect',
        'yield',
        'montageDrawImage',
        'close',
        'montageFillRect',
        'montageFillRect',
        'yield',
      ]
    );

    const drawCalls = montage.ops.filter((op) => op.type === 'drawImage').map((op) => op.args);
    assert.deepEqual(drawCalls[0].slice(1), [10, 20, 200, 150, 8, 12, 200, 150]);
    assert.deepEqual(drawCalls[1].slice(1), [10, 20, 200, 150, 216, 12, 200, 150]);
    assert.deepEqual(drawCalls[2].slice(1), [10, 20, 200, 150, 8, 174, 200, 150]);

    const fillCalls = montage.ops.filter((op) => op.type === 'fillRect');
    assert.deepEqual(fillCalls, [
      { type: 'fillRect', color: '#112233', args: [38, 52, 50, 20] },
      { type: 'fillRect', color: '#ffffff', args: [18, 27, 40, 12] },
      { type: 'fillRect', color: '#112233', args: [246, 52, 50, 20] },
      { type: 'fillRect', color: '#ffffff', args: [226, 27, 40, 12] },
      { type: 'fillRect', color: '#112233', args: [38, 214, 50, 20] },
      { type: 'fillRect', color: '#ffffff', args: [18, 189, 40, 12] },
    ]);
  });

  it('clips unclipped tile masks to tile bounds so masks cannot paint into offsets or neighbor tiles', async () => {
    const montage = createMockMontageContext();

    await renderMontageTiles({
      files: ['a'],
      colCount: 1,
      offsetX: 10,
      offsetY: 15,
      cropRect: { x: 0, y: 0, width: 200, height: 100 },
      masks: [
        { x: -10, y: 20, width: 50, height: 150, color: '#000000' },
        { x: 250, y: 0, width: 20, height: 20, color: '#ff0000' },
      ],
      decodeImage: async () => ({ close() {} }),
      montageCtx: montage.ctx,
      yieldFrame: async () => {},
    });

    const fillCalls = montage.ops.filter((op) => op.type === 'fillRect');
    assert.deepEqual(fillCalls, [
      { type: 'fillRect', color: '#000000', args: [10, 35, 40, 80] },
    ]);
  });

  it('returns immediately on empty file list without drawing or filling masks', async () => {
    const montage = createMockMontageContext();

    await renderMontageTiles({
      files: [],
      colCount: 2,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [{ x: 0, y: 0, width: 10, height: 10, color: '#000000' }],
      decodeImage: async () => {
        throw new Error('should not decode');
      },
      montageCtx: montage.ctx,
    });

    assert.equal(montage.ops.length, 0);
  });

  it('rejects images whose dimensions differ from expectedDimensions and still closes bitmaps', async () => {
    const montage = createMockMontageContext();
    const closed = [];
    const decoded = [];

    await assert.rejects(
      () =>
        renderMontageTiles({
          files: [{ name: 'ok.png' }, { name: 'wrong.png' }, { name: 'unreached.png' }],
          colCount: 2,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          masks: [{ x: 0, y: 0, width: 10, height: 10, color: '#000000' }],
          expectedDimensions: { width: 1920, height: 1080 },
          getFileName: (f) => f.name,
          decodeImage: async (f) => {
            decoded.push(f.name);
            const size =
              f.name === 'wrong.png'
                ? { width: 1280, height: 720 }
                : { width: 1920, height: 1080 };
            return {
              ...size,
              close() {
                closed.push(f.name);
              },
            };
          },
          montageCtx: montage.ctx,
          yieldFrame: async () => {},
        }),
      (err) =>
        err instanceof ImageResolutionMismatchError &&
        err.fileName === 'wrong.png' &&
        err.expectedWidth === 1920 &&
        err.expectedHeight === 1080 &&
        err.actualWidth === 1280 &&
        err.actualHeight === 720
    );

    assert.deepEqual(decoded, ['ok.png', 'wrong.png']);
    assert.deepEqual(closed, ['ok.png', 'wrong.png']);
    assert.equal(montage.ops.filter((op) => op.type === 'drawImage').length, 1);
    assert.equal(montage.ops.filter((op) => op.type === 'fillRect').length, 1);
  });

  it('passes 0-based index to decodeImage so a pre-decoded first bitmap can be reused cleanly', async () => {
    const events = [];
    const montage = createMockMontageContext({ events });
    let firstBitmap = {
      id: 'predecoded-first',
      close() {
        events.push({ type: 'close', id: 'predecoded-first' });
      },
    };
    const decodeCalls = [];

    await renderMontageTiles({
      files: ['first.png', 'second.png'],
      colCount: 2,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 80 },
      masks: [],
      decodeImage: async (file, index) => {
        decodeCalls.push([file, index]);
        if (index === 0 && firstBitmap) {
          const reused = firstBitmap;
          firstBitmap = null;
          return reused;
        }
        return {
          id: `decoded-${file}`,
          close() {
            events.push({ type: 'close', id: `decoded-${file}` });
          },
        };
      },
      montageCtx: montage.ctx,
      yieldFrame: async () => {
        events.push({ type: 'yield' });
      },
    });

    assert.equal(firstBitmap, null);
    assert.deepEqual(decodeCalls, [
      ['first.png', 0],
      ['second.png', 1],
    ]);
    const drawCalls = montage.ops.filter((op) => op.type === 'drawImage').map((op) => op.args);
    assert.equal(drawCalls[0][0].id, 'predecoded-first');
    assert.equal(drawCalls[1][0].id, 'decoded-second.png');
    assert.deepEqual(
      events.filter((e) => e.type !== 'montageDrawImage'),
      [
        { type: 'close', id: 'predecoded-first' },
        { type: 'yield' },
        { type: 'close', id: 'decoded-second.png' },
        { type: 'yield' },
      ]
    );
  });
});

describe('decodeImageWithFallback', () => {
  it('returns the primary ImageBitmap when createImageBitmap succeeds', async () => {
    const bitmap = { close() {} };
    let fallbackUsed = false;

    const result = await decodeImageWithFallback(
      { name: 'ok.png' },
      {
        primaryDecode: async () => bitmap,
        createObjectURL: () => {
          fallbackUsed = true;
          return 'blob:unused';
        },
      }
    );

    assert.equal(result, bitmap);
    assert.equal(fallbackUsed, false);
  });

  it('falls back to Image + temporary canvas when primary decoding fails, cleaning up URL and canvas', async () => {
    const fallbackBitmap = { close() {} };
    const revokedUrls = [];
    const sleptMs = [];
    const fallbackCanvas = createMockTempCanvas();
    let drawnImage = null;

    fallbackCanvas.ctx.drawImage = (img, dx, dy) => {
      drawnImage = { img, dx, dy };
    };

    const result = await decodeImageWithFallback(
      { name: 'retry.webp' },
      {
        primaryDecode: async () => {
          throw new Error('primary decode glitch');
        },
        onPrimaryError: () => {},
        retryDelayMs: 200,
        sleep: async (ms) => {
          sleptMs.push(ms);
        },
        createObjectURL: () => 'blob:mock-1',
        revokeObjectURL: (url) => {
          revokedUrls.push(url);
        },
        createImage: () => {
          const img = {
            decoding: '',
            naturalWidth: 640,
            naturalHeight: 480,
            onload: null,
            onerror: null,
            _src: '',
            get src() {
              return this._src;
            },
            set src(v) {
              this._src = v;
              queueMicrotask(() => img.onload?.());
            },
          };
          return img;
        },
        createCanvas: () => fallbackCanvas.canvas,
        decodeCanvas: async (c) => {
          assert.equal(c, fallbackCanvas.canvas);
          assert.equal(c.width, 640);
          assert.equal(c.height, 480);
          return fallbackBitmap;
        },
      }
    );

    assert.equal(result, fallbackBitmap);
    assert.deepEqual(sleptMs, [200]);
    assert.deepEqual(revokedUrls, ['blob:mock-1']);
    assert.deepEqual(fallbackCanvas.contextCalls, [
      { id: '2d', options: { willReadFrequently: true, alpha: false } },
    ]);
    assert.deepEqual(fallbackCanvas.widthWrites, [640, 1]);
    assert.deepEqual(fallbackCanvas.heightWrites, [480, 1]);
    assert.equal(drawnImage.dx, 0);
    assert.equal(drawnImage.dy, 0);
  });

  it('throws ImageDecodeError naming the failed file and still cleans up resources when both paths fail', async () => {
    const revokedUrls = [];
    const fallbackCanvas = createMockTempCanvas();

    await assert.rejects(
      () =>
        decodeImageWithFallback(
          { name: 'corrupt-sample.png' },
          {
            primaryDecode: async () => {
              throw new Error('primary failed');
            },
            onPrimaryError: () => {},
            retryDelayMs: 0,
            createObjectURL: () => 'blob:mock-2',
            revokeObjectURL: (url) => {
              revokedUrls.push(url);
            },
            createImage: () => {
              const img = {
                decoding: '',
                naturalWidth: 100,
                naturalHeight: 100,
                onload: null,
                onerror: null,
                _src: '',
                get src() {
                  return this._src;
                },
                set src(v) {
                  this._src = v;
                  queueMicrotask(() => img.onload?.());
                },
              };
              return img;
            },
            createCanvas: () => fallbackCanvas.canvas,
            decodeCanvas: async () => {
              throw new Error('canvas decode failed');
            },
          }
        ),
      (err) => err instanceof ImageDecodeError && err.fileName === 'corrupt-sample.png'
    );

    assert.deepEqual(revokedUrls, ['blob:mock-2']);
    assert.equal(fallbackCanvas.canvas.width, 1);
    assert.equal(fallbackCanvas.canvas.height, 1);
  });

  it('throws ImageDecodeError when fallback image triggers onerror without leaking the object URL', async () => {
    const revokedUrls = [];

    await assert.rejects(
      () =>
        decodeImageWithFallback(
          { name: 'bad-file.png' },
          {
            primaryDecode: async () => {
              throw new Error('primary failed');
            },
            onPrimaryError: () => {},
            retryDelayMs: 0,
            createObjectURL: () => 'blob:mock-3',
            revokeObjectURL: (url) => {
              revokedUrls.push(url);
            },
            createImage: () => {
              const img = {
                decoding: '',
                naturalWidth: 0,
                naturalHeight: 0,
                onload: null,
                onerror: null,
                _src: '',
                get src() {
                  return this._src;
                },
                set src(v) {
                  this._src = v;
                  queueMicrotask(() => img.onerror?.());
                },
              };
              return img;
            },
          }
        ),
      (err) => err instanceof ImageDecodeError && err.fileName === 'bad-file.png'
    );

    assert.deepEqual(revokedUrls, ['blob:mock-3']);
  });
});

describe('resolveOutputExtension', () => {
  it('uses actual Blob MIME type when canvas.toBlob falls back to PNG', () => {
    assert.equal(resolveOutputExtension('image/png', 'webp'), 'png');
    assert.equal(resolveOutputExtension('IMAGE/PNG', 'jpeg'), 'png');
  });

  it('normalizes MIME parameters, whitespace, and JPEG extensions', () => {
    assert.equal(resolveOutputExtension('image/webp; codecs=vp8', 'webp'), 'webp');
    assert.equal(resolveOutputExtension(' image/jpeg ', 'png'), 'jpg');
    assert.equal(resolveOutputExtension('image/jpg', 'jpeg'), 'jpg');
  });

  it('falls back to the requested format when Blob.type is empty or unrecognized', () => {
    assert.equal(resolveOutputExtension('', 'webp'), 'webp');
    assert.equal(resolveOutputExtension(undefined, 'png'), 'png');
    assert.equal(resolveOutputExtension(null, 'jpeg'), 'jpg');
    assert.equal(resolveOutputExtension('application/octet-stream', 'jpeg'), 'jpg');
  });
});

describe('prepareMontagePlan', () => {
  it('preserves ocr maskMode on not_found failure so retrying re-runs OCR instead of using stale (-31, -117) manual coords', async () => {
    let settings = {
      ...createDefaultSettings(),
      cropAuto: false,
      maskEnabled: true,
      maskMode: 'ocr',
      selfMaskEnabled: true,
      selfMaskMode: 'ocr',
    };

    let ocrCalls = 0;
    const plan1 = await prepareMontagePlan({
      settings,
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async () => {
        ocrCalls += 1;
        return { status: 'not_found', enemyMissing: true, selfMissing: false };
      },
    });

    assert.equal(plan1.status, 'abort');
    assert.deepEqual(plan1.alert, {
      kind: 'ocr_not_found',
      enemyMissing: true,
      selfMissing: false,
    });
    assert.equal(plan1.settingsPatch.maskMode, undefined);
    assert.equal(plan1.settingsPatch.selfMaskMode, undefined);

    settings = { ...settings, ...plan1.settingsPatch };
    assert.equal(settings.maskMode, 'ocr');
    assert.equal(settings.selfMaskMode, 'ocr');

    const plan2 = await prepareMontagePlan({
      settings,
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async ({ needsEnemyOcr, needsSelfOcr }) => {
        ocrCalls += 1;
        assert.equal(needsEnemyOcr, true);
        assert.equal(needsSelfOcr, true);
        return {
          status: 'ok',
          enemyMaskRect: { x: 950, y: 200, width: 140, height: 32 },
          selfMaskRect: { x: 180, y: 210, width: 120, height: 32 },
        };
      },
    });

    assert.equal(ocrCalls, 2);
    assert.equal(plan2.status, 'ok');
    assert.deepEqual(plan2.tileMasks, [
      { x: 919, y: 83, width: 140, height: 32, color: settings.maskColor },
      { x: 149, y: 93, width: 120, height: 32, color: settings.selfMaskColor },
    ]);
  });

  it('preserves ocr maskMode across error and aborted outcomes before a successful retry', async () => {
    let settings = {
      ...createDefaultSettings(),
      maskEnabled: true,
      maskMode: 'ocr',
      selfMaskEnabled: false,
    };
    const detectAutoCrop = () => ({
      status: 'ok',
      rect: { x: 31, y: 117, width: 1538, height: 665 },
    });

    const err = new Error('worker crashed');
    const errorPlan = await prepareMontagePlan({
      settings,
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop,
      detectOcrMasks: async () => ({ status: 'error', error: err }),
    });
    assert.equal(errorPlan.status, 'abort');
    assert.deepEqual(errorPlan.alert, { kind: 'ocr_error', error: err });
    settings = { ...settings, ...errorPlan.settingsPatch };
    assert.equal(settings.maskMode, 'ocr');

    const abortedPlan = await prepareMontagePlan({
      settings,
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop,
      detectOcrMasks: async () => ({ status: 'aborted' }),
    });
    assert.equal(abortedPlan.status, 'abort');
    assert.deepEqual(abortedPlan.alert, { kind: 'ocr_aborted' });
    settings = { ...settings, ...abortedPlan.settingsPatch };
    assert.equal(settings.maskMode, 'ocr');

    let retryOcrRan = false;
    const retryPlan = await prepareMontagePlan({
      settings,
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop,
      detectOcrMasks: async () => {
        retryOcrRan = true;
        return {
          status: 'ok',
          enemyMaskRect: { x: 1000, y: 220, width: 150, height: 30 },
          selfMaskRect: null,
        };
      },
    });

    assert.equal(retryOcrRan, true);
    assert.equal(retryPlan.status, 'ok');
    assert.deepEqual(retryPlan.tileMasks, [
      { x: 969, y: 103, width: 150, height: 30, color: settings.maskColor },
    ]);
  });

  it('aborts with mask_outside_crop when manual mask or selfMask does not overlap cropRect', async () => {
    let ocrCalled = false;

    const enemyOutPlan = await prepareMontagePlan({
      settings: {
        ...createDefaultSettings(),
        cropAuto: false,
        maskEnabled: true,
        maskMode: 'manual',
        // default maskX=0, maskY=0, maskWidth=100, maskHeight=100 vs cropY=117
        selfMaskEnabled: true,
        selfMaskMode: 'ocr',
      },
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async () => {
        ocrCalled = true;
        return { status: 'not_found', enemyMissing: false, selfMissing: false };
      },
    });

    assert.equal(enemyOutPlan.status, 'abort');
    assert.deepEqual(enemyOutPlan.alert, { kind: 'mask_outside_crop' });
    assert.equal(ocrCalled, false);

    const selfOutPlan = await prepareMontagePlan({
      settings: {
        ...createDefaultSettings(),
        maskEnabled: true,
        maskMode: 'ratio',
        selfMaskEnabled: true,
        selfMaskMode: 'manual',
        selfMaskX: 1600,
        selfMaskY: 200,
        selfMaskWidth: 100,
        selfMaskHeight: 50,
      },
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({
        status: 'ok',
        rect: { x: 31, y: 117, width: 1538, height: 665 },
      }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });

    assert.equal(selfOutPlan.status, 'abort');
    assert.deepEqual(selfOutPlan.alert, { kind: 'mask_outside_crop' });

    const zeroAreaPlan = await prepareMontagePlan({
      settings: {
        ...createDefaultSettings(),
        cropAuto: false,
        maskEnabled: true,
        maskMode: 'manual',
        maskWidth: 0,
      },
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });

    assert.equal(zeroAreaPlan.status, 'abort');
    assert.deepEqual(zeroAreaPlan.alert, { kind: 'invalid_mask_area' });
  });

  it('clips partially overlapping manual mask to cropRect without mutating manual mask coordinates', async () => {
    const plan = await prepareMontagePlan({
      settings: {
        ...createDefaultSettings(),
        cropAuto: false,
        maskEnabled: true,
        maskMode: 'manual',
        maskX: 0,
        maskY: 100,
        maskWidth: 100,
        maskHeight: 100,
        selfMaskEnabled: false,
      },
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });

    assert.equal(plan.status, 'ok');
    assert.deepEqual(plan.settingsPatch, {});
    assert.deepEqual(plan.tileMasks, [
      { x: 0, y: 0, width: 69, height: 83, color: '#ffffff' },
    ]);
    assert.equal(plan.finalSettings.maskX, 0);
    assert.equal(plan.finalSettings.maskY, 100);
  });

  it('preserves cropAuto on context_error while disabling cropAuto only on not_found', async () => {
    const baseSettings = createDefaultSettings();

    const contextErrorPlan = await prepareMontagePlan({
      settings: baseSettings,
      imageSize: { width: 1920, height: 1080 },
      detectAutoCrop: () => ({ status: 'context_error' }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });
    assert.equal(contextErrorPlan.status, 'abort');
    assert.deepEqual(contextErrorPlan.alert, { kind: 'auto_crop_context_error' });
    assert.deepEqual(contextErrorPlan.settingsPatch, {});
    assert.equal({ ...baseSettings, ...contextErrorPlan.settingsPatch }.cropAuto, true);

    const notFoundPlan = await prepareMontagePlan({
      settings: baseSettings,
      imageSize: { width: 1920, height: 1080 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });
    assert.equal(notFoundPlan.status, 'abort');
    assert.deepEqual(notFoundPlan.alert, { kind: 'auto_crop_not_found' });
    assert.deepEqual(notFoundPlan.settingsPatch, { cropAuto: false });
  });

  it('keeps areSettingsDefault true after applying auto-crop settingsPatch for non-1600x900 images', async () => {
    const initial = createDefaultSettings();
    const plan = await prepareMontagePlan({
      settings: initial,
      imageSize: { width: 1920, height: 1080 },
      detectAutoCrop: () => ({
        status: 'ok',
        rect: { x: 37, y: 140, width: 1846, height: 798 },
      }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });

    assert.equal(plan.status, 'ok');
    const updated = { ...initial, ...plan.settingsPatch };
    assert.equal(updated.cropWidth, 1846);
    assert.equal(areSettingsDefault(updated), true);
  });
});

describe('renderMontageToBlob', () => {
  const createMockOutputCanvas = ({
    initialWidth = 300,
    initialHeight = 150,
    returnNullContext = false,
    clampWidth = null,
    toBlobResult = new Blob(['webp-bytes'], { type: 'image/webp' }),
  } = {}) => {
    const events = [];
    let currentWidth = initialWidth;
    let currentHeight = initialHeight;

    const ctx = {
      _fillStyle: '',
      get fillStyle() {
        return this._fillStyle;
      },
      set fillStyle(v) {
        this._fillStyle = v;
      },
      fillRect(x, y, w, h) {
        events.push(`fillRect:${this._fillStyle}:${x},${y},${w}x${h}`);
      },
      drawImage(_img, _sx, _sy, _sw, _sh, dx, dy, dw, dh) {
        events.push(`drawImage:${dx},${dy},${dw}x${dh}`);
      },
    };

    const canvas = {
      get width() {
        return currentWidth;
      },
      set width(v) {
        currentWidth = clampWidth !== null && v > clampWidth ? clampWidth : v;
        events.push(`width=${currentWidth}`);
      },
      get height() {
        return currentHeight;
      },
      set height(v) {
        currentHeight = v;
        events.push(`height=${currentHeight}`);
      },
      getContext(id, options) {
        events.push(`getContext:${id}:${JSON.stringify(options)}`);
        return returnNullContext ? null : ctx;
      },
      toBlob(cb, type, quality) {
        events.push(`toBlob:${type}:${quality}`);
        cb(toBlobResult);
      },
    };

    return { canvas, events };
  };

  it('allocates offscreen canvas, renders tiles, encodes blob, and shrinks canvas to 1x1 before resolving', async () => {
    const expectedBlob = new Blob(['webp-data'], { type: 'image/webp' });
    const mock = createMockOutputCanvas({ toBlobResult: expectedBlob });
    let bitmapClosed = 0;

    const result = await renderMontageToBlob({
      dimensions: { width: 100, height: 80 },
      bgColor: '#123456',
      mimeType: 'image/webp',
      quality: 0.85,
      createCanvas: () => mock.canvas,
      files: [{ name: 'tile1.png' }],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 80 },
      masks: [],
      expectedDimensions: { width: 1920, height: 1080 },
      getFileName: (f) => f.name,
      yieldFrame: async () => {},
      decodeImage: async () => ({
        width: 1920,
        height: 1080,
        close: () => {
          bitmapClosed += 1;
        },
      }),
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.blob, expectedBlob);
    assert.equal(bitmapClosed, 1);
    // Canvas must already be shrunk to 1x1 before the returned promise resolves to callers.
    assert.equal(mock.canvas.width, 1);
    assert.equal(mock.canvas.height, 1);
    assert.deepEqual(mock.events, [
      'getContext:2d:{"alpha":false}',
      'width=100',
      'height=80',
      'fillRect:#123456:0,0,100x80',
      'drawImage:0,0,100x80',
      'toBlob:image/webp:0.85',
      'width=1',
      'height=1',
    ]);
  });

  it('shrinks canvas to 1x1 across context, allocation, encode, and tile decode failures', async () => {
    const nullCtxMock = createMockOutputCanvas({ returnNullContext: true });
    const nullCtxResult = await renderMontageToBlob({
      dimensions: { width: 200, height: 100 },
      bgColor: '#000000',
      mimeType: 'image/png',
      quality: 1,
      createCanvas: () => nullCtxMock.canvas,
      files: [],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 200, height: 100 },
      masks: [],
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(nullCtxResult.status, 'context_failed');
    assert.equal(nullCtxMock.canvas.width, 1);
    assert.equal(nullCtxMock.canvas.height, 1);

    const clampedMock = createMockOutputCanvas({ clampWidth: 32767 });
    const clampedResult = await renderMontageToBlob({
      dimensions: { width: 40000, height: 100 },
      bgColor: '#000000',
      mimeType: 'image/png',
      quality: 1,
      createCanvas: () => clampedMock.canvas,
      files: [],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [],
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(clampedResult.status, 'allocation_failed');
    assert.equal(clampedMock.canvas.width, 1);
    assert.equal(clampedMock.canvas.height, 1);
    assert.ok(!clampedMock.events.some((e) => e.startsWith('toBlob:')));

    const nullBlobMock = createMockOutputCanvas({ toBlobResult: null });
    const nullBlobResult = await renderMontageToBlob({
      dimensions: { width: 100, height: 100 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.9,
      createCanvas: () => nullBlobMock.canvas,
      files: [],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [],
      yieldFrame: async () => {},
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(nullBlobResult.status, 'encode_failed');
    assert.equal(nullBlobMock.canvas.width, 1);
    assert.equal(nullBlobMock.canvas.height, 1);

    const thrownMock = createMockOutputCanvas();
    await assert.rejects(
      () =>
        renderMontageToBlob({
          dimensions: { width: 100, height: 100 },
          bgColor: '#000000',
          mimeType: 'image/webp',
          quality: 0.9,
          createCanvas: () => thrownMock.canvas,
          files: [{ name: 'bad.png' }],
          colCount: 1,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          masks: [],
          getFileName: (f) => f.name,
          decodeImage: async () => {
            throw new ImageDecodeError('bad.png');
          },
        }),
      (err) => err instanceof ImageDecodeError && err.fileName === 'bad.png'
    );
    assert.equal(thrownMock.canvas.width, 1);
    assert.equal(thrownMock.canvas.height, 1);
  });
});

describe('getMemoryReleaseDelayMs', () => {
  it('returns 0 when aborted before OCR session or montage canvas allocation', () => {
    assert.equal(
      getMemoryReleaseDelayMs({
        ocrSessionStarted: false,
        montageCanvasUsed: false,
      }),
      0
    );
  });

  it('returns MONTAGE_MEMORY_RELEASE_DELAY_MS (1000ms) when only montage canvas was used', () => {
    assert.equal(
      getMemoryReleaseDelayMs({
        ocrSessionStarted: false,
        montageCanvasUsed: true,
      }),
      MONTAGE_MEMORY_RELEASE_DELAY_MS
    );
    assert.equal(MONTAGE_MEMORY_RELEASE_DELAY_MS, 1000);
  });

  it('returns OCR_MEMORY_RELEASE_DELAY_MS (5000ms) when OCR session started', () => {
    assert.equal(
      getMemoryReleaseDelayMs({
        ocrSessionStarted: true,
        montageCanvasUsed: false,
      }),
      OCR_MEMORY_RELEASE_DELAY_MS
    );
    assert.equal(
      getMemoryReleaseDelayMs({
        ocrSessionStarted: true,
        montageCanvasUsed: true,
      }),
      OCR_MEMORY_RELEASE_DELAY_MS
    );
    assert.equal(OCR_MEMORY_RELEASE_DELAY_MS, 5000);
  });

  it('returns 0 when page reload was triggered regardless of allocated resources', () => {
    assert.equal(
      getMemoryReleaseDelayMs({
        ocrSessionStarted: false,
        montageCanvasUsed: true,
        reloadTriggered: true,
      }),
      0
    );
    assert.equal(
      getMemoryReleaseDelayMs({
        ocrSessionStarted: true,
        montageCanvasUsed: true,
        reloadTriggered: true,
      }),
      0
    );
  });
});
