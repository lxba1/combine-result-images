import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImageDecodeError,
  ImageResolutionMismatchError,
  MONTAGE_MEMORY_RELEASE_DELAY_MS,
  OCR_MEMORY_RELEASE_DELAY_MS,
  buildTileMaskRects,
  canShareImageFile,
  computeScaledPreviewDimensions,
  decodeImageWithFallback,
  formatFileSize,
  formatOutputFormatLabel,
  getMemoryReleaseDelayMs,
  guardWindowFileDragEvent,
  hasExternalFilesDataTransfer,
  isSupportedInputImageFile,
  mergeImageFiles,
  mergeInputImageFiles,
  parseImageDimensionsFromBytes,
  prepareMontagePlan,
  readEncodedImageDimensions,
  renderMontageTiles,
  renderMontageToBlob,
  resolveActionButtonVariants,
  resolveAdjacentPreviewFile,
  resolveFileSelectionNotice,
  resolveMaskAccordionPreviewState,
  resolveMontageAbortUiTarget,
  resolveNextPreviewAfterRemoval,
  resolveOutputExtension,
  resolveRatioPreviewCropRect,
  shouldScrollToResult,
  splitFilenameForMiddleEllipsis,
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

  it('reports tile drawing progress and aborts cleanly on AbortSignal while closing decoded bitmaps', async () => {
    const progressEvents = [];
    const montage = createMockMontageContext();

    await renderMontageTiles({
      files: ['a.png', 'b.png', 'c.png'],
      colCount: 2,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [],
      montageCtx: montage.ctx,
      decodeImage: async () => ({ close() {} }),
      yieldFrame: async () => {},
      onProgress: (completed, total) => {
        progressEvents.push([completed, total]);
      },
    });
    assert.deepEqual(progressEvents, [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);

    const abortDuringDecode = new AbortController();
    const abortProgress = [];
    const decodedFiles = [];
    const closedFiles = [];
    const abortMontage = createMockMontageContext();

    await assert.rejects(
      () =>
        renderMontageTiles({
          files: ['first.png', 'second.png', 'third.png'],
          colCount: 2,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          masks: [],
          montageCtx: abortMontage.ctx,
          signal: abortDuringDecode.signal,
          onProgress: (completed, total) => {
            abortProgress.push([completed, total]);
          },
          decodeImage: async (file) => {
            decodedFiles.push(file);
            if (file === 'second.png') {
              abortDuringDecode.abort();
            }
            return {
              close() {
                closedFiles.push(file);
              },
            };
          },
          yieldFrame: async () => {},
        }),
      (err) => err instanceof Error && err.name === 'AbortError'
    );

    assert.deepEqual(decodedFiles, ['first.png', 'second.png']);
    assert.deepEqual(closedFiles, ['first.png', 'second.png']);
    assert.deepEqual(abortProgress, [
      [0, 3],
      [1, 3],
    ]);
    assert.equal(abortMontage.ops.filter((op) => op.type === 'drawImage').length, 1);

    const abortDuringYield = new AbortController();
    const yieldDecoded = [];
    await assert.rejects(
      () =>
        renderMontageTiles({
          files: ['one.png', 'two.png'],
          colCount: 2,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          masks: [],
          montageCtx: createMockMontageContext().ctx,
          signal: abortDuringYield.signal,
          decodeImage: async (file) => {
            yieldDecoded.push(file);
            return { close() {} };
          },
          yieldFrame: async () => {
            abortDuringYield.abort();
          },
        }),
      (err) => err instanceof Error && err.name === 'AbortError'
    );
    assert.deepEqual(yieldDecoded, ['one.png']);
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
    assert.deepEqual(enemyOutPlan.alert, { kind: 'mask_outside_crop', target: 'mask' });
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
    assert.deepEqual(selfOutPlan.alert, { kind: 'mask_outside_crop', target: 'selfMask' });

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
    assert.deepEqual(zeroAreaPlan.alert, {
      kind: 'invalid_mask_area',
      target: 'mask',
      mode: 'manual',
    });

    const collapsedRatioSelfPlan = await prepareMontagePlan({
      settings: {
        ...createDefaultSettings(),
        cropAuto: false,
        cropWidth: 100,
        cropHeight: 100,
        selfMaskEnabled: true,
        selfMaskMode: 'ratio',
        selfMaskRatioRect: { rx0: 0.5, ry0: 0.1, rx1: 0.501, ry1: 0.4 },
      },
      imageSize: { width: 1600, height: 900 },
      detectAutoCrop: () => ({ status: 'not_found' }),
      detectOcrMasks: async () => ({ status: 'not_found', enemyMissing: false, selfMissing: false }),
    });

    assert.equal(collapsedRatioSelfPlan.status, 'abort');
    assert.deepEqual(collapsedRatioSelfPlan.alert, {
      kind: 'invalid_mask_area',
      target: 'selfMask',
      mode: 'ratio',
    });
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

  it('resolves UI accordion and field error targets for prepareMontagePlan abort alerts', () => {
    const base = createDefaultSettings();

    assert.deepEqual(
      resolveMontageAbortUiTarget({ kind: 'auto_crop_context_error' }, base),
      { accordions: [], fields: [] }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget({ kind: 'auto_crop_not_found' }, base),
      { accordions: ['crop'], fields: [] }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget({ kind: 'crop_outside_image', width: 1600, height: 900 }, base),
      { accordions: ['crop'], fields: ['cropX', 'cropY', 'cropWidth', 'cropHeight'] }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget({ kind: 'mask_outside_crop', target: 'mask' }, base),
      { accordions: ['mask'], fields: ['maskX', 'maskY', 'maskWidth', 'maskHeight'] }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget({ kind: 'mask_outside_crop', target: 'selfMask' }, base),
      { accordions: ['selfMask'], fields: ['selfMaskX', 'selfMaskY', 'selfMaskWidth', 'selfMaskHeight'] }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget(
        { kind: 'invalid_mask_area', target: 'selfMask', mode: 'ratio' },
        base
      ),
      {
        accordions: ['selfMask'],
        fields: [
          'selfMaskRatioRect.rx0',
          'selfMaskRatioRect.ry0',
          'selfMaskRatioRect.rx1',
          'selfMaskRatioRect.ry1',
        ],
      }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget(
        { kind: 'ocr_not_found', enemyMissing: false, selfMissing: true },
        base
      ),
      { accordions: ['selfMask'], fields: [] }
    );
    assert.deepEqual(
      resolveMontageAbortUiTarget(
        { kind: 'ocr_error', error: new Error('fail') },
        { ...base, maskEnabled: true, maskMode: 'ocr', selfMaskEnabled: false, selfMaskMode: 'ocr' }
      ),
      { accordions: ['mask'], fields: [] }
    );
  });
});

describe('renderMontageToBlob', () => {
  const createMockOutputCanvas = ({
    initialWidth = 300,
    initialHeight = 150,
    returnNullContext = false,
    clampWidth = null,
    toBlobResult = new Blob(['webp-bytes'], { type: 'image/webp' }),
    getImageDataImpl = null,
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
      ...(getImageDataImpl
        ? {
            getImageData(sx, sy, sw, sh) {
              events.push(`getImageData:${sx},${sy},${sw}x${sh}`);
              return getImageDataImpl({ sx, sy, sw, sh, lastFillStyle: this._fillStyle });
            },
          }
        : {}),
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

  const makePngHeaderBytes = (width, height) => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13, false);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    view.setUint32(16, width, false);
    view.setUint32(20, height, false);
    return bytes;
  };

  const makeWebpVp8Bytes = (width, height) => {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    bytes.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
    bytes[20] = 0x10; // keyframe bit = 0
    bytes.set([0x9d, 0x01, 0x2a], 23); // VP8 start code
    const view = new DataView(bytes.buffer);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
    return bytes;
  };

  const makeWebpVp8lBytes = (width, height) => {
    const bytes = new Uint8Array(25);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // 'VP8L'
    bytes[20] = 0x2f;
    const packed = (((height - 1) & 0x3fff) << 14) | ((width - 1) & 0x3fff);
    new DataView(bytes.buffer).setUint32(21, packed >>> 0, true);
    return bytes;
  };

  const makeWebpVp8xBytes = (width, height) => {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x58], 12); // 'VP8X'
    const wMinus1 = width - 1;
    const hMinus1 = height - 1;
    bytes[24] = wMinus1 & 0xff;
    bytes[25] = (wMinus1 >> 8) & 0xff;
    bytes[26] = (wMinus1 >> 16) & 0xff;
    bytes[27] = hMinus1 & 0xff;
    bytes[28] = (hMinus1 >> 8) & 0xff;
    bytes[29] = (hMinus1 >> 16) & 0xff;
    return bytes;
  };

  const makeJpegBytes = (width, height, marker = 0xc0) => {
    const bytes = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // APP0 (len 8)
      0xff, marker, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // SOFn (len 11)
      0xff, 0xda, 0x00, 0x02, // SOS
    ]);
    const view = new DataView(bytes.buffer);
    view.setUint16(17, height, false);
    view.setUint16(19, width, false);
    return bytes;
  };

  it('rejects truncated output blob when encoded dimensions differ from requested dimensions', async () => {
    const truncatedWebpBlob = new Blob([makeWebpVp8Bytes(3000, 16383)], { type: 'image/webp' });
    const truncatedMock = createMockOutputCanvas({ toBlobResult: truncatedWebpBlob });

    const mismatchResult = await renderMontageToBlob({
      dimensions: { width: 3000, height: 17000 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.8,
      createCanvas: () => truncatedMock.canvas,
      files: [],
      colCount: 2,
      offsetX: 8,
      offsetY: 8,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [],
      yieldFrame: async () => {},
      decodeImage: async () => ({ close: () => {} }),
    });

    assert.deepEqual(mismatchResult, {
      status: 'dimension_mismatch',
      actualWidth: 3000,
      actualHeight: 16383,
    });
    assert.equal(truncatedMock.canvas.width, 1);
    assert.equal(truncatedMock.canvas.height, 1);

    const matchingPngBlob = new Blob([makePngHeaderBytes(3000, 17000)], { type: 'image/png' });
    const matchingMock = createMockOutputCanvas({ toBlobResult: matchingPngBlob });
    const okResult = await renderMontageToBlob({
      dimensions: { width: 3000, height: 17000 },
      bgColor: '#000000',
      mimeType: 'image/png',
      quality: 1,
      createCanvas: () => matchingMock.canvas,
      files: [],
      colCount: 2,
      offsetX: 8,
      offsetY: 8,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [],
      yieldFrame: async () => {},
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(okResult.status, 'ok');
    assert.equal(okResult.blob, matchingPngBlob);

    const emptyBlobMock = createMockOutputCanvas({
      toBlobResult: new Blob([], { type: 'image/webp' }),
    });
    const emptyResult = await renderMontageToBlob({
      dimensions: { width: 100, height: 100 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.8,
      createCanvas: () => emptyBlobMock.canvas,
      files: [],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [],
      yieldFrame: async () => {},
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(emptyResult.status, 'encode_failed');
  });

  it('parses PNG, WebP (VP8/VP8L/VP8X), and JPEG container dimensions cleanly', async () => {
    assert.deepEqual(
      await readEncodedImageDimensions(new Blob([makePngHeaderBytes(3100, 17000)], { type: 'image/png' })),
      { width: 3100, height: 17000 }
    );
    assert.deepEqual(
      await readEncodedImageDimensions(new Blob([makeWebpVp8Bytes(3000, 16383)], { type: 'image/webp' })),
      { width: 3000, height: 16383 }
    );
    assert.deepEqual(
      await readEncodedImageDimensions(new Blob([makeWebpVp8lBytes(16383, 900)], { type: 'image/webp' })),
      { width: 16383, height: 900 }
    );
    assert.deepEqual(
      await readEncodedImageDimensions(new Blob([makeWebpVp8xBytes(3000, 16384)], { type: 'image/webp' })),
      { width: 3000, height: 16384 }
    );
    assert.deepEqual(
      await readEncodedImageDimensions(new Blob([makeJpegBytes(3100, 20193, 0xc2)], { type: 'image/jpeg' })),
      { width: 3100, height: 20193 }
    );
    assert.equal(parseImageDimensionsFromBytes(new Uint8Array([0x00, 0x01, 0x02])), null);
    assert.equal(parseImageDimensionsFromBytes(new Uint8Array(24)), null);
  });

  it('detects backing store allocation failure via 1px probe before decoding any tiles', async () => {
    for (const [label, probeImpl] of [
      ['zeroed RGBA readback', () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) })],
      ['opaque black readback under alpha:false', () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })],
      [
        'exception thrown during getImageData',
        () => {
          throw new Error('Canvas backing store allocation failed');
        },
      ],
    ]) {
      let decodeCalls = 0;
      const failedMock = createMockOutputCanvas({ getImageDataImpl: probeImpl });
      const result = await renderMontageToBlob({
        dimensions: { width: 20000, height: 20000 },
        bgColor: '#000000',
        mimeType: 'image/png',
        quality: 1,
        createCanvas: () => failedMock.canvas,
        files: [{ name: 'tile1.png' }, { name: 'tile2.png' }],
        colCount: 2,
        offsetX: 0,
        offsetY: 0,
        cropRect: { x: 0, y: 0, width: 100, height: 100 },
        masks: [],
        yieldFrame: async () => {},
        decodeImage: async () => {
          decodeCalls += 1;
          return { close: () => {} };
        },
      });

      assert.equal(result.status, 'allocation_failed', label);
      assert.equal(decodeCalls, 0, label);
      assert.equal(failedMock.canvas.width, 1, label);
      assert.equal(failedMock.canvas.height, 1, label);
      assert.ok(failedMock.events.includes('getImageData:19999,19999,1x1'), label);
      assert.ok(!failedMock.events.some((e) => e.startsWith('toBlob:')), label);
    }
  });

  it('overwrites the 1px allocation probe with bgColor and renders tiles when probe passes', async () => {
    const probeSuccessMock = createMockOutputCanvas({
      getImageDataImpl: ({ sx, sy, sw, sh, lastFillStyle }) => {
        assert.deepEqual([sx, sy, sw, sh], [199, 99, 1, 1]);
        assert.equal(lastFillStyle, '#55aa55');
        return { data: new Uint8ClampedArray([0x55, 0xaa, 0x55, 255]) };
      },
      toBlobResult: new Blob([makePngHeaderBytes(200, 100)], { type: 'image/png' }),
    });

    const result = await renderMontageToBlob({
      dimensions: { width: 200, height: 100 },
      bgColor: '#000000',
      mimeType: 'image/png',
      quality: 1,
      createCanvas: () => probeSuccessMock.canvas,
      files: [{ name: 'tile1.png' }],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 200, height: 100 },
      masks: [],
      yieldFrame: async () => {},
      decodeImage: async () => ({ width: 200, height: 100, close: () => {} }),
    });

    assert.equal(result.status, 'ok');
    assert.deepEqual(probeSuccessMock.events, [
      'getContext:2d:{"alpha":false}',
      'width=200',
      'height=100',
      'fillRect:#55aa55:199,99,1x1',
      'getImageData:199,99,1x1',
      'fillRect:#000000:0,0,200x100',
      'drawImage:0,0,200x100',
      'toBlob:image/png:1',
      'width=1',
      'height=1',
    ]);
  });

  it('reuses the provided persistent canvas across runs without invoking createCanvas', async () => {
    const persistentMock = createMockOutputCanvas({
      initialWidth: 1,
      initialHeight: 1,
      toBlobResult: new Blob([makePngHeaderBytes(160, 120)], { type: 'image/png' }),
    });
    let createCanvasCalls = 0;

    await assert.rejects(
      () =>
        renderMontageToBlob({
          dimensions: { width: 160, height: 120 },
          bgColor: '#112233',
          mimeType: 'image/png',
          quality: 1,
          canvas: persistentMock.canvas,
          createCanvas: () => {
            createCanvasCalls += 1;
            return persistentMock.canvas;
          },
          files: [{ name: 'bad.png' }],
          colCount: 1,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 160, height: 120 },
          masks: [],
          getFileName: (f) => f.name,
          yieldFrame: async () => {},
          decodeImage: async () => {
            throw new ImageDecodeError('bad.png');
          },
        }),
      (err) => err instanceof ImageDecodeError && err.fileName === 'bad.png'
    );
    assert.equal(persistentMock.canvas.width, 1);
    assert.equal(persistentMock.canvas.height, 1);

    const secondResult = await renderMontageToBlob({
      dimensions: { width: 160, height: 120 },
      bgColor: '#445566',
      mimeType: 'image/png',
      quality: 1,
      canvas: persistentMock.canvas,
      createCanvas: () => {
        createCanvasCalls += 1;
        return persistentMock.canvas;
      },
      files: [{ name: 'ok.png' }],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 160, height: 120 },
      masks: [],
      getFileName: (f) => f.name,
      yieldFrame: async () => {},
      decodeImage: async () => ({ width: 160, height: 120, close: () => {} }),
    });

    assert.equal(secondResult.status, 'ok');
    assert.equal(createCanvasCalls, 0);
    assert.equal(persistentMock.canvas.width, 1);
    assert.equal(persistentMock.canvas.height, 1);
  });

  it('reports drawing/encoding phases and aborts cleanly while shrinking the canvas', async () => {
    const phases = [];
    const progress = [];
    const okMock = createMockOutputCanvas();
    const okResult = await renderMontageToBlob({
      dimensions: { width: 160, height: 120 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.8,
      createCanvas: () => okMock.canvas,
      files: [{ name: 'a.png' }, { name: 'b.png' }],
      colCount: 2,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 80, height: 120 },
      masks: [],
      getFileName: (f) => f.name,
      yieldFrame: async () => {},
      decodeImage: async () => ({ width: 80, height: 120, close: () => {} }),
      onPhaseChange: (phase) => phases.push(phase),
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    assert.equal(okResult.status, 'ok');
    assert.deepEqual(phases, ['drawing', 'encoding']);
    assert.deepEqual(progress, [
      [0, 2],
      [1, 2],
      [2, 2],
    ]);

    const preAborted = new AbortController();
    preAborted.abort();
    let getContextCalled = false;
    const preAbortedResult = await renderMontageToBlob({
      dimensions: { width: 160, height: 120 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.8,
      signal: preAborted.signal,
      createCanvas: () => ({
        width: 1,
        height: 1,
        getContext: () => {
          getContextCalled = true;
          return null;
        },
        toBlob: () => {},
      }),
      files: [{ name: 'a.png' }],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 160, height: 120 },
      masks: [],
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(preAbortedResult.status, 'aborted');
    assert.equal(getContextCalled, false);

    const midDrawAbort = new AbortController();
    const midDrawMock = createMockOutputCanvas();
    const midDrawResult = await renderMontageToBlob({
      dimensions: { width: 160, height: 120 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.8,
      signal: midDrawAbort.signal,
      createCanvas: () => midDrawMock.canvas,
      files: [{ name: 'a.png' }, { name: 'b.png' }],
      colCount: 2,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 80, height: 120 },
      masks: [],
      yieldFrame: async () => {
        midDrawAbort.abort();
      },
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(midDrawResult.status, 'aborted');
    assert.equal(midDrawMock.canvas.width, 1);
    assert.equal(midDrawMock.canvas.height, 1);
    assert.ok(!midDrawMock.events.some((e) => e.startsWith('toBlob:')));

    const encodeAbort = new AbortController();
    let canvasW = 1;
    let canvasH = 1;
    const encodeAbortCanvas = {
      get width() {
        return canvasW;
      },
      set width(v) {
        canvasW = v;
      },
      get height() {
        return canvasH;
      },
      set height(v) {
        canvasH = v;
      },
      getContext: () => createMockMontageContext().ctx,
      toBlob: (cb) => {
        encodeAbort.abort();
        cb(new Blob(['bytes'], { type: 'image/webp' }));
      },
    };
    const encodeAbortResult = await renderMontageToBlob({
      dimensions: { width: 160, height: 120 },
      bgColor: '#000000',
      mimeType: 'image/webp',
      quality: 0.8,
      signal: encodeAbort.signal,
      createCanvas: () => encodeAbortCanvas,
      files: [],
      colCount: 1,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 160, height: 120 },
      masks: [],
      decodeImage: async () => ({ close: () => {} }),
    });
    assert.equal(encodeAbortResult.status, 'aborted');
    assert.equal(canvasW, 1);
    assert.equal(canvasH, 1);
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

describe('result summary formatting and scroll decision', () => {
  it('formats byte sizes into B, KB, and MB', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(-10), '0 B');
    assert.equal(formatFileSize(Number.NaN), '0 B');
    assert.equal(formatFileSize(512), '512 B');
    assert.equal(formatFileSize(1023), '1023 B');
    assert.equal(formatFileSize(1024), '1.0 KB');
    assert.equal(formatFileSize(1536), '1.5 KB');
    assert.equal(formatFileSize(1024 * 1024), '1.00 MB');
    assert.equal(formatFileSize(2.5 * 1024 * 1024), '2.50 MB');
  });

  it('normalizes output format display labels', () => {
    assert.equal(formatOutputFormatLabel('webp'), 'WebP');
    assert.equal(formatOutputFormatLabel('png'), 'PNG');
    assert.equal(formatOutputFormatLabel('jpg'), 'JPEG');
    assert.equal(formatOutputFormatLabel('jpeg'), 'JPEG');
    assert.equal(formatOutputFormatLabel(' PNG '), 'PNG');
    assert.equal(formatOutputFormatLabel('avif'), 'AVIF');
  });

  it('only scrolls on compact viewports when the result section is away from view', () => {
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: false,
        resultTop: 1850,
        viewportHeight: 800,
      }),
      false
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: false,
        resultTop: -200,
        viewportHeight: 800,
      }),
      false
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: 200,
        viewportHeight: 800,
      }),
      false
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: 520,
        viewportHeight: 800,
      }),
      false
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: 521,
        viewportHeight: 800,
      }),
      true
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: 1850,
        viewportHeight: 667,
      }),
      true
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: -10,
        viewportHeight: 667,
      }),
      true
    );
    assert.equal(
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: 100,
        viewportHeight: 0,
      }),
      false
    );
  });

  it('highlights only the primary next action button as contained for each workflow state', () => {
    // 1. No images selected yet -> upload is primary
    assert.deepEqual(
      resolveActionButtonVariants({ hasImages: false, hasFreshResult: false }),
      { upload: 'contained', process: 'outlined', download: 'outlined' }
    );
    // 2. Images selected, no result (or stale result) -> process is primary
    assert.deepEqual(
      resolveActionButtonVariants({ hasImages: true, hasFreshResult: false }),
      { upload: 'outlined', process: 'contained', download: 'outlined' }
    );
    // 3. Fresh result available -> download is primary
    assert.deepEqual(
      resolveActionButtonVariants({ hasImages: true, hasFreshResult: true }),
      { upload: 'outlined', process: 'outlined', download: 'contained' }
    );
    // Guard against inconsistent state (no images + fresh result flag)
    assert.deepEqual(
      resolveActionButtonVariants({ hasImages: false, hasFreshResult: true }),
      { upload: 'contained', process: 'outlined', download: 'contained' }
    );
  });
});

