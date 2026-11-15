import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAutoCropFromImage,
  detectAutoCropRectFromScanlines,
} from '../src/cropHelpers.ts';

function makeScanline(length, fill) {
  const arr = new Uint8ClampedArray(length * 4);
  for (let i = 0; i < length; i++) {
    const [r, g, b] = fill(i);
    const offset = i * 4;
    arr[offset] = r;
    arr[offset + 1] = g;
    arr[offset + 2] = b;
    arr[offset + 3] = 255;
  }
  return arr;
}

function guardBounds(typedArray) {
  return new Proxy(typedArray, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        const index = Number(prop);
        if (index < 0 || index >= target.length) {
          throw new RangeError(`Out-of-bounds scanline read at index ${index} (length=${target.length})`);
        }
      }
      return Reflect.get(target, prop, target);
    },
  });
}

describe('detectAutoCropRectFromScanlines', () => {
  it('never reads out of bounds on vData or hData across tiny dimensions (1..25)', () => {
    for (const h of [1, 2, 3, 5, 10, 19, 20, 21, 25]) {
      for (const w of [1, 2, 3, 10, 20, 60]) {
        const hData = guardBounds(makeScanline(w, () => [0, 0, 0]));
        const vData = guardBounds(makeScanline(h, () => [0, 0, 0]));
        const rect = detectAutoCropRectFromScanlines(hData, vData, w, h);
        assert.equal(rect, null);
      }
    }
  });

  it('detects content rectangle inside dark borders', () => {
    const width = 1000;
    const height = 600;
    // Left border [0..49], right border [950..999], top [0..79], bottom [520..599]
    const hData = guardBounds(makeScanline(width, (x) => (x >= 50 && x < 950 ? [220, 220, 220] : [0, 0, 0])));
    const vData = guardBounds(makeScanline(height, (y) => (y >= 80 && y < 520 ? [220, 220, 220] : [0, 0, 0])));

    const rect = detectAutoCropRectFromScanlines(hData, vData, width, height);

    assert.deepEqual(rect, {
      x: 50,
      y: 80,
      width: 900,
      height: 440,
    });
  });
});

describe('detectAutoCropFromImage', () => {
  it('returns context_error and shrinks canvas to 1x1 when horizontal getContext returns null', () => {
    const createdCanvases = [];
    const result = detectAutoCropFromImage({ width: 1000, height: 600 }, () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => null,
      };
      createdCanvases.push(canvas);
      return canvas;
    });

    assert.deepEqual(result, { status: 'context_error' });
    assert.equal(createdCanvases.length, 1);
    assert.equal(createdCanvases[0].width, 1);
    assert.equal(createdCanvases[0].height, 1);
  });

  it('returns context_error and cleans up both canvases when vertical getContext returns null', () => {
    const createdCanvases = [];
    const hData = makeScanline(1000, () => [200, 200, 200]);

    const result = detectAutoCropFromImage({ width: 1000, height: 600 }, () => {
      const callIndex = createdCanvases.length;
      const canvas = {
        width: 0,
        height: 0,
        getContext: () =>
          callIndex === 0
            ? {
                drawImage: () => {},
                getImageData: () => ({ data: hData }),
              }
            : null,
      };
      createdCanvases.push(canvas);
      return canvas;
    });

    assert.deepEqual(result, { status: 'context_error' });
    assert.equal(createdCanvases.length, 2);
    for (const c of createdCanvases) {
      assert.equal(c.width, 1);
      assert.equal(c.height, 1);
    }
  });

  it('returns not_found cleanly for tiny images (h <= 20) without throwing', () => {
    const vData = guardBounds(makeScanline(20, () => [200, 200, 200]));
    const hData = guardBounds(makeScanline(40, () => [200, 200, 200]));
    let idx = 0;

    const result = detectAutoCropFromImage({ width: 40, height: 20 }, () => {
      const current = idx++;
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({ data: current === 0 ? hData : vData }),
        }),
      };
    });

    assert.deepEqual(result, { status: 'not_found' });
  });
});
