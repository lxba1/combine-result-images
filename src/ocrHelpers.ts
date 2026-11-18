import { intersectPixelRects } from './settingsHelpers.ts';

export type PixelRect = { x: number; y: number; width: number; height: number };

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: OcrBbox;
}

export interface OcrLine {
  words?: OcrWord[] | null;
}

export interface OcrParagraph {
  lines?: OcrLine[] | null;
}

export interface OcrBlock {
  paragraphs?: OcrParagraph[] | null;
}

export interface OcrSearchPlan {
  searchY: number;
  searchHeight: number;
  quarterWidth: number;
  enemyRoi: PixelRect;
  selfRoi: PixelRect;
}

export interface OcrRoiValidationResult {
  plan: OcrSearchPlan;
  enemyValid: boolean;
  selfValid: boolean;
}

export interface OcrCanvasLike {
  readonly width: number;
  readonly height: number;
  toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
}

export interface OcrWorkerLike<I = Blob | HTMLCanvasElement> {
  recognize: (
    image: I,
    opts?: Record<string, never>,
    output?: { blocks?: boolean }
  ) => Promise<{ data?: { blocks?: OcrBlock[] | null } | null }>;
  terminate: () => Promise<unknown>;
}

export interface OcrWorkerOptions {
  errorHandler?: (err: unknown) => void;
}

export type CreateOcrWorkerFn<
  W extends OcrWorkerLike<I>,
  I = Blob | HTMLCanvasElement,
> = (
  langs: string,
  oem: number,
  options?: OcrWorkerOptions
) => Promise<W>;

export interface ManagedOcrSession<
  W extends OcrWorkerLike<I>,
  C extends OcrCanvasLike = HTMLCanvasElement,
  I = Blob | HTMLCanvasElement,
> {
  worker: W;
  recognizeBlocks: (input: C | Blob) => Promise<OcrBlock[] | null | undefined>;
  terminate: () => Promise<void>;
}

export interface OcrSessionController<
  W extends OcrWorkerLike<I>,
  C extends OcrCanvasLike = HTMLCanvasElement,
  I = Blob | HTMLCanvasElement,
> {
  ready: Promise<ManagedOcrSession<W, C, I>>;
  terminate: () => Promise<void>;
}

export interface StartOcrSessionOptions<
  W extends OcrWorkerLike<I>,
  I = Blob | HTMLCanvasElement,