describe('file list selection, deduplication, and middle ellipsis helpers', () => {
  it('accepts PNG and JPEG files by MIME type or extension fallback', () => {
    assert.equal(isSupportedInputImageFile({ name: 'a.png', type: 'image/png' }), true);
    assert.equal(isSupportedInputImageFile({ name: 'b.jpg', type: 'image/jpeg' }), true);
    assert.equal(isSupportedInputImageFile({ name: 'c.JPEG', type: '' }), true);
    assert.equal(isSupportedInputImageFile({ name: 'd.PNG', type: '' }), true);
    assert.equal(isSupportedInputImageFile({ name: 'e.webp', type: 'image/webp' }), false);
    assert.equal(isSupportedInputImageFile({ name: 'notes.txt', type: '' }), false);
  });

  it('appends new files while deduplicating against existing and incoming duplicates', () => {
    const f1 = { name: 'a.png', size: 100, lastModified: 1 };
    const f2 = { name: 'b.png', size: 200, lastModified: 2 };
    const f1Duplicate = { name: 'a.png', size: 100, lastModified: 1 };
    const f3 = { name: 'c.png', size: 300, lastModified: 3 };
    const f3Duplicate = { name: 'c.png', size: 300, lastModified: 3 };

    const merged = mergeImageFiles([f1, f2], [f1Duplicate, f3, f3Duplicate]);
    assert.deepEqual(merged.files, [f1, f2, f3]);
    assert.equal(merged.addedCount, 1);
    assert.equal(merged.skippedDuplicateCount, 2);

    const onlyDuplicates = mergeImageFiles([f1], [f1Duplicate]);
    assert.deepEqual(onlyDuplicates.files, [f1]);
    assert.equal(onlyDuplicates.addedCount, 0);
    assert.equal(onlyDuplicates.skippedDuplicateCount, 1);
  });

  it('counts supported additions, unsupported rejections, and duplicates together', () => {
    const f1 = { name: 'a.png', type: 'image/png', size: 100, lastModified: 1 };
    const f1Duplicate = { name: 'a.png', type: 'image/png', size: 100, lastModified: 1 };
    const f2 = { name: 'b.jpg', type: 'image/jpeg', size: 200, lastModified: 2 };
    const bad = { name: 'c.webp', type: 'image/webp', size: 300, lastModified: 3 };

    const mixed = mergeInputImageFiles([f1], [f2, bad, f1Duplicate]);
    assert.deepEqual(mixed.files, [f1, f2]);
    assert.equal(mixed.addedCount, 1);
    assert.equal(mixed.unsupportedCount, 1);
    assert.equal(mixed.duplicateCount, 1);

    const allUnsupported = mergeInputImageFiles([f1], [bad]);
    assert.deepEqual(allUnsupported.files, [f1]);
    assert.equal(allUnsupported.addedCount, 0);
    assert.equal(allUnsupported.unsupportedCount, 1);
    assert.equal(allUnsupported.duplicateCount, 0);

    assert.deepEqual(resolveFileSelectionNotice(allUnsupported), {
      severity: 'error',
      messageKey: 'alert_no_supported_images',
    });
    assert.deepEqual(resolveFileSelectionNotice(mixed), {
      severity: 'warning',
      messageKey: 'notice_skipped_both',
      params: { unsupportedCount: 1, duplicateCount: 1 },
    });
    assert.deepEqual(
      resolveFileSelectionNotice(mergeInputImageFiles([], [f1, bad])),
      {
        severity: 'warning',
        messageKey: 'notice_skipped_unsupported',
        params: { count: 1 },
      }
    );
    assert.deepEqual(
      resolveFileSelectionNotice(mergeInputImageFiles([f1], [f1Duplicate])),
      {
        severity: 'info',
        messageKey: 'notice_skipped_duplicate',
        params: { count: 1 },
      }
    );
    assert.equal(
      resolveFileSelectionNotice(mergeInputImageFiles([f1], [f2])),
      null
    );
  });

  it('splits long filenames for middle ellipsis while keeping short names and surrogate pairs intact', () => {
    assert.deepEqual(splitFilenameForMiddleEllipsis('short.png'), {
      head: '',
      tail: 'short.png',
    });

    const longName = 'Screenshot_2026-11-16-180001.png';
    const split = splitFilenameForMiddleEllipsis(longName);
    assert.equal(split.head + split.tail, longName);
    assert.equal(split.tail, '6-180001.png');

    const emojiName = 'スクリーンショット_😀😀😀😀_123456.png';
    const emojiSplit = splitFilenameForMiddleEllipsis(emojiName);
    assert.equal(emojiSplit.head + emojiSplit.tail, emojiName);
    assert.equal(Array.from(emojiSplit.tail).length, 12);
  });

  it('steps preview files cleanly without wrapping around ends', () => {
    const f1 = { name: '1.png' };
    const f2 = { name: '2.png' };
    const f3 = { name: '3.png' };
    const files = [f1, f2, f3];

    assert.equal(resolveAdjacentPreviewFile([f1], f1, -1), null);
    assert.equal(resolveAdjacentPreviewFile([f1], f1, 1), null);
    assert.equal(resolveAdjacentPreviewFile(files, f1, -1), null);
    assert.equal(resolveAdjacentPreviewFile(files, f1, 1), f2);
    assert.equal(resolveAdjacentPreviewFile(files, f2, -1), f1);
    assert.equal(resolveAdjacentPreviewFile(files, f2, 1), f3);
    assert.equal(resolveAdjacentPreviewFile(files, f3, -1), f2);
    assert.equal(resolveAdjacentPreviewFile(files, f3, 1), null);
    assert.equal(resolveAdjacentPreviewFile(files, { name: 'missing.png' }, 1), null);
  });

  it('advances to next file (or previous if last) after removing previewed file', () => {
    const f1 = { name: '1.png' };
    const f2 = { name: '2.png' };
    const f3 = { name: '3.png' };

    assert.equal(resolveNextPreviewAfterRemoval([f1, f2, f3], f1), f2);
    assert.equal(resolveNextPreviewAfterRemoval([f1, f2, f3], f2), f3);
    assert.equal(resolveNextPreviewAfterRemoval([f1, f2, f3], f3), f2);
    assert.equal(resolveNextPreviewAfterRemoval([f1], f1), null);
    assert.equal(resolveNextPreviewAfterRemoval([f1, f2], { name: 'missing.png' }), null);
  });

  it('checks Web Share API file support safely across missing, rejecting, and throwing browsers', () => {
    const sampleFile = new File(['abc'], 'tile.png', { type: 'image/png' });

    assert.equal(canShareImageFile(null, { share: async () => {}, canShare: () => true }), false);
    assert.equal(canShareImageFile(sampleFile, undefined), false);
    assert.equal(canShareImageFile(sampleFile, {}), false);
    assert.equal(canShareImageFile(sampleFile, { share: async () => {} }), false);
    assert.equal(
      canShareImageFile(sampleFile, {
        share: async () => {},
        canShare: () => false,
      }),
      false
    );
    assert.equal(
      canShareImageFile(sampleFile, {
        share: async () => {},
        canShare: () => {
          throw new TypeError('unsupported');
        },
      }),
      false
    );
    assert.equal(
      canShareImageFile(sampleFile, {
        share: async () => {},
        canShare: (data) => Array.isArray(data?.files) && data.files[0] === sampleFile,
      }),
      true
    );
  });

  it('guards unhandled window file dragover/drop without blocking handled or non-file drags', () => {
    assert.equal(hasExternalFilesDataTransfer(null), false);
    assert.equal(hasExternalFilesDataTransfer({ types: ['text/plain'] }), false);
    assert.equal(hasExternalFilesDataTransfer({ types: ['text/plain', 'Files'] }), true);

    const makeDragEvent = ({
      defaultPrevented = false,
      types = ['Files'],
      dropEffect = 'copy',
    } = {}) => {
      let prevented = defaultPrevented;
      const dt = { types, dropEffect };
      return {
        get defaultPrevented() {
          return prevented;
        },
        preventDefault: () => {
          prevented = true;
        },
        dataTransfer: dt,
        wasPrevented: () => prevented,
      };
    };

    // Unhandled external file dragover -> preventDefault + dropEffect = 'none'
    const unhandledDragOver = makeDragEvent();
    assert.equal(guardWindowFileDragEvent(unhandledDragOver, 'dragover'), true);
    assert.equal(unhandledDragOver.wasPrevented(), true);
    assert.equal(unhandledDragOver.dataTransfer.dropEffect, 'none');

    // Unhandled external file drop -> preventDefault
    const unhandledDrop = makeDragEvent({ dropEffect: 'none' });
    assert.equal(guardWindowFileDragEvent(unhandledDrop, 'drop'), true);
    assert.equal(unhandledDrop.wasPrevented(), true);

    // Already handled by card -> do not clobber dropEffect = 'copy'
    const cardHandledDragOver = makeDragEvent({ defaultPrevented: true, dropEffect: 'copy' });
    assert.equal(guardWindowFileDragEvent(cardHandledDragOver, 'dragover'), false);
    assert.equal(cardHandledDragOver.dataTransfer.dropEffect, 'copy');

    // Non-file drag (e.g. text selection) -> leave untouched
    const textDragOver = makeDragEvent({ types: ['text/plain'], dropEffect: 'move' });
    assert.equal(guardWindowFileDragEvent(textDragOver, 'dragover'), false);
    assert.equal(textDragOver.wasPrevented(), false);
    assert.equal(textDragOver.dataTransfer.dropEffect, 'move');
  });

  it('resolves crop regions and scaled preview dimensions safely with fallbacks', () => {
    const sourceSize = { width: 2400, height: 1080 };

    // Auto-crop succeeds
    assert.deepEqual(
      resolveRatioPreviewCropRect({
        sourceSize,
        cropAuto: true,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100,
        detectAutoCrop: () => ({ status: 'ok', rect: { x: 100, y: 20, width: 2000, height: 1000 } }),
      }),
      {
        cropRect: { x: 100, y: 20, width: 2000, height: 1000 },
        autoCropFallback: false,
      }
    );

    // Auto-crop fails -> full image with fallback flag
    assert.deepEqual(
      resolveRatioPreviewCropRect({
        sourceSize,
        cropAuto: true,
        cropX: 0,
        cropY: 0,
        cropWidth: 100,
        cropHeight: 100,
        detectAutoCrop: () => ({ status: 'not_found' }),
      }),
      {
        cropRect: { x: 0, y: 0, width: 2400, height: 1080 },
        autoCropFallback: true,
      }
    );

    // Valid manual crop
    assert.deepEqual(
      resolveRatioPreviewCropRect({
        sourceSize,
        cropAuto: false,
        cropX: 50,
        cropY: 10,
        cropWidth: 1600,
        cropHeight: 900,
        detectAutoCrop: () => ({ status: 'not_found' }),
      }),
      {
        cropRect: { x: 50, y: 10, width: 1600, height: 900 },
        autoCropFallback: false,
      }
    );

    // Out-of-bounds manual crop -> full image safely without fallback flag
    assert.deepEqual(
      resolveRatioPreviewCropRect({
        sourceSize,
        cropAuto: false,
        cropX: 5000,
        cropY: 10,
        cropWidth: 400,
        cropHeight: 300,
        detectAutoCrop: () => ({ status: 'not_found' }),
      }),
      {
        cropRect: { x: 0, y: 0, width: 2400, height: 1080 },
        autoCropFallback: false,
      }
    );

    assert.deepEqual(computeScaledPreviewDimensions(2000, 1000, 720), { width: 720, height: 360 });
    assert.deepEqual(computeScaledPreviewDimensions(400, 300, 720), { width: 400, height: 300 });
    assert.deepEqual(computeScaledPreviewDimensions(500, 1000, 720), { width: 360, height: 720 });
  });

  it('retains previous valid ratio preview while regenerating to prevent height jumps', () => {
    const fileA = { name: 'a.png' };
    const fileB = { name: 'b.png' };

    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: false,
        previewSourceImage: null,
        activeCropKey: 'auto',
        cachedPreview: {
          status: 'ok',
          url: 'blob:a',
          autoCropFallback: false,
          sourceFile: fileA,
          cropKey: 'auto',
        },
      }),
      { hasImages: false, status: 'loading' }
    );

    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: true,
        previewSourceImage: fileA,
        activeCropKey: 'auto',
        cachedPreview: null,
      }),
      { hasImages: true, status: 'loading' }
    );

    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: true,
        previewSourceImage: fileA,
        activeCropKey: 'auto',
        cachedPreview: {
          status: 'ok',
          url: 'blob:a',
          autoCropFallback: true,
          sourceFile: fileA,
          cropKey: 'auto',
        },
      }),
      {
        hasImages: true,
        status: 'ok',
        url: 'blob:a',
        autoCropFallback: true,
        isUpdating: false,
      }
    );

    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: true,
        previewSourceImage: fileA,
        activeCropKey: 'auto',
        cachedPreview: {
          status: 'error',
          url: '',
          autoCropFallback: false,
          sourceFile: fileA,
          cropKey: 'auto',
        },
      }),
      { hasImages: true, status: 'error' }
    );

    // Switching first image keeps previous valid preview until new build finishes
    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: true,
        previewSourceImage: fileB,
        activeCropKey: 'auto',
        cachedPreview: {
          status: 'ok',
          url: 'blob:a',
          autoCropFallback: false,
          sourceFile: fileA,
          cropKey: 'auto',
        },
      }),
      {
        hasImages: true,
        status: 'ok',
        url: 'blob:a',
        autoCropFallback: false,
        isUpdating: true,
      }
    );

    // Editing manual crop key keeps previous valid preview until rebuild finishes
    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: true,
        previewSourceImage: fileA,
        activeCropKey: 'manual:12,0,100,100',
        cachedPreview: {
          status: 'ok',
          url: 'blob:manual-1',
          autoCropFallback: false,
          sourceFile: fileA,
          cropKey: 'manual:1,0,100,100',
        },
      }),
      {
        hasImages: true,
        status: 'ok',
        url: 'blob:manual-1',
        autoCropFallback: false,
        isUpdating: true,
      }
    );

    // Previous error should not be kept while loading a different image or crop key
    assert.deepEqual(
      resolveMaskAccordionPreviewState({
        hasImages: true,
        previewSourceImage: fileB,
        activeCropKey: 'auto',
        cachedPreview: {
          status: 'error',
          url: '',
          autoCropFallback: false,
          sourceFile: fileA,
          cropKey: 'auto',
        },
      }),
      { hasImages: true, status: 'loading' }
    );
  });
});
