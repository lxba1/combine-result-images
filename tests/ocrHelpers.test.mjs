import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOcrMaskRect,
  computeOcrSearchPlan,
  extractWordsFromBlocks,
  findTopmostLvBbox,
  isAbortError,
  isRectWithinBounds,
  releaseOcrResources,
  runOcrMaskDetection,
  startOcrSession,
  validateOcrRois,
} from '../src/ocrHelpers.ts';

const OriginalWorker = globalThis.Worker;
const OriginalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
  URL.revokeObjectURL = OriginalRevokeObjectURL;
});

describe('validateOcrRois and isRectWithinBounds', () => {
  it('rejects 1x1 manual crop because quarterWidth and searchHeight become 0', () => {
    const result = validateOcrRois(
      { x: 100, y: 100, width: 1, height: 1 },
      { x: 0, y: 0, width: 1600, height: 900 },
      true,
      true
    );

    assert.equal(result.plan.quarterWidth, 0);
    assert.equal(result.plan.searchHeight, 0);
    assert.equal(result.enemyValid, false);
    assert.equal(result.selfValid, false);
  });

  it('rejects narrow or short crops that produce 0 width or 0 height ROIs', () => {
    const narrow = validateOcrRois(
      { x: 10, y: 10, width: 3, height: 200 },
      { x: 0, y: 0, width: 1600, height: 900 },
      true,
      true
    );
    assert.equal(narrow.enemyValid, false);
    assert.equal(narrow.selfValid, false);

    const short = validateOcrRois(
      { x: 10, y: 10, width: 400, height: 9 },
      { x: 0, y: 0, width: 1600, height: 900 },
      true,
      true
    );
    assert.equal(short.enemyValid, false);
    assert.equal(short.selfValid, false);
  });

  it('rejects ROIs that have zero overlap with the decoded image bounds', () => {
    const imageBounds = { x: 0, y: 0, width: 1600, height: 900 };

    const completelyOut = validateOcrRois(
      { x: 2000, y: 2000, width: 800, height: 400 },
      imageBounds,
      true,
      true
    );
    assert.equal(completelyOut.enemyValid, false);
    assert.equal(completelyOut.selfValid, false);

    // cropX=900, width=1000 -> enemyRoi=[1650..1900] (completely outside 1600), selfRoi=[1150..1400] (inside 1600)
    const disjointEnemy = validateOcrRois(
      { x: 900, y: 100, width: 1000, height: 600 },
      imageBounds,
      true,
      true
    );
    assert.equal(disjointEnemy.enemyValid, false);
    assert.equal(disjointEnemy.selfValid, true);
  });

  it('clips partially overhanging ROIs to image bounds and marks them valid', () => {
    const imageBounds = { x: 0, y: 0, width: 1600, height: 900 };
    // Right edge of enemyRoi overhangs 1600 by 3px (1210 + 393 = 1603); bottom edge of searchHeight stays inside
    const overhangRight = validateOcrRois(
      { x: 31, y: 117, width: 1572, height: 665 },
      imageBounds,
      true,
      true
    );
    assert.equal(overhangRight.enemyValid, true);
    assert.equal(overhangRight.selfValid, true);
    assert.deepEqual(overhangRight.plan.enemyRoi, {
      x: 1210,
      y: 183,
      width: 390,
      height: 73,
    });
    assert.ok(isRectWithinBounds(overhangRight.plan.enemyRoi, imageBounds));
    assert.ok(isRectWithinBounds(overhangRight.plan.selfRoi, imageBounds));

    // Bottom edge of both ROIs overhangs 900 by 6px (searchY=895, searchHeight=11 -> bottom=906)
    const overhangBottom = validateOcrRois(
      { x: 100, y: 885, width: 800, height: 100 },
      imageBounds,
      true,
      true
    );
    assert.equal(overhangBottom.enemyValid, true);
    assert.equal(overhangBottom.selfValid, true);
    assert.deepEqual(overhangBottom.plan.enemyRoi, {
      x: 700,
      y: 895,
      width: 200,
      height: 5,
    });
    assert.deepEqual(overhangBottom.plan.selfRoi, {
      x: 300,
      y: 895,
      width: 200,
      height: 5,
    });
  });

  it('skips validation for sides where OCR is disabled', () => {
    const result = validateOcrRois(
      { x: 900, y: 100, width: 1000, height: 600 },
      { x: 0, y: 0, width: 1600, height: 900 },
      false,
      true
    );
    assert.equal(result.enemyValid, true);
    assert.equal(result.selfValid, true);
  });

  it('accepts full-frame and standard result crop bounds', () => {
    const full = validateOcrRois(
      { x: 0, y: 0, width: 1600, height: 900 },
      { x: 0, y: 0, width: 1600, height: 900 },
      true,
      true
    );
    assert.equal(full.enemyValid, true);
    assert.equal(full.selfValid, true);

    const plan = computeOcrSearchPlan({ x: 31, y: 117, width: 1538, height: 665 });
    assert.ok(isRectWithinBounds(plan.enemyRoi, { x: 0, y: 0, width: 1600, height: 900 }));
    assert.ok(isRectWithinBounds(plan.selfRoi, { x: 0, y: 0, width: 1600, height: 900 }));
  });
});