> {
  createWorkerFn: CreateOcrWorkerFn<W, I>;
  configureWorker?: (worker: W) => Promise<unknown>;
  langs?: string;
  oem?: number;
  initTimeoutMs?: number;
  recognizeTimeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_OCR_INIT_TIMEOUT_MS = 30_000;
export const DEFAULT_OCR_RECOGNIZE_TIMEOUT_MS = 15_000;

/** Returns true when `rect` has positive dimensions and fits entirely within `bounds`. */
export const isRectWithinBounds = (rect: PixelRect, bounds: PixelRect): boolean =>
  Number.isFinite(rect.x) &&
  Number.isFinite(rect.y) &&
  Number.isFinite(rect.width) &&
  Number.isFinite(rect.height) &&
  rect.width > 0 &&
  rect.height > 0 &&
  rect.x >= bounds.x &&
  rect.y >= bounds.y &&
  rect.x + rect.width <= bounds.x + bounds.width &&
  rect.y + rect.height <= bounds.y + bounds.height;

/** Computes the left/right OCR regions of interest relative to the crop rectangle. */
export const computeOcrSearchPlan = (crop: PixelRect): OcrSearchPlan => {
  const searchY = crop.y + Math.floor(crop.height * 0.1);
  const searchHeight = Math.floor(crop.height * 0.11);
  const quarterWidth = Math.floor(crop.width / 4);
  return {
    searchY,
    searchHeight,
    quarterWidth,
    enemyRoi: {
      x: crop.x + quarterWidth * 3,
      y: searchY,
      width: quarterWidth,
      height: searchHeight,
    },
    selfRoi: {
      x: crop.x + quarterWidth,
      y: searchY,
      width: quarterWidth,
      height: searchHeight,
    },
  };
};

/** Clips OCR regions to image bounds and validates that each active ROI keeps positive dimensions. */
export const validateOcrRois = (
  crop: PixelRect,
  imageBounds: PixelRect,
  needsEnemy: boolean,
  needsSelf: boolean
): OcrRoiValidationResult => {
  const rawPlan = computeOcrSearchPlan(crop);
  const clippedEnemy = intersectPixelRects(rawPlan.enemyRoi, imageBounds);
  const clippedSelf = intersectPixelRects(rawPlan.selfRoi, imageBounds);
  return {
    plan: {
      ...rawPlan,
      enemyRoi: clippedEnemy ?? rawPlan.enemyRoi,
      selfRoi: clippedSelf ?? rawPlan.selfRoi,
    },
    enemyValid: !needsEnemy || clippedEnemy !== null,
    selfValid: !needsSelf || clippedSelf !== null,
  };
};

export const normalizeOcrToken = (text: string): string => text.normalize('NFKC').trim();

export const matchesLvLevel = (text: string): boolean => /lv[\s.,:・。]*\d+/i.test(text);

/** Groups OCR words into horizontal visual rows ordered top-to-bottom and left-to-right. */
export const groupWordsIntoRows = <T extends OcrWord>(words: T[]): T[][] => {
  const valid = words
    .filter((w) => normalizeOcrToken(w.text).length > 0 && w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0)
    .sort((a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2);

  const rows: { words: T[]; y0: number; y1: number }[] = [];
  for (const word of valid) {
    const wordCy = (word.bbox.y0 + word.bbox.y1) / 2;
    const wordH = word.bbox.y1 - word.bbox.y0;
    const current = rows[rows.length - 1];
    if (current) {
      const rowCy = (current.y0 + current.y1) / 2;
      const rowH = current.y1 - current.y0;
      const verticalOverlap = Math.min(current.y1, word.bbox.y1) - Math.max(current.y0, word.bbox.y0);
      if (verticalOverlap >= Math.min(wordH, rowH) * 0.2 || Math.abs(wordCy - rowCy) <= Math.max(wordH, rowH) * 0.5) {
        current.words.push(word);
        current.y0 = Math.min(current.y0, word.bbox.y0);
        current.y1 = Math.max(current.y1, word.bbox.y1);
        continue;
      }
    }
    rows.push({ words: [word], y0: word.bbox.y0, y1: word.bbox.y1 });
  }

  return rows.map((row) => row.words.sort((a, b) => a.bbox.x0 - b.bbox.x0));
};

/**
 * Finds the topmost "Lv.<number>" target across ROI words, supporting split tokens
 * such as ["Lv.", "90"] or ["L", "v.", "90"] and whitespace/punctuation variants.
 */
export const findTopmostLvBbox = (words: OcrWord[]): OcrBbox | null => {
  const rows = groupWordsIntoRows(words);
  let bestMatch: OcrBbox | null = null;

  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      for (let j = i; j < Math.min(row.length, i + 5); j++) {
        if (j > i) {
          const prev = row[j - 1].bbox;
          const curr = row[j].bbox;
          const gap = curr.x0 - prev.x1;
          const charHeight = Math.max(4, prev.y1 - prev.y0, curr.y1 - curr.y0);
          if (gap > Math.max(charHeight * 3, 40) || gap < -Math.max(charHeight * 1.5, 16)) {
            break;
          }
        }

        const tokens = row.slice(i, j + 1).map((w) => normalizeOcrToken(w.text));
        const hasLvPrefix =
          /lv/i.test(tokens[0]) ||
          (tokens.length > 1 && /^l$/i.test(tokens[0]) && /^v/i.test(tokens[1]));
        if (!hasLvPrefix) continue;

        const spacedMatch = matchesLvLevel(tokens.join(' '));
        const compactMatch = matchesLvLevel(tokens.join(''));
        if (!spacedMatch && !compactMatch) continue;

        if (j > i) {
          const restTokens = tokens.slice(1);
          if (matchesLvLevel(restTokens.join(' ')) || matchesLvLevel(restTokens.join(''))) {
            continue;
          }
        }

        const matchedWords = row.slice(i, j + 1);
        const matchBox: OcrBbox = {
          x0: Math.min(...matchedWords.map((w) => w.bbox.x0)),
          y0: Math.min(...matchedWords.map((w) => w.bbox.y0)),
          x1: Math.max(...matchedWords.map((w) => w.bbox.x1)),
          y1: Math.max(...matchedWords.map((w) => w.bbox.y1)),
        };

        if (!bestMatch || matchBox.y0 < bestMatch.y0 || (matchBox.y0 === bestMatch.y0 && matchBox.x0 < bestMatch.x0)) {
          bestMatch = matchBox;
        }
        break;
      }
    }
  }

  return bestMatch;
};

