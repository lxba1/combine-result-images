import type { PixelRect } from './ocrHelpers.ts';

export interface BitmapLike {
  close: () => void;
}

export interface TileMaskRect extends PixelRect {
  color: string;
}

export interface MontageContextLike<B extends BitmapLike, C> {
  drawImage: {
    (image: C, dx: number, dy: number): void;
    (
      image: B,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ): void;
  };
}

export interface TileTempContextLike<B extends BitmapLike> {
  fillStyle: string | CanvasGradient | CanvasPattern;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  fillRect: (x: number, y: number, w: number, h: number) => void;
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

export interface TileTempCanvasLike<B extends BitmapLike> {
  width: number;
  height: number;
  getContext: (
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ) => TileTempContextLike<B> | null;
}

export interface BuildTileMaskRectsParams {
  cropRect: PixelRect;
  maskEnabled: boolean;
  maskRect: PixelRect | null;
  maskColor: string;
  selfMaskEnabled: boolean;
  selfMaskRect: PixelRect | null;
  selfMaskColor: string;
}

export interface RenderMontageTilesOptions<
  F,
  B extends BitmapLike,
  C extends TileTempCanvasLike<B> = TileTempCanvasLike<B>,
> {
  files: readonly F[];
  colCount: number;
  offsetX: number;
  offsetY: number;
  cropRect: PixelRect;
  masks: readonly TileMaskRect[];
  montageCtx: MontageContextLike<B, C>;
  decodeImage: (file: F) => Promise<B>;
  yieldFrame?: () => Promise<void>;
  createTempCanvas?: () => C;
}

/** Converts enabled mask rectangles from full-image space into tile-relative coordinates. */
export const buildTileMaskRects = (params: BuildTileMaskRectsParams): TileMaskRect[] => {
  const masks: TileMaskRect[] = [];
  if (params.maskEnabled && params.maskRect && params.maskRect.width > 0 && params.maskRect.height > 0) {
    masks.push({
      x: params.maskRect.x - params.cropRect.x,
      y: params.maskRect.y - params.cropRect.y,
      width: params.maskRect.width,
      height: params.maskRect.height,
      color: params.maskColor,
    });
  }
  if (
    params.selfMaskEnabled &&
    params.selfMaskRect &&
    params.selfMaskRect.width > 0 &&
    params.selfMaskRect.height > 0
  ) {
    masks.push({
      x: params.selfMaskRect.x - params.cropRect.x,
      y: params.selfMaskRect.y - params.cropRect.y,
      width: params.selfMaskRect.width,
      height: params.selfMaskRect.height,
      color: params.selfMaskColor,
    });
  }
  return masks;
};

const defaultYieldFrame = (): Promise<void> =>
  typeof requestAnimationFrame === 'function'
    ? new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    : Promise.resolve();

/**
 * Draws cropped image tiles onto the montage context, guaranteeing each decoded ImageBitmap is
 * closed in a `finally` block and allocating a temporary canvas only once when masks are active.
 */
export const renderMontageTiles = async <
  F,
  B extends BitmapLike,
  C extends TileTempCanvasLike<B> = TileTempCanvasLike<B>,
>(
  options: RenderMontageTilesOptions<F, B, C>
): Promise<void> => {
  const {
    files,
    colCount,
    offsetX,
    offsetY,
    cropRect,
    masks,
    montageCtx,
    decodeImage,
    yieldFrame = defaultYieldFrame,
    createTempCanvas = () => document.createElement('canvas') as unknown as C,
  } = options;

  if (files.length === 0) {
    return;
  }

  let tempCanvas: C | null = null;
  let tempCtx: TileTempContextLike<B> | null = null;

  try {
    if (masks.length > 0) {
      tempCanvas = createTempCanvas();
      tempCanvas.width = cropRect.width;
      tempCanvas.height = cropRect.height;
      tempCtx = tempCanvas.getContext('2d', { alpha: false });
      if (!tempCtx) {
        throw new Error('Could not get reusable temporary canvas context');
      }
    }

    for (let i = 0; i < files.length; i++) {
      const row = Math.floor(i / colCount);
      const col = i % colCount;
      const drawX = offsetX + col * (cropRect.width + offsetX);
      const drawY = offsetY + row * (cropRect.height + offsetY);

      const bitmap = await decodeImage(files[i]);
      try {
        if (tempCanvas && tempCtx) {
          // Clear rather than reassigning canvas width/height, which would reallocate the backing store each frame.
          tempCtx.clearRect(0, 0, cropRect.width, cropRect.height);
          tempCtx.drawImage(
            bitmap,
            cropRect.x,
            cropRect.y,
            cropRect.width,
            cropRect.height,
            0,
            0,
            cropRect.width,
            cropRect.height
          );
        } else {
          montageCtx.drawImage(
            bitmap,
            cropRect.x,
            cropRect.y,
            cropRect.width,
            cropRect.height,
            drawX,
            drawY,
            cropRect.width,
            cropRect.height
          );
        }
      } finally {
        bitmap.close();
      }

      if (tempCanvas && tempCtx) {
        for (const mask of masks) {
          tempCtx.fillStyle = mask.color;
          tempCtx.fillRect(mask.x, mask.y, mask.width, mask.height);
        }
        montageCtx.drawImage(tempCanvas, drawX, drawY);
      }

      await yieldFrame();
    }
  } finally {
    if (tempCanvas) {
      tempCanvas.width = 1;
      tempCanvas.height = 1;
    }
  }
};