describe('findTopmostLvBbox and buildOcrMaskRect', () => {
  const crop = { x: 31, y: 117, width: 1538, height: 665 };

  it('detects split tokens like ["Lv.", "90"] and ["L", "v.", "9", "0"]', () => {
    const splitWords = [
      { text: '順位', bbox: { x0: 1200, y0: 210, x1: 1240, y1: 228 } },
      { text: 'Lv.', bbox: { x0: 1260, y0: 210, x1: 1288, y1: 228 } },
      { text: '90', bbox: { x0: 1292, y0: 210, x1: 1315, y1: 228 } },
      { text: '相手太郎', bbox: { x0: 1325, y0: 210, x1: 1410, y1: 228 } },
    ];
    const box = findTopmostLvBbox(splitWords);
    assert.deepEqual(box, { x0: 1260, y0: 210, x1: 1315, y1: 228 });

    const charSplit = [
      { text: 'L', bbox: { x0: 460, y0: 212, x1: 470, y1: 230 } },
      { text: 'v.', bbox: { x0: 471, y0: 212, x1: 486, y1: 230 } },
      { text: '9', bbox: { x0: 490, y0: 212, x1: 500, y1: 230 } },
      { text: '0', bbox: { x0: 501, y0: 212, x1: 511, y1: 230 } },
    ];
    const selfBox = findTopmostLvBbox(charSplit);
    assert.ok(selfBox);
    assert.equal(selfBox.x0, 460);

    const selfRect = buildOcrMaskRect(selfBox, crop, 'left');
    assert.ok(selfRect);
    assert.equal(selfRect.x, 455);
    assert.equal(selfRect.x + selfRect.width, crop.x + Math.floor(crop.width / 2));
  });

  it('supports whitespace, Japanese dot, and full-width variants', () => {
    assert.ok(findTopmostLvBbox([{ text: 'Lv. 87', bbox: { x0: 1260, y0: 210, x1: 1315, y1: 228 } }]));
    assert.ok(findTopmostLvBbox([{ text: 'Lv・90', bbox: { x0: 1260, y0: 210, x1: 1315, y1: 228 } }]));
    assert.ok(findTopmostLvBbox([{ text: 'Ｌｖ．９０', bbox: { x0: 1260, y0: 210, x1: 1315, y1: 228 } }]));
  });

  it('returns null when no Lv.<number> text exists or box falls outside crop', () => {
    assert.equal(
      findTopmostLvBbox([
        { text: 'Rank', bbox: { x0: 1250, y0: 210, x1: 1290, y1: 228 } },
        { text: '90', bbox: { x0: 1295, y0: 210, x1: 1315, y1: 228 } },
      ]),
      null
    );

    const offscreenMask = buildOcrMaskRect({ x0: 1260, y0: 5, x1: 1310, y1: 20 }, crop, 'right');
    assert.equal(offscreenMask, null);
  });

  it('flattens nested blocks and shifts bounding boxes by ROI offsets', () => {
    const words = extractWordsFromBlocks(
      [
        {
          paragraphs: [
            {
              lines: [
                {
                  words: [{ text: 'Lv.90', bbox: { x0: 10, y0: 20, x1: 50, y1: 35 } }],
                },
              ],
            },
          ],
        },
      ],
      100,
      200
    );
    assert.deepEqual(words, [{ text: 'Lv.90', bbox: { x0: 110, y0: 220, x1: 150, y1: 235 } }]);
  });
});