/** Flattens Tesseract blocks into words whose bounding boxes are shifted into image coordinates. */
export const extractWordsFromBlocks = (
  blocks: OcrBlock[] | null | undefined,
  offsetX: number,
  offsetY: number
): OcrWord[] =>
  (blocks ?? [])
    .flatMap((b) => b.paragraphs ?? [])
    .flatMap((p) => p.lines ?? [])
    .flatMap((l) => l.words ?? [])
    .map((w) => ({
      text: w.text,
      bbox: {
        x0: w.bbox.x0 + offsetX,
        y0: w.bbox.y0 + offsetY,
        x1: w.bbox.x1 + offsetX,
        y1: w.bbox.y1 + offsetY,
      },
    }));

/** Builds and validates a crop-clipped mask rectangle from a detected "Lv." bounding box. */
export const buildOcrMaskRect = (lvBox: OcrBbox, crop: PixelRect, side: 'right' | 'left'): PixelRect | null => {
  const PADDING = 5;
  const x0 = Math.max(crop.x, Math.floor(lvBox.x0 - PADDING));
  const y0 = Math.max(crop.y, Math.floor(lvBox.y0 - PADDING));
  const x1 = side === 'right' ? crop.x + crop.width : crop.x + Math.floor(crop.width / 2);
  const y1 = Math.min(crop.y + crop.height, Math.ceil(lvBox.y1 + PADDING));
  const rect: PixelRect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return isRectWithinBounds(rect, crop) ? rect : null;
};

const toError = (err: unknown): Error => {
  if (err instanceof Error) return err;
  if (err == null || err === '') {
    return new Error('Unknown OCR worker error');
  }
  return new Error(typeof err === 'string' ? err : String(err));
};

export const createAbortError = (): Error => {
  const err = new Error('OCR operation was aborted');
  err.name = 'AbortError';
  return err;
};

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'AbortError';

/** Converts a canvas into a PNG Blob and rejects cleanly when encoding returns null. */
export const canvasToBlob = (
  canvas: Pick<Required<OcrCanvasLike>, 'toBlob'>
): Promise<Blob> =>
  new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to convert OCR canvas to blob'));
          return;
        }
        resolve(blob);
      });
    } catch (err) {
      reject(toError(err));
    }
  });

const captureSpawnedWorkers = <T>(
  fn: () => T,
  onSpawn: (worker: Worker, scriptUrl?: unknown) => void
): T => {
  const OriginalWorker = globalThis.Worker;
  if (typeof OriginalWorker !== 'function') {
    return fn();
  }

  const ProxiedWorker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget) as Worker;
      onSpawn(instance, args[0]);
      return instance;
    },
  });

  globalThis.Worker = ProxiedWorker;
  try {
    return fn();
  } finally {
    globalThis.Worker = OriginalWorker;
  }
};

interface RaceWithTimeoutAndAbortOptions {
  timeoutMs: number;
  timeoutMessage: string;
  signal?: AbortSignal;
  isAborted?: () => boolean;
  onAbort?: () => void;
  onSettlingError?: () => Promise<void> | void;
  registerHandlers?: (handlers: {
    onError: (err: Error) => void;
    onCancel: () => void;
  }) => () => void;
}

