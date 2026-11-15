import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOcrMaskRect,
  computeOcrSearchPlan,
  extractWordsFromBlocks,
  findTopmostLvBbox,
  isAbortError,
  isRectWithinBounds,
  startOcrSession,
  validateOcrRois,
} from '../src/ocrHelpers.ts';

const OriginalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = OriginalWorker;
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

  it('rejects ROIs that extend outside the decoded image bounds', () => {
    const imageBounds = { x: 0, y: 0, width: 1600, height: 900 };

    const completelyOut = validateOcrRois(
      { x: 2000, y: 2000, width: 800, height: 400 },
      imageBounds,
      true,
      true
    );
    assert.equal(completelyOut.enemyValid, false);
    assert.equal(completelyOut.selfValid, false);

    // cropX=900, width=1000 -> enemyRoi=[1650..1900] (outside 1600), selfRoi=[1150..1400] (inside 1600)
    const partiallyOut = validateOcrRois(
      { x: 900, y: 100, width: 1000, height: 600 },
      imageBounds,
      true,
      true
    );
    assert.equal(partiallyOut.enemyValid, false);
    assert.equal(partiallyOut.selfValid, true);
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
});