describe('startOcrSession timeouts, worker failures, and cancellation', () => {
  it('times out when createWorker hangs and terminates the in-flight spawned Worker', async () => {
    let nativeTerminated = 0;

    class HangingWorker {
      terminate() {
        nativeTerminated += 1;
      }
    }
    globalThis.Worker = HangingWorker;

    const handle = startOcrSession({
      initTimeoutMs: 30,
      createWorkerFn: () => {
        new globalThis.Worker('fake-worker.js');
        return new Promise(() => {}); // Never settles
      },
    });

    await assert.rejects(handle.ready, /initialization timed out/i);
    assert.equal(nativeTerminated, 1);
  });

  it('rejects immediately via errorHandler even when createWorker promise would hang', async () => {
    let nativeTerminated = 0;

    class FakeNativeWorker {
      terminate() {
        nativeTerminated += 1;
      }
    }
    globalThis.Worker = FakeNativeWorker;

    const handle = startOcrSession({
      initTimeoutMs: 5000,
      createWorkerFn: (_langs, _oem, opts) => {
        new globalThis.Worker('fake-worker.js');
        setTimeout(() => opts?.errorHandler?.('language load failed'), 10);
        return new Promise(() => {}); // Hangs like unpatched Tesseract loadLanguage failure
      },
    });

    await assert.rejects(handle.ready, /language load failed/);
    assert.equal(nativeTerminated, 1);
  });

  it('terminates an initializing worker immediately when AbortController aborts', async () => {
    let nativeTerminated = 0;
    let resolvedWorkerTerminated = 0;
    let resolveLateWorker;

    class SlowNativeWorker {
      terminate() {
        nativeTerminated += 1;
      }
    }
    globalThis.Worker = SlowNativeWorker;

    const controller = new AbortController();
    const handle = startOcrSession({
      initTimeoutMs: 5000,
      signal: controller.signal,
      createWorkerFn: () => {
        new globalThis.Worker('fake-worker.js');
        return new Promise((resolve) => {
          resolveLateWorker = resolve;
        });
      },
    });

    setTimeout(() => controller.abort(), 10);

    await assert.rejects(handle.ready, (err) => isAbortError(err));
    assert.equal(nativeTerminated, 1);

    // Even if the underlying promise later resolves, the orphan worker must be terminated immediately.
    resolveLateWorker({
      recognize: async () => ({ data: { blocks: [] } }),
      terminate: async () => {
        resolvedWorkerTerminated += 1;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(resolvedWorkerTerminated, 1);
  });

  it('times out hanging recognize() calls and terminates the worker', async () => {
    let workerTerminated = 0;

    const handle = startOcrSession({
      initTimeoutMs: 1000,
      recognizeTimeoutMs: 25,
      createWorkerFn: async () => ({
        recognize: () => new Promise(() => {}),
        terminate: async () => {
          workerTerminated += 1;
        },
      }),
    });

    const session = await handle.ready;
    await assert.rejects(session.recognizeBlocks({ width: 100, height: 50 }), /recognition timed out/i);
    assert.equal(workerTerminated, 1);
  });

  it('rejects 0x0 canvas dimensions cleanly before calling worker.recognize()', async () => {
    let recognizeCalled = 0;

    const handle = startOcrSession({
      createWorkerFn: async () => ({
        recognize: async () => {
          recognizeCalled += 1;
          return { data: { blocks: [] } };
        },
        terminate: async () => {},
      }),
    });

    const session = await handle.ready;
    await assert.rejects(session.recognizeBlocks({ width: 0, height: 10 }), /Invalid OCR canvas dimensions/);
    await assert.rejects(session.recognizeBlocks({ width: 10, height: 0 }), /Invalid OCR canvas dimensions/);
    assert.equal(recognizeCalled, 0);
    await session.terminate();
  });

  it('converts canvas via app-side toBlob and passes a Blob to worker.recognize()', async () => {
    let receivedImage = null;

    const handle = startOcrSession({
      createWorkerFn: async () => ({
        recognize: async (image) => {
          receivedImage = image;
          return { data: { blocks: [] } };
        },
        terminate: async () => {},
      }),
    });

    const session = await handle.ready;
    const expectedBlob = new Blob(['png-bytes'], { type: 'image/png' });
    await session.recognizeBlocks({
      width: 120,
      height: 60,
      toBlob: (cb) => cb(expectedBlob),
    });
    assert.equal(receivedImage, expectedBlob);
    await session.terminate();
  });

  it('rejects cleanly and terminates worker when app-side canvas.toBlob returns null', async () => {
    let recognizeCalled = 0;
    let workerTerminated = 0;

    const handle = startOcrSession({
      createWorkerFn: async () => ({
        recognize: async () => {
          recognizeCalled += 1;
          return { data: { blocks: [] } };
        },
        terminate: async () => {
          workerTerminated += 1;
        },
      }),
    });

    const session = await handle.ready;
    await assert.rejects(
      session.recognizeBlocks({
        width: 120,
        height: 60,
        toBlob: (cb) => cb(null),
      }),
      /Failed to convert OCR canvas to blob/
    );
    assert.equal(recognizeCalled, 0);
    assert.equal(workerTerminated, 1);
  });

  it('rejects post-init recognize() immediately if native Worker dispatches an error event', async () => {
    let nativeWorker;
    let nativeTerminated = 0;

    class EventedNativeWorker extends EventTarget {
      terminate() {
        nativeTerminated += 1;
      }
    }
    globalThis.Worker = EventedNativeWorker;

    const handle = startOcrSession({
      recognizeTimeoutMs: 5000,
      createWorkerFn: async () => {
        nativeWorker = new globalThis.Worker('fake-worker.js');
        return {
          recognize: () => new Promise(() => {}),
          terminate: async () => {},
        };
      },
    });

    const session = await handle.ready;
    setTimeout(() => {
      const ev = new Event('error');
      Object.assign(ev, { message: 'native worker crashed during recognize' });
      nativeWorker.dispatchEvent(ev);
    }, 10);

    await assert.rejects(
      session.recognizeBlocks({ width: 100, height: 50 }),
      /native worker crashed during recognize/
    );
    assert.equal(nativeTerminated, 1);
  });

  it('revokes spawned blob: Worker URLs after termination once, leaving non-blob URLs untouched', async () => {
    const events = [];
    const revokedUrls = [];
    URL.revokeObjectURL = (url) => {
      events.push(`revoke:${url}`);
      revokedUrls.push(url);
    };

    class TrackingWorker {
      terminate() {
        events.push('native-terminate');
      }
    }
    globalThis.Worker = TrackingWorker;

    const handle = startOcrSession({
      createWorkerFn: async () => {
        new globalThis.Worker('blob:https://example.com/worker-1');
        new globalThis.Worker(new URL('blob:https://example.com/worker-2'));
        new globalThis.Worker('https://example.com/worker.js');
        return {
          recognize: async () => ({ data: { blocks: [] } }),
          terminate: async () => {
            events.push('worker-terminate');
          },
        };
      },
    });

    const session = await handle.ready;
    assert.deepEqual(revokedUrls, []);

    await session.terminate();
    await session.terminate();

    assert.deepEqual(revokedUrls, [
      'blob:https://example.com/worker-1',
      'blob:https://example.com/worker-2',
    ]);
    assert.deepEqual(events, [
      'native-terminate',
      'native-terminate',
      'native-terminate',
      'worker-terminate',
      'revoke:blob:https://example.com/worker-1',
      'revoke:blob:https://example.com/worker-2',
    ]);
  });

  it('revokes spawned blob: Worker URLs when worker initialization times out', async () => {
    const revokedUrls = [];
    let nativeTerminated = 0;
    URL.revokeObjectURL = (url) => {
      revokedUrls.push(url);
    };

    class HangingBlobWorker {
      terminate() {
        nativeTerminated += 1;
      }
    }
    globalThis.Worker = HangingBlobWorker;

    const handle = startOcrSession({
      initTimeoutMs: 25,
      createWorkerFn: () => {
        new globalThis.Worker('blob:https://example.com/hanging-worker');
        return new Promise(() => {});
      },
    });

    await assert.rejects(handle.ready, /initialization timed out/i);
    assert.equal(nativeTerminated, 1);
    assert.deepEqual(revokedUrls, ['blob:https://example.com/hanging-worker']);
  });
});

describe('releaseOcrResources early and fallback cleanup', () => {
  it('clears holders and awaits expected session termination, leaving subsequent cleanup as a no-op', async () => {
    const controller = new AbortController();
    let resolveTerminate;
    let terminateCount = 0;

    const sessionHandle = {
      ready: new Promise(() => {}),
      terminate: () => {
        terminateCount += 1;
        return new Promise((resolve) => {
          resolveTerminate = resolve;
        });
      },
    };

    const abortHolder = { current: controller };
    const sessionHolder = { current: sessionHandle };

    const cleanupPromise = releaseOcrResources(abortHolder, sessionHolder, {
      expectedAbort: controller,
      expectedSession: sessionHandle,
    });

    assert.equal(abortHolder.current, null);
    assert.equal(sessionHolder.current, null);
    assert.equal(terminateCount, 1);

    let finished = false;
    cleanupPromise.then(() => {
      finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);

    resolveTerminate();
    await cleanupPromise;
    assert.equal(finished, true);

    await releaseOcrResources(abortHolder, sessionHolder);
    assert.equal(terminateCount, 1);
  });

  it('aborts active controller on abort cleanup without clobbering newer session refs when expected guards are provided', async () => {
    const oldController = new AbortController();
    const newController = new AbortController();
    let oldTerminated = 0;
    let newTerminated = 0;

    const oldSession = {
      ready: new Promise(() => {}),
      terminate: async () => {
        oldTerminated += 1;
      },
    };
    const newSession = {
      ready: new Promise(() => {}),
      terminate: async () => {
        newTerminated += 1;
      },
    };

    const abortHolder = { current: newController };
    const sessionHolder = { current: newSession };

    await releaseOcrResources(abortHolder, sessionHolder, {
      expectedAbort: oldController,
      expectedSession: oldSession,
    });

    assert.equal(oldTerminated, 1);
    assert.equal(newTerminated, 0);
    assert.equal(abortHolder.current, newController);
    assert.equal(sessionHolder.current, newSession);

    await releaseOcrResources(abortHolder, sessionHolder, { abort: true });
    assert.equal(newController.signal.aborted, true);
    assert.equal(newTerminated, 1);
    assert.equal(abortHolder.current, null);
    assert.equal(sessionHolder.current, null);
  });
});

describe('OCR cancellation & scratch context safety', () => {
  it('clears pending init timeout and rejects ready with AbortError when terminate() runs before init completes', async () => {
    const startMs = Date.now();
    let resolveLateWorker;

    const handle = startOcrSession({
      initTimeoutMs: 60_000,
      recognizeTimeoutMs: 60_000,
      createWorkerFn: () =>
        new Promise((resolve) => {
          resolveLateWorker = resolve;
        }),
    });

    await handle.terminate();
    await assert.rejects(handle.ready, (err) => isAbortError(err));
    assert.ok(Date.now() - startMs < 1000, 'terminate() must settle immediately without waiting for initTimeoutMs');

    let orphanTerminated = 0;
    resolveLateWorker?.({
      recognize: async () => ({ data: { blocks: [] } }),
      terminate: async () => {
        orphanTerminated += 1;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(orphanTerminated, 1);
  });

  it('returns error without starting an OCR session when scratch canvas getContext() returns null', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    let startSessionCalls = 0;
    let statusCalls = 0;
    const widthWrites = [];
    const heightWrites = [];
    const contextCalls = [];

    const mockCanvas = {
      _w: 0,
      _h: 0,
      get width() {
        return this._w;
      },
      set width(v) {
        this._w = v;
        widthWrites.push(v);
      },
      get height() {
        return this._h;
      },
      set height(v) {
        this._h = v;
        heightWrites.push(v);
      },
      getContext(id, options) {
        contextCalls.push({ id, options });
        return null;
      },
    };

    const result = await runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: false,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      onStatus: () => {
        statusCalls += 1;
      },
      startSession: () => {
        startSessionCalls += 1;
        return {
          ready: Promise.reject(new Error('should never be called')),
          terminate: async () => {},
        };
      },
    });

    assert.equal(result.status, 'error');
    assert.equal(startSessionCalls, 0);
    assert.equal(statusCalls, 0);
    assert.equal(abortHolder.current, null);
    assert.equal(sessionHolder.current, null);
    assert.deepEqual(contextCalls, [
      { id: '2d', options: { willReadFrequently: true, alpha: false } },
    ]);
    assert.deepEqual(widthWrites, [1]);
    assert.deepEqual(heightWrites, [1]);
  });

  it('awaits session termination and settles ready when aborted during initialization', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    let workerTerminated = 0;
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
      }),
    };

    const resultPromise = runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: true,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      startSession: (signal) =>
        startOcrSession({
          signal,
          initTimeoutMs: 60_000,
          recognizeTimeoutMs: 60_000,
          createWorkerFn: () => new Promise(() => {}),
        }),
    });

    // Abort once startSession has registered the active controller & session.
    assert.ok(abortHolder.current);
    assert.ok(sessionHolder.current);
    const activeSession = sessionHolder.current;
    const origTerminate = activeSession.terminate;
    activeSession.terminate = async () => {
      workerTerminated += 1;
      return origTerminate();
    };
    abortHolder.current.abort();

    const result = await resultPromise;
    assert.deepEqual(result, { status: 'aborted' });
    assert.equal(workerTerminated, 1);
    assert.equal(abortHolder.current, null);
    assert.equal(sessionHolder.current, null);
    assert.equal(mockCanvas.width, 1);
    assert.equal(mockCanvas.height, 1);
  });

  it('runs OCR using clipped ROI when crop slightly overhangs image right edge', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    const drawCalls = [];
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage(...args) {
          drawCalls.push({ args, width: mockCanvas.width, height: mockCanvas.height });
        },
      }),
      toBlob: (cb) => cb(new Blob(['png-bytes'], { type: 'image/png' })),
    };

    const result = await runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1572, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: false,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      startSession: (signal) =>
        startOcrSession({
          signal,
          createWorkerFn: async () => ({
            recognize: async () => ({
              data: {
                blocks: [
                  {
                    paragraphs: [
                      {
                        lines: [
                          {
                            words: [
                              { text: 'Lv.90', bbox: { x0: 40, y0: 20, x1: 95, y1: 40 } },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            }),
            terminate: async () => {},
          }),
        }),
    });

    assert.equal(drawCalls.length, 1);
    assert.deepEqual(drawCalls[0].args.slice(1), [1210, 183, 390, 73, 0, 0, 390, 73]);
    assert.equal(drawCalls[0].width, 390);
    assert.equal(drawCalls[0].height, 73);
    assert.deepEqual(result, {
      status: 'ok',
      enemyMaskRect: { x: 1245, y: 198, width: 358, height: 30 },
      selfMaskRect: null,
    });
    assert.equal(mockCanvas.width, 1);
    assert.equal(mockCanvas.height, 1);
  });

  it('pre-encodes ROI blobs, shrinks scratch canvas, and invokes onSourceConsumed before worker startup', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    const events = [];
    const recognizedInputs = [];
    let currentWidth = 0;
    let currentHeight = 0;
    let sourceBitmapClosed = false;

    const mockCanvas = {
      get width() {
        return currentWidth;
      },
      set width(v) {
        currentWidth = v;
        if (v === 1 && currentHeight === 1) {
          events.push('scratch:reset');
        }
      },
      get height() {
        return currentHeight;
      },
      set height(v) {
        currentHeight = v;
        if (currentWidth === 1 && v === 1) {
          events.push('scratch:reset');
        }
      },
      getContext: () => ({
        clearRect() {},
        drawImage(_src, sx, sy, sw, sh) {
          events.push(`draw:${sx},${sy},${sw},${sh}`);
        },
      }),
      toBlob: (cb) => {
        const blob = new Blob([`roi:${currentWidth}x${currentHeight}`], { type: 'image/png' });
        events.push(`toBlob:${currentWidth}x${currentHeight}`);
        cb(blob);
      },
    };

    const result = await runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: true,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      onSourceConsumed: () => {
        sourceBitmapClosed = true;
        events.push('onSourceConsumed');
      },
      onStatus: (status) => {
        assert.equal(sourceBitmapClosed, true);
        assert.equal(mockCanvas.width, 1);
        assert.equal(mockCanvas.height, 1);
        events.push(`onStatus:${status}`);
      },
      startSession: (signal) => {
        assert.equal(sourceBitmapClosed, true);
        assert.equal(mockCanvas.width, 1);
        assert.equal(mockCanvas.height, 1);
        events.push('startSession');
        let callIndex = 0;
        return startOcrSession({
          signal,
          createWorkerFn: async () => ({
            recognize: async (img) => {
              assert.equal(img instanceof Blob, true);
              recognizedInputs.push(img);
              events.push(`recognize:${callIndex}`);
              const word =
                callIndex++ === 0
                  ? { text: 'Lv.90', bbox: { x0: 40, y0: 20, x1: 95, y1: 40 } }
                  : { text: 'Lv.85', bbox: { x0: 30, y0: 15, x1: 85, y1: 35 } };
              return {
                data: {
                  blocks: [{ paragraphs: [{ lines: [{ words: [word] }] }] }],
                },
              };
            },
            terminate: async () => {},
          }),
        });
      },
    });

    assert.deepEqual(result, {
      status: 'ok',
      enemyMaskRect: { x: 1218, y: 198, width: 351, height: 30 },
      selfMaskRect: { x: 440, y: 193, width: 360, height: 30 },
    });
    assert.equal(recognizedInputs.length, 2);
    assert.deepEqual(events, [
      'draw:1183,183,384,73',
      'toBlob:384x73',
      'draw:415,183,384,73',
      'toBlob:384x73',
      'scratch:reset',
      'onSourceConsumed',
      'onStatus:starting',
      'startSession',
      'recognize:0',
      'recognize:1',
    ]);
  });

  it('returns error without calling onSourceConsumed or startSession when pre-encoding toBlob yields null', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    let startSessionCalls = 0;
    let statusCalls = 0;
    let sourceConsumedCalls = 0;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
      }),
      toBlob: (cb) => cb(null),
    };

    const result = await runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: false,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      onSourceConsumed: () => {
        sourceConsumedCalls += 1;
      },
      onStatus: () => {
        statusCalls += 1;
      },
      startSession: () => {
        startSessionCalls += 1;
        return {
          ready: Promise.reject(new Error('should never be called')),
          terminate: async () => {},
        };
      },
    });

    assert.equal(result.status, 'error');
    assert.equal(sourceConsumedCalls, 0);
    assert.equal(statusCalls, 0);
    assert.equal(startSessionCalls, 0);
    assert.equal(mockCanvas.width, 1);
    assert.equal(mockCanvas.height, 1);
  });

  it('aborts hanging pre-encoding via releaseOcrResources, shrinks canvas immediately, and never spawns worker', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    let toBlobCalls = 0;
    let pendingBlobCallback = null;
    let sourceConsumedCalls = 0;
    let statusCalls = 0;
    let startSessionCalls = 0;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
      }),
      toBlob: (cb) => {
        toBlobCalls += 1;
        pendingBlobCallback = cb;
      },
    };

    const resultPromise = runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: true,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      onSourceConsumed: () => {
        sourceConsumedCalls += 1;
      },
      onStatus: () => {
        statusCalls += 1;
      },
      startSession: () => {
        startSessionCalls += 1;
        return {
          ready: Promise.reject(new Error('should never be called')),
          terminate: async () => {},
        };
      },
    });

    assert.equal(toBlobCalls, 1);
    assert.ok(abortHolder.current, 'AbortController must be registered before pre-encoding starts');
    assert.ok(mockCanvas.width > 1 && mockCanvas.height > 1);

    await releaseOcrResources(abortHolder, sessionHolder, { abort: true });
    assert.equal(mockCanvas.width, 1);
    assert.equal(mockCanvas.height, 1);

    const result = await resultPromise;
    assert.deepEqual(result, { status: 'aborted' });
    assert.equal(toBlobCalls, 1);
    assert.equal(sourceConsumedCalls, 0);
    assert.equal(statusCalls, 0);
    assert.equal(startSessionCalls, 0);
    assert.equal(abortHolder.current, null);
    assert.equal(sessionHolder.current, null);

    // Late toBlob callback firing after abort must remain harmless.
    pendingBlobCallback?.(new Blob(['late'], { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(startSessionCalls, 0);
  });

  it('times out hanging pre-encoding toBlob, shrinks canvas, and skips worker startup', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    let sourceConsumedCalls = 0;
    let statusCalls = 0;
    let startSessionCalls = 0;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
      }),
      toBlob: () => {
        // Intentionally never invoke callback.
      },
    };

    const result = await runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: true,
      abortHolder,
      sessionHolder,
      encodeTimeoutMs: 25,
      createCanvas: () => mockCanvas,
      onSourceConsumed: () => {
        sourceConsumedCalls += 1;
      },
      onStatus: () => {
        statusCalls += 1;
      },
      startSession: () => {
        startSessionCalls += 1;
        return {
          ready: Promise.reject(new Error('should never be called')),
          terminate: async () => {},
        };
      },
    });

    assert.equal(result.status, 'error');
    assert.match(result.error instanceof Error ? result.error.message : String(result.error), /encoding timed out/i);
    assert.equal(sourceConsumedCalls, 0);
    assert.equal(statusCalls, 0);
    assert.equal(startSessionCalls, 0);
    assert.equal(abortHolder.current, null);
    assert.equal(mockCanvas.width, 1);
    assert.equal(mockCanvas.height, 1);
  });

  it('checks cancellation right before starting worker when aborted after pre-encoding', async () => {
    const abortHolder = { current: null };
    const sessionHolder = { current: null };
    let startSessionCalls = 0;

    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect() {},
        drawImage() {},
      }),
      toBlob: (cb) => cb(new Blob(['ok'], { type: 'image/png' })),
    };

    const result = await runOcrMaskDetection({
      sourceImage: { width: 1600, height: 900 },
      cropRect: { x: 31, y: 117, width: 1538, height: 665 },
      needsEnemyOcr: true,
      needsSelfOcr: false,
      abortHolder,
      sessionHolder,
      createCanvas: () => mockCanvas,
      onStatus: () => {
        abortHolder.current?.abort();
      },
      startSession: () => {
        startSessionCalls += 1;
        return {
          ready: Promise.reject(new Error('should never be called')),
          terminate: async () => {},
        };
      },
    });

    assert.deepEqual(result, { status: 'aborted' });
    assert.equal(startSessionCalls, 0);
    assert.equal(abortHolder.current, null);
    assert.equal(sessionHolder.current, null);
    assert.equal(mockCanvas.width, 1);
    assert.equal(mockCanvas.height, 1);
  });
});