const raceWithAbortAndTimeout = async <T>(
  task: Promise<T>,
  {
    timeoutMs,
    timeoutMessage,
    signal,
    isAborted,
    onAbort,
    onSettlingError,
    registerHandlers,
  }: RaceWithTimeoutAndAbortOptions
): Promise<T> => {
  if (isAborted?.() || signal?.aborted) {
    void task.catch(() => {});
    onAbort?.();
    await Promise.resolve(onSettlingError?.()).catch(() => {});
    throw createAbortError();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let unregisterHandlers: (() => void) | undefined;

    const cleanup = () => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
      signal?.removeEventListener('abort', handleAbort);
      unregisterHandlers?.();
      unregisterHandlers = undefined;
    };

    const settleWithError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      Promise.resolve(onSettlingError?.())
        .catch(() => {})
        .finally(() => reject(err));
    };

    const handleAbort = () => {
      onAbort?.();
      settleWithError(createAbortError());
    };

    unregisterHandlers = registerHandlers?.({
      onError: settleWithError,
      onCancel: handleAbort,
    });

    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
    }

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timerId = setTimeout(() => {
        settleWithError(new Error(timeoutMessage));
      }, timeoutMs);
    }

    task.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        settleWithError(toError(err));
      }
    );
  });
};

/**
 * Starts an OCR session with initialization/recognition timeouts, worker error forwarding,
 * safe app-side Canvas-to-Blob conversion, immediate termination of even still-initializing
 * Web Workers on timeout, error, or abort, and revocation of Worker `blob:` URLs on shutdown.
 */
export const startOcrSession = <
  W extends OcrWorkerLike<I>,
  C extends OcrCanvasLike = HTMLCanvasElement,
  I = Blob | C,
