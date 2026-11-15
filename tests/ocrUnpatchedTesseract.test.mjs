import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startOcrSession } from '../src/ocrHelpers.ts';

const require = createRequire(import.meta.url);
const workerNodePath = require.resolve('tesseract.js/src/worker/node');
const createWorkerPath = require.resolve('tesseract.js/src/createWorker');

const originalWorkerNodeCache = require.cache[workerNodePath];
const originalCreateWorkerCache = require.cache[createWorkerPath];
const OriginalWorker = globalThis.Worker;

afterEach(() => {
  if (originalWorkerNodeCache) {
    require.cache[workerNodePath] = originalWorkerNodeCache;
  } else {
    delete require.cache[workerNodePath];
  }
  if (originalCreateWorkerCache) {
    require.cache[createWorkerPath] = originalCreateWorkerCache;
  } else {
    delete require.cache[createWorkerPath];
  }
  globalThis.Worker = OriginalWorker;
});

function loadUnpatchedCreateWorker({ failAction = null, crashOnAction = null } = {}) {
  delete require.cache[createWorkerPath];
  let messageHandler = null;
  let loadImageCalls = 0;
  const spawnedWorkers = [];

  class FakeNativeWorker extends EventTarget {
    constructor() {
      super();
      this.onerror = null;
      this.terminated = false;
      spawnedWorkers.push(this);
    }

    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = FakeNativeWorker;

  require.cache[workerNodePath] = {
    id: workerNodePath,
    filename: workerNodePath,
    loaded: true,
    exports: {
      defaultOptions: {},
      spawnWorker: () => new globalThis.Worker('fake-worker.js'),
      terminateWorker: (worker) => {
        worker.terminate();
      },
      onMessage: (_worker, handler) => {
        messageHandler = handler;
      },
      loadImage: async (img) => {
        loadImageCalls += 1;
        return img;
      },
      send: (worker, { workerId, jobId, action }) => {
        queueMicrotask(() => {
          if (crashOnAction === action && worker.onerror) {
            worker.onerror({ message: `${action} worker crashed` });
            return;
          }
          if (failAction === action) {
            messageHandler?.({
              workerId,
              jobId,
              status: 'reject',
              action,
              data: `${action} failed`,
            });
            return;
          }
          messageHandler?.({
            workerId,
            jobId,
            status: 'resolve',
            action,
            data: {},
          });
        });
      },
    },
  };

  const createWorker = require(createWorkerPath);
  return {
    createWorker,
    getSpawnedWorkers: () => spawnedWorkers,
    getLoadImageCalls: () => loadImageCalls,
  };
}

describe('startOcrSession guarding unpatched tesseract.js createWorker.js', () => {
  for (const action of ['load', 'loadLanguage', 'initialize']) {
    it(`rejects immediately and terminates native worker when "${action}" rejects without patching`, async () => {
      const { createWorker, getSpawnedWorkers } = loadUnpatchedCreateWorker({ failAction: action });

      const session = startOcrSession({
        initTimeoutMs: 5000,
        createWorkerFn: (langs, oem, opts) => createWorker(langs, oem, opts),
      });

      await assert.rejects(session.ready, new RegExp(`${action} failed`));
      assert.equal(getSpawnedWorkers().length, 1);
      assert.equal(getSpawnedWorkers()[0].terminated, true);
    });
  }

  it('rejects and terminates native worker on worker.onerror during loadLanguage', async () => {
    const { createWorker, getSpawnedWorkers } = loadUnpatchedCreateWorker({
      crashOnAction: 'loadLanguage',
    });

    const session = startOcrSession({
      initTimeoutMs: 5000,
      createWorkerFn: (langs, oem, opts) => createWorker(langs, oem, opts),
    });

    await assert.rejects(session.ready, /loadLanguage worker crashed/);
    assert.equal(getSpawnedWorkers().length, 1);
    assert.equal(getSpawnedWorkers()[0].terminated, true);
  });

  it('rejects null canvas.toBlob() in recognizeBlocks without entering tesseract.js loadImage()', async () => {
    const { createWorker, getSpawnedWorkers, getLoadImageCalls } = loadUnpatchedCreateWorker();

    const session = await startOcrSession({
      initTimeoutMs: 5000,
      createWorkerFn: (langs, oem, opts) => createWorker(langs, oem, opts),
    }).ready;

    await assert.rejects(
      session.recognizeBlocks({
        width: 120,
        height: 40,
        toBlob: (cb) => cb(null),
      }),
      /Failed to convert OCR canvas to blob/
    );
    assert.equal(getLoadImageCalls(), 0);
    assert.equal(getSpawnedWorkers().length, 1);
    assert.equal(getSpawnedWorkers()[0].terminated, true);
  });
});
