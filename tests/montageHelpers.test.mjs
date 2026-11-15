import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ImageDecodeError,
  ImageResolutionMismatchError,
  buildTileMaskRects,
  decodeImageWithFallback,
  renderMontageTiles,
  resolveOutputExtension,
} from '../src/montageHelpers.ts';

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
});

describe('renderMontageTiles', () => {
  it('draws directly onto montageCtx without creating a temp canvas when no masks are active', async () => {
    const events = [];
    let tempCanvasCount = 0;

    await renderMontageTiles({
      files: ['img-0', 'img-1', 'img-2'],
      colCount: 2,
      offsetX: 10,
      offsetY: 20,
      cropRect: { x: 5, y: 15, width: 100, height: 80 },
      masks: [],
      createTempCanvas: () => {
        tempCanvasCount++;
        return createMockTempCanvas().canvas;
      },
      decodeImage: async (file) => ({
        id: file,
        close() {
          events.push({ type: 'close', id: file });
        },
      }),
      montageCtx: {
        drawImage(...args) {
          events.push({ type: 'montageDrawImage', args });
        },
      },
      yieldFrame: async () => {
        events.push({ type: 'yield' });
      },
    });

    assert.equal(tempCanvasCount, 0);
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
    let closed = false;

    await assert.rejects(
      () =>
        renderMontageTiles({
          files: ['img-0'],
          colCount: 1,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 100, height: 100 },
          masks: [],
          decodeImage: async () => ({
            close() {
              closed = true;
            },
          }),
          montageCtx: {
            drawImage() {
              throw new Error('montage draw failed');
            },
          },
          yieldFrame: async () => {},
        }),
      /montage draw failed/
    );

    assert.equal(closed, true);
  });

  it('allocates temp canvas once without per-frame size reassignment or willReadFrequently when masks are enabled', async () => {
    const temp = createMockTempCanvas();
    let createCalls = 0;
    const lifecycle = [];

    await renderMontageTiles({
      files: ['a', 'b', 'c'],
      colCount: 2,
      offsetX: 8,
      offsetY: 12,
      cropRect: { x: 10, y: 20, width: 200, height: 150 },
      masks: [{ x: 30, y: 40, width: 50, height: 20, color: '#000000' }],
      createTempCanvas: () => {
        createCalls++;
        return temp.canvas;
      },
      decodeImage: async (name) => ({
        name,
        close() {
          lifecycle.push(`close:${name}`);
        },
      }),
      montageCtx: {
        drawImage(src, dx, dy) {
          assert.equal(src, temp.canvas);
          lifecycle.push(`composite:${dx},${dy}`);
        },
      },
      yieldFrame: async () => {
        lifecycle.push('yield');
      },
    });

    assert.equal(createCalls, 1);
    assert.deepEqual(temp.contextCalls, [{ id: '2d', options: { alpha: false } }]);
    // Size assigned once at setup (200x150) and once at final cleanup (1x1), never inside loop.
    assert.deepEqual(temp.widthWrites, [200, 1]);
    assert.deepEqual(temp.heightWrites, [150, 1]);
    assert.equal(temp.canvas.width, 1);
    assert.equal(temp.canvas.height, 1);

    // Every tile is closed BEFORE compositing tempCanvas onto montageCtx.
    assert.deepEqual(lifecycle, [
      'close:a',
      'composite:8,12',
      'yield',
      'close:b',
      'composite:216,12',
      'yield',
      'close:c',
      'composite:8,174',
      'yield',
    ]);

    const clearOps = temp.ops.filter((op) => op.type === 'clearRect');
    assert.equal(clearOps.length, 3);
    assert.deepEqual(clearOps[0].args, [0, 0, 200, 150]);
  });

  it('closes bitmap and releases temp canvas to 1x1 when masked draw throws', async () => {
    const temp = createMockTempCanvas({ throwOnDraw: true });
    let closed = false;

    await assert.rejects(
      () =>
        renderMontageTiles({
          files: ['a'],
          colCount: 1,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 320, height: 240 },
          masks: [{ x: 10, y: 10, width: 40, height: 20, color: '#000000' }],
          createTempCanvas: () => temp.canvas,
          decodeImage: async () => ({
            close() {
              closed = true;
            },
          }),
          montageCtx: {
            drawImage() {},
          },
          yieldFrame: async () => {},
        }),
      /simulated temp draw error/
    );

    assert.equal(closed, true);
    assert.equal(temp.canvas.width, 1);
    assert.equal(temp.canvas.height, 1);
  });

  it('releases temp canvas to 1x1 if temporary getContext returns null', async () => {
    const temp = createMockTempCanvas({ returnNullContext: true });
    let decoded = false;

    await assert.rejects(
      () =>
        renderMontageTiles({
          files: ['a'],
          colCount: 1,
          offsetX: 0,
          offsetY: 0,
          cropRect: { x: 0, y: 0, width: 320, height: 240 },
          masks: [{ x: 10, y: 10, width: 40, height: 20, color: '#000000' }],
          createTempCanvas: () => temp.canvas,
          decodeImage: async () => {
            decoded = true;
            return { close() {} };
          },
          montageCtx: {
            drawImage() {},
          },
        }),
      /Could not get reusable temporary canvas context/
    );

    assert.equal(decoded, false);
    assert.equal(temp.canvas.width, 1);
    assert.equal(temp.canvas.height, 1);
  });

  it('returns immediately on empty file list without creating a temp canvas', async () => {
    let tempCalls = 0;

    await renderMontageTiles({
      files: [],
      colCount: 2,
      offsetX: 0,
      offsetY: 0,
      cropRect: { x: 0, y: 0, width: 100, height: 100 },
      masks: [{ x: 0, y: 0, width: 10, height: 10, color: '#000000' }],
      createTempCanvas: () => {
        tempCalls++;
        return createMockTempCanvas().canvas;
      },
      decodeImage: async () => {
        throw new Error('should not decode');
      },
      montageCtx: {
        drawImage() {
          throw new Error('should not draw');
        },
      },
    });

    assert.equal(tempCalls, 0);
  });

  it('rejects images whose dimensions differ from expectedDimensions and still closes bitmaps and temp canvas', async () => {
    const temp = createMockTempCanvas();
    const closed = [];
    const decoded = [];
    let montageDraws = 0;

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
          createTempCanvas: () => temp.canvas,
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
          montageCtx: {
            drawImage() {
              montageDraws++;
            },
          },
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
    assert.equal(montageDraws, 1);
    assert.equal(temp.canvas.width, 1);
    assert.equal(temp.canvas.height, 1);
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