>({
  createWorkerFn,
  configureWorker,
  langs = 'jpn+eng',
  oem = 1,
  initTimeoutMs = DEFAULT_OCR_INIT_TIMEOUT_MS,
  recognizeTimeoutMs = DEFAULT_OCR_RECOGNIZE_TIMEOUT_MS,
  signal,
}: StartOcrSessionOptions<W, I>): OcrSessionController<W, C, I> => {
  let resolvedWorker: W | null = null;
  const spawnedNativeWorkers: Worker[] = [];
  const spawnedBlobUrls: string[] = [];
  const detachNativeErrorListeners: (() => void)[] = [];
  let terminated = false;
  let activeErrorRejector: ((err: Error) => void) | null = null;
  let activeCancelRejector: (() => void) | null = null;

  const terminate = async (): Promise<void> => {
    if (terminated) return;
    terminated = true;
    const cancelPending = activeCancelRejector;
    activeCancelRejector = null;
    cancelPending?.();
    for (const detach of detachNativeErrorListeners) {
      try {
        detach();
      } catch {
        // Ignore cleanup failures.
      }
    }
    detachNativeErrorListeners.length = 0;
    for (const nativeWorker of spawnedNativeWorkers) {
      try {
        nativeWorker.terminate();
      } catch {
        // Ignore cleanup failures on partially initialized workers.
      }
    }
    spawnedNativeWorkers.length = 0;
    if (resolvedWorker) {
      try {
        await resolvedWorker.terminate();
      } catch {
        // Ignore cleanup failures during shutdown.
      }
    }
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      for (const blobUrl of spawnedBlobUrls) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          // Ignore cleanup failures for already-revoked or synthetic URLs.
        }
      }
    }
    spawnedBlobUrls.length = 0;
  };

  const raceWithGuards = <T>(
    task: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<T> =>
    raceWithAbortAndTimeout(task, {
      timeoutMs,
      timeoutMessage,
      signal,
      isAborted: () => terminated,
      onSettlingError: terminate,
      registerHandlers: ({ onError, onCancel }) => {
        activeErrorRejector = onError;
        activeCancelRejector = onCancel;
        return () => {
          if (activeErrorRejector === onError) {
            activeErrorRejector = null;
          }
          if (activeCancelRejector === onCancel) {
            activeCancelRejector = null;
          }
        };
      },
    });

  const ready = (async (): Promise<ManagedOcrSession<W, C, I>> => {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const initDeadline = Date.now() + initTimeoutMs;
    const rawWorkerPromise = captureSpawnedWorkers(
      () =>
        createWorkerFn(langs, oem, {
          errorHandler: (err) => {
            activeErrorRejector?.(toError(err));
          },
        }),
      (nativeWorker, scriptUrl) => {
        spawnedNativeWorkers.push(nativeWorker);
        const normalizedUrl =
          typeof URL !== 'undefined' && scriptUrl instanceof URL ? scriptUrl.href : scriptUrl;
        if (typeof normalizedUrl === 'string' && normalizedUrl.startsWith('blob:')) {
          spawnedBlobUrls.push(normalizedUrl);
        }
        if (typeof nativeWorker.addEventListener === 'function') {
          const onWorkerError = (event: ErrorEvent) => {
            const detail =
              event?.error ?? (event?.message ? new Error(event.message) : new Error('OCR web worker error'));
            activeErrorRejector?.(toError(detail));
          };
          nativeWorker.addEventListener('error', onWorkerError);
          detachNativeErrorListeners.push(() => {
            nativeWorker.removeEventListener?.('error', onWorkerError);
          });
        }
      }
    );

    // Ensure late resolution or rejection after timeout/abort never leaks an orphan worker or unhandled rejection.
    rawWorkerPromise.then(
      (worker) => {
        if (terminated) {
          void worker.terminate().catch(() => {});
        }
      },
      () => {}
    );

    const worker = await raceWithGuards(
      rawWorkerPromise,
      initTimeoutMs,
      'OCR worker initialization timed out'
    );
    resolvedWorker = worker;

    if (terminated || signal?.aborted) {
      await terminate();
      throw createAbortError();
    }

    if (configureWorker) {
      const remainingInitMs = Math.max(1, initDeadline - Date.now());
      await raceWithGuards(
        configureWorker(worker),
        remainingInitMs,
        'OCR worker parameter initialization timed out'
      );
    }

    return {
      worker,
      recognizeBlocks: async (input) => {
        if (terminated || signal?.aborted) {
          throw createAbortError();
        }
        const recognizeDeadline = Date.now() + recognizeTimeoutMs;
        let inputImage: Blob | C;
        if (typeof Blob !== 'undefined' && input instanceof Blob) {
          inputImage = input;
        } else {
          const canvas = input as C;
          if (
            !Number.isFinite(canvas.width) ||
            !Number.isFinite(canvas.height) ||
            canvas.width <= 0 ||
            canvas.height <= 0
          ) {
            throw new Error(`Invalid OCR canvas dimensions: ${canvas.width}x${canvas.height}`);
          }
          // Convert canvas to Blob in app code so null toBlob() rejects cleanly without hitting
          // tesseract.js's unguarded canvas.toBlob wrapper.
          const toBlobFn = canvas.toBlob;
          inputImage =
            typeof toBlobFn === 'function'
              ? await raceWithGuards(
                  canvasToBlob({ toBlob: toBlobFn.bind(canvas) }),
                  recognizeTimeoutMs,
                  'OCR image encoding timed out'
                )
              : canvas;
        }
        const remainingRecognizeMs = Math.max(1, recognizeDeadline - Date.now());
        const result = await raceWithGuards(
          worker.recognize(inputImage as I, {}, { blocks: true }),
          remainingRecognizeMs,
          'OCR recognition timed out'
        );
        return result?.data?.blocks;
      },
      terminate,
    };
  })();

  return { ready, terminate };
};

export interface MutableHolder<T> {
  current: T | null;
}

export interface ReleaseOcrResourcesOptions<
  W extends OcrWorkerLike<I>,
  C extends OcrCanvasLike = HTMLCanvasElement,
  I = Blob | HTMLCanvasElement,
> {
  abort?: boolean;
  expectedAbort?: AbortController;
  expectedSession?: OcrSessionController<W, C, I>;
}

/**
 * Clears active OCR abort/session holders and awaits worker termination.
 * Safe to invoke across early OCR completion cleanup, error handling, and unmount.
 */
export const releaseOcrResources = async <
  W extends OcrWorkerLike<I>,
  C extends OcrCanvasLike = HTMLCanvasElement,
  I = Blob | HTMLCanvasElement,
>(
  abortHolder: MutableHolder<AbortController>,
  sessionHolder: MutableHolder<OcrSessionController<W, C, I>>,
  options?: ReleaseOcrResourcesOptions<W, C, I>
): Promise<void> => {
  if (options?.abort) {
    abortHolder.current?.abort();
  }
  if (!options?.expectedAbort || abortHolder.current === options.expectedAbort) {
    abortHolder.current = null;
  }
  const activeSession = sessionHolder.current;
  if (!options?.expectedSession || activeSession === options.expectedSession) {
    sessionHolder.current = null;
  }
  const targetSession = options?.expectedSession ?? activeSession;
  if (targetSession) {
    // Attach a noop rejection handler before terminating so an unawaited `ready` promise
    // never triggers an unhandled rejection if cleanup runs before `await session.ready`.
    targetSession.ready?.catch(() => {});
    await targetSession.terminate();
  }
};

export interface OcrScratchContextLike<B = CanvasImageSource> {
  clearRect: (x: number, y: number, w: number, h: number) => void;
  drawImage: (
    image: B,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ) => void;
}

export interface OcrScratchCanvasLike<B = CanvasImageSource> extends OcrCanvasLike {
  width: number;
  height: number;
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ) => OcrScratchContextLike<B> | null;
}

export type OcrMaskDetectionResult =
  | {
      status: 'ok';
      enemyMaskRect: PixelRect | null;
      selfMaskRect: PixelRect | null;
    }
  | {
      status: 'not_found';
      enemyMissing: boolean;
      selfMissing: boolean;
    }
  | { status: 'aborted' }
  | { status: 'error'; error: unknown };

export interface RunOcrMaskDetectionOptions<
  W extends OcrWorkerLike<I>,
  C extends OcrScratchCanvasLike<B>,
  B extends { readonly width: number; readonly height: number } = ImageBitmap,
  I = Blob | C,
> {
  sourceImage: B;
  cropRect: PixelRect;
  needsEnemyOcr: boolean;
  needsSelfOcr: boolean;
  abortHolder: MutableHolder<AbortController>;
  sessionHolder: MutableHolder<OcrSessionController<W, C, I>>;
  startSession: (signal: AbortSignal) => OcrSessionController<W, C, I>;
  createCanvas?: () => C;
  encodeTimeoutMs?: number;
  onStatus?: (status: 'starting') => void;
  onSourceConsumed?: () => void;
}

/**
 * Validates OCR ROIs, acquires the scratch 2D canvas context BEFORE starting the worker session
 * (so context creation failures never leave an unawaited `ready` promise or timer), registers
 * cancellation before pre-encoding tiny ROI PNG blobs with timeout and abort guards so the caller
 * can release the full source bitmap before worker startup, confirms cancellation before spawning
 * the worker, runs Lv. detection, and awaits cleanup + `ready` settlement across every exit path.
 */
export const runOcrMaskDetection = async <
  W extends OcrWorkerLike<I>,
  C extends OcrScratchCanvasLike<B>,
  B extends { readonly width: number; readonly height: number } = ImageBitmap,
  I = Blob | C,
>({
  sourceImage,
  cropRect,
  needsEnemyOcr,
  needsSelfOcr,
  abortHolder,
  sessionHolder,
  startSession,
  createCanvas = () => document.createElement('canvas') as unknown as C,
  encodeTimeoutMs = DEFAULT_OCR_RECOGNIZE_TIMEOUT_MS,
  onStatus,
  onSourceConsumed,
}: RunOcrMaskDetectionOptions<W, C, B, I>): Promise<OcrMaskDetectionResult> => {
  if (!needsEnemyOcr && !needsSelfOcr) {
    return { status: 'ok', enemyMaskRect: null, selfMaskRect: null };
  }

  const imageBounds: PixelRect = {
    x: 0,
    y: 0,
    width: sourceImage.width,
    height: sourceImage.height,
  };
  const { plan, enemyValid, selfValid } = validateOcrRois(
    cropRect,
    imageBounds,
    needsEnemyOcr,
    needsSelfOcr
  );

  if (!enemyValid || !selfValid) {
    return {
      status: 'not_found',
      enemyMissing: !enemyValid,
      selfMissing: !selfValid,
    };
  }

  const scratch = createCanvas();
  const sctx = scratch.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!sctx) {
    scratch.width = scratch.height = 1;
    return {
      status: 'error',
      error: new Error('Failed to get 2D context for OCR scratch canvas'),
    };
  }

  const resetScratch = (): void => {
    if (scratch.width !== 1 || scratch.height !== 1) {
      scratch.width = scratch.height = 1;
    }
  };

  const drawRoiToScratch = (roi: PixelRect): void => {
    scratch.width = roi.width;
    scratch.height = roi.height;
    sctx.clearRect(0, 0, roi.width, roi.height);
    sctx.drawImage(
      sourceImage,
      roi.x,
      roi.y,
      roi.width,
      roi.height,
      0,
      0,
      roi.width,
      roi.height
    );
  };

  const abortController = new AbortController();
  abortHolder.current = abortController;
  let sessionHandle: OcrSessionController<W, C, I> | undefined;

  let enemyBlob: Blob | null = null;
  let selfBlob: Blob | null = null;
  let enemyMaskRect: PixelRect | null = null;
  let selfMaskRect: PixelRect | null = null;
  const canPreEncodeBlobs = typeof scratch.toBlob === 'function';

  try {
    if (canPreEncodeBlobs) {
      const toBlobFn = scratch.toBlob!.bind(scratch);
      const hasFiniteEncodeTimeout = encodeTimeoutMs > 0 && Number.isFinite(encodeTimeoutMs);
      const encodeDeadline = Date.now() + encodeTimeoutMs;

      const preEncodeRoi = async (roi: PixelRect): Promise<Blob> => {
        if (abortController.signal.aborted) {
          throw createAbortError();
        }
        drawRoiToScratch(roi);
        const remainingTimeoutMs = hasFiniteEncodeTimeout
          ? Math.max(1, encodeDeadline - Date.now())
          : encodeTimeoutMs;
        return raceWithAbortAndTimeout(canvasToBlob({ toBlob: toBlobFn }), {
          timeoutMs: remainingTimeoutMs,
          timeoutMessage: 'OCR image encoding timed out',
          signal: abortController.signal,
          onAbort: resetScratch,
        });
      };

      try {
        if (needsEnemyOcr) {
          enemyBlob = await preEncodeRoi(plan.enemyRoi);
        }
        if (needsSelfOcr) {
          selfBlob = await preEncodeRoi(plan.selfRoi);
        }
      } finally {
        resetScratch();
      }

      if (abortController.signal.aborted) {
        throw createAbortError();
      }
      // Release the full-resolution source bitmap before spinning up Tesseract WASM/language data.
      onSourceConsumed?.();
    }

    if (abortController.signal.aborted) {
      throw createAbortError();
    }
    onStatus?.('starting');
    if (abortController.signal.aborted) {
      throw createAbortError();
    }

    sessionHandle = startSession(abortController.signal);
    sessionHolder.current = sessionHandle;

    const session = await sessionHandle.ready;

    const detectOcrRect = async (
      roi: PixelRect,
      side: 'right' | 'left',
      preEncodedBlob: Blob | null
    ): Promise<PixelRect | null> => {
      let input: C | Blob;
      if (preEncodedBlob) {
        input = preEncodedBlob;
      } else {
        drawRoiToScratch(roi);
        input = scratch;
      }
      const blocks = await session.recognizeBlocks(input);
      const words = extractWordsFromBlocks(blocks, roi.x, roi.y);
      const targetBox = findTopmostLvBbox(words);
      return targetBox ? buildOcrMaskRect(targetBox, cropRect, side) : null;
    };

    if (needsEnemyOcr) {
      enemyMaskRect = await detectOcrRect(plan.enemyRoi, 'right', enemyBlob);
    }
    if (needsSelfOcr) {
      selfMaskRect = await detectOcrRect(plan.selfRoi, 'left', selfBlob);
    }
  } catch (e) {
    if (isAbortError(e) || abortController.signal.aborted) {
      return { status: 'aborted' };
    }
    return { status: 'error', error: e };
  } finally {
    resetScratch();
    if (sessionHandle) {
      await releaseOcrResources(abortHolder, sessionHolder, {
        expectedAbort: abortController,
        expectedSession: sessionHandle,
      });
      await sessionHandle.ready.catch(() => {});
    } else if (abortHolder.current === abortController) {
      abortHolder.current = null;
    }
  }

  const enemyMissing = needsEnemyOcr && !enemyMaskRect;
  const selfMissing = needsSelfOcr && !selfMaskRect;
  if (enemyMissing || selfMissing) {
    return { status: 'not_found', enemyMissing, selfMissing };
  }

  return { status: 'ok', enemyMaskRect, selfMaskRect };
};

/**
 * Mask rectangles OCR found on one source image within one crop. The result depends only on
 * those two inputs, so a re-run with the same first image and crop can reuse it.
 */
export interface OcrMaskCacheEntry<F> {
  /** The source file itself (identity, not name): a File never changes its contents. */
  file: F;
  cropRect: PixelRect;
  enemyMaskRect: PixelRect | null;
  selfMaskRect: PixelRect | null;
}

export interface DetectOcrMasksWithCacheOptions<F> {
  cacheHolder: MutableHolder<OcrMaskCacheEntry<F>>;
  file: F;
  cropRect: PixelRect;
  needsEnemyOcr: boolean;
  needsSelfOcr: boolean;
  /** Runs OCR for the given sides only (e.g. `runOcrMaskDetection`). */
  detect: (sides: { needsEnemyOcr: boolean; needsSelfOcr: boolean }) => Promise<OcrMaskDetectionResult>;
}

const isSamePixelRect = (a: PixelRect, b: PixelRect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Runs OCR only for the sides that are not already cached for this file and crop, and returns
 * the combined result. When every requested side is cached, `detect` is not called at all, so no
 * OCR worker starts. Only successful detections are cached; not-found, error and aborted results
 * leave the cache unchanged so the next run tries again.
 */
export const detectOcrMasksWithCache = async <F>({
  cacheHolder,
  file,
  cropRect,
  needsEnemyOcr,
  needsSelfOcr,
  detect,
}: DetectOcrMasksWithCacheOptions<F>): Promise<OcrMaskDetectionResult> => {
  const cached = cacheHolder.current;
  const usable =
    cached && cached.file === file && isSamePixelRect(cached.cropRect, cropRect) ? cached : null;
  const cachedEnemy = needsEnemyOcr ? (usable?.enemyMaskRect ?? null) : null;
  const cachedSelf = needsSelfOcr ? (usable?.selfMaskRect ?? null) : null;
  const runEnemy = needsEnemyOcr && !cachedEnemy;
  const runSelf = needsSelfOcr && !cachedSelf;

  if (!runEnemy && !runSelf) {
    return { status: 'ok', enemyMaskRect: cachedEnemy, selfMaskRect: cachedSelf };
  }

  const outcome = await detect({ needsEnemyOcr: runEnemy, needsSelfOcr: runSelf });
  if (outcome.status !== 'ok') {
    return outcome;
  }

  const enemyMaskRect = runEnemy ? outcome.enemyMaskRect : cachedEnemy;
  const selfMaskRect = runSelf ? outcome.selfMaskRect : cachedSelf;
  cacheHolder.current = {
    file,
    cropRect: { ...cropRect },
    // Keep a side that was cached but not requested this time (e.g. its mask was switched off).
    enemyMaskRect: enemyMaskRect ?? usable?.enemyMaskRect ?? null,
    selfMaskRect: selfMaskRect ?? usable?.selfMaskRect ?? null,
  };
  return { status: 'ok', enemyMaskRect, selfMaskRect };
};
