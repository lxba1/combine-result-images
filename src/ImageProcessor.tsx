import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Input, Switch, FormControlLabel, Select, MenuItem, InputLabel, FormControl, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import { PlayArrow, ExpandMore as ExpandMoreIcon, GetApp as DownloadIcon, AddPhotoAlternate as AddPhotoIcon } from '@mui/icons-material';
import type { SelectChangeEvent } from '@mui/material';
import Tesseract, { PSM, type Block, type Line, type Word, type Paragraph } from 'tesseract.js';
import packageJson from '../package.json';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
type RatioRect = { rx0: number; ry0: number; rx1: number; ry1: number };

const MASK_PRESETS: Record<string, RatioRect> = {
  name:  { rx0: 0.785, ry0: 0.14, rx1: 1.0,  ry1: 0.2 },
  title: { rx0: 0.785, ry0: 0.11, rx1: 1.0,  ry1: 0.33 },
  full:  { rx0: 0.7, ry0: 0.11, rx1: 1.0,  ry1: 0.33 },
};

const SELF_MASK_PRESETS: Record<string, RatioRect> = {
  name:  { rx0: 0.269, ry0: 0.14, rx1: 0.5, ry1: 0.2 },
  title: { rx0: 0.269, ry0: 0.11, rx1: 0.5, ry1: 0.33 },
  full:  { rx0: 0.185, ry0: 0.11, rx1: 0.5, ry1: 0.33 },
};

type MaskMode = 'manual' | 'ratio' | 'ocr';

interface ImageSettings {
  colCount: number;
  offsetX: number;
  offsetY: number;
  bgColor: string;
  outputFormat: 'webp' | 'png' | 'jpeg';
  quality: number;
  webpMethod: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  maskEnabled: boolean;
  maskX: number;
  maskY: number;
  maskWidth: number;
  maskHeight: number;
  maskColor: string;
  maskRatioRect: RatioRect;
  cropAuto: boolean;
  maskMode: MaskMode;
  selfMaskEnabled: boolean;
  selfMaskMode: MaskMode;
  selfMaskX: number;
  selfMaskY: number;
  selfMaskWidth: number;
  selfMaskHeight: number;
  selfMaskColor: string;
  selfMaskRatioRect: RatioRect;
}

const ImageProcessor: React.FC = () => {
  const { t } = useTranslation();

  const [settings, setSettings] = useState<ImageSettings>(() => {
    const savedSettings = localStorage.getItem('imageProcessorSettings');
    const defaults: ImageSettings = {
      colCount: 2,
      offsetX: 8,
      offsetY: 8,
      bgColor: '#000000',
      outputFormat: 'webp',
      quality: 80,
      webpMethod: 6,
      cropX: 31,
      cropY: 117,
      cropWidth: 1538,
      cropHeight: 665,
      cropAuto: true,
      maskEnabled: false,
      maskMode: 'ratio',
      maskX: 0,
      maskY: 0,
      maskWidth: 100,
      maskHeight: 100,
      maskColor: '#FFFFFF',
      maskRatioRect: MASK_PRESETS.name,
      selfMaskEnabled: false,
      selfMaskMode: 'ratio',
      selfMaskX: 0,
      selfMaskY: 0,
      selfMaskWidth: 100,
      selfMaskHeight: 100,
      selfMaskColor: '#FFFFFF',
      selfMaskRatioRect: SELF_MASK_PRESETS.name,
    };
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      // Migration for old settings
      if (parsed.maskAuto !== undefined) {
        parsed.maskMode = parsed.maskAuto ? 'ocr' : 'manual';
        delete parsed.maskAuto;
      }
      if (parsed.selfMaskAuto !== undefined) {
        parsed.selfMaskMode = parsed.selfMaskAuto ? 'ocr' : 'manual';
        delete parsed.selfMaskAuto;
      }
      return { ...defaults, ...parsed };
    }
    return defaults;
  });

  useEffect(() => {
    localStorage.setItem('imageProcessorSettings', JSON.stringify(settings));
  }, [settings]);

  const [images, setImages] = useState<File[]>([]);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string>('tile.webp');
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Tesseract.Worker | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Terminate the worker when the component unmounts
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    // This effect manages the lifecycle of the generated object URL.
    // It runs when the component unmounts or before the effect runs again
    // (i.e., when processedImageUrl changes).
    return () => {
      if (processedImageUrl && processedImageUrl.startsWith('blob:')) {
        URL.revokeObjectURL(processedImageUrl);
      }
    };
  }, [processedImageUrl]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setImages(Array.from(event.target.files));
      setProcessedImageUrl(null); // This will also trigger the cleanup effect for the old URL
    }
  };

  const handleSettingChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number | string>) => {
    const name = event.target.name;
    let newValue: string | number | boolean;

    if ('type' in event.target && event.target.type === 'checkbox') { // Checkbox
        newValue = (event.target as HTMLInputElement).checked;
    } else if ('type' in event.target && event.target.type === 'number') { // TextField type="number"
        // Handle float for ratio inputs, int for pixels
        if (name.includes('RatioRect')) {
             newValue = parseFloat(event.target.value as string) || 0;
        } else {
             newValue = parseInt(event.target.value as string, 10) || 0;
        }
    } else if (name === 'colCount' || name === 'offsetX') { // Select components with numeric values
        newValue = event.target.value as number;
    } else { // Default for other text inputs (e.g., color pickers) or string selects
        newValue = event.target.value;
    }
    // Special handling for offsetX to also update offsetY
    if (name === 'offsetX') {
        setSettings(prev => ({
            ...prev,
            offsetX: newValue as number,
            offsetY: newValue as number,
        }));
        return;
    }

    if (name === 'outputFormat') {
        setProcessedImageUrl(null);
    }

    if (name.startsWith('maskRatioRect.') || name.startsWith('selfMaskRatioRect.')) {
        const [parent, key] = name.split('.');
        setSettings(prev => ({
            ...prev,
            [parent]: {
                ...(prev[parent as keyof ImageSettings] as RatioRect),
                [key]: newValue as number
            }
        }));
        return;
    }

    setSettings(prev => ({
      ...prev,
      [name]: newValue as number, // Ensure it's a number for ImageSettings
    }));
  };

  const handleSliderChange = (name: string) => (_event: Event, value: number | number[]) => {
    const numValue = value as number;
    setSettings(prev => {
        if (name === 'offsetX') { // If the offset slider is moved, update both X and Y
            return { ...prev, offsetX: numValue, offsetY: numValue };
        }
        return { ...prev, [name]: numValue };
    });
  };

  const handleRatioSliderChange = (parent: 'maskRatioRect' | 'selfMaskRatioRect', axis: 'horizontal' | 'vertical') => (_event: Event, value: number | number[]) => {
    if (!Array.isArray(value)) return;
    const [start, end] = value;
    setSettings(prev => ({
        ...prev,
        [parent]: {
            ...(prev[parent] as RatioRect),
            ...(axis === 'horizontal' ? { rx0: start, rx1: end } : { ry0: start, ry1: end })
        }
    }));
  };

  const handlePresetChange = (parent: 'maskRatioRect' | 'selfMaskRatioRect') => (event: SelectChangeEvent<string>) => {
    const presetKey = event.target.value;
    const presets = parent === 'maskRatioRect' ? MASK_PRESETS : SELF_MASK_PRESETS;
    if (presetKey && presets[presetKey]) {
        setSettings(prev => ({
            ...prev,
            [parent]: { ...presets[presetKey] }
        }));
    }
  };

  const getActivePreset = (current: RatioRect, presets: Record<string, RatioRect>): string => {
      // Simple equality check with tolerance could be better, but strict match is fine for presets
      const isMatch = (a: RatioRect, b: RatioRect) =>
          Math.abs(a.rx0 - b.rx0) < 0.0001 && Math.abs(a.ry0 - b.ry0) < 0.0001 &&
          Math.abs(a.rx1 - b.rx1) < 0.0001 && Math.abs(a.ry1 - b.ry1) < 0.0001;

      for (const [key, val] of Object.entries(presets)) {
          if (isMatch(current, val)) return key;
      }
      return 'custom';
  };

  async function decodeFirst(file: File): Promise<ImageBitmap> {
    try {
      return await createImageBitmap(file);
    } catch (error) {
      console.warn("createImageBitmap failed, falling back to Image element:", error);
      // Add a delay before retrying to let the browser recover
      await new Promise(resolve => setTimeout(resolve, 200));
      // Retry with an alternative path if createImageBitmap fails
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error(`Failed to load image from object URL`));
          img.src = url;
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true, alpha: false })!;
        ctx.drawImage(img, 0, 0);
        return await createImageBitmap(c);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  const loadAndDrawFirstImage = async (): Promise<ImageBitmap | null> => {
    if (images.length === 0) return null;
    const firstImageFile = images[0];
    try {
      const bitmap = await decodeFirst(firstImageFile); // Call decodeFirst
      return bitmap;
    } catch (error) {
      console.error("Failed to decode first image even with fallback:", error);
      throw new Error('First image failed to load.');
    }
  };

  const processImages = async () => {
    if (images.length === 0) {
      alert(t('alert_select_images_first'));
      return;
    }

    const validateSettings = (): boolean => {
        if (isNaN(settings.colCount) || settings.colCount <= 0) {
            alert(t('alert_columns_must_be_positive'));
            return false;
        }
        if (isNaN(settings.offsetX) || settings.offsetX < 0) {
            alert(t('alert_offset_cannot_be_empty_or_negative'));
            return false;
        }
        if (isNaN(settings.offsetY) || settings.offsetY < 0) {
            alert(t('alert_offset_cannot_be_empty_or_negative'));
            return false;
        }
        return true;
    };

    if (!validateSettings()) {
      return;
    }

    setIsProcessing(true);
    setProcessedImageUrl(null);
    setOcrStatus('');

    // Add a short delay to allow the UI to update (e.g., show spinner) before blocking the main thread.
    await new Promise(resolve => setTimeout(resolve, 200));

    let firstImageBitmap: ImageBitmap | null = null;
    let reusableTempCanvas: HTMLCanvasElement | null = null;
    let reusableTempCtx: CanvasRenderingContext2D | null = null;
    try {
      let cropRect = { x: settings.cropX, y: settings.cropY, width: settings.cropWidth, height: settings.cropHeight };
      let enemyMaskRect = { x: settings.maskX, y: settings.maskY, width: settings.maskWidth, height: settings.maskHeight };
      let selfMaskRect = { x: settings.selfMaskX, y: settings.selfMaskY, width: settings.selfMaskWidth, height: settings.selfMaskHeight };
      const newSettings: Partial<ImageSettings> = {};

      const needsFirstImage = settings.cropAuto ||
        (settings.maskEnabled && (settings.maskMode === 'ratio' || settings.maskMode === 'ocr')) ||
        (settings.selfMaskEnabled && (settings.selfMaskMode === 'ratio' || settings.selfMaskMode === 'ocr'));

      if (needsFirstImage) {
          firstImageBitmap = await loadAndDrawFirstImage();
          if (!firstImageBitmap) return;
      }
      if (settings.cropAuto && firstImageBitmap) {
        const performAutoCrop = (firstImageBitmap: ImageBitmap): boolean => {
            const w = firstImageBitmap.width;
            const h = firstImageBitmap.height;
            const getLuminance = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

            // 1. Create a small canvas for the horizontal center line
            const yMid = Math.floor(h / 2);
            const hCanvas = document.createElement('canvas');
            hCanvas.width = w;
            hCanvas.height = 1;
            const hCtx = hCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
            if (!hCtx) return false;

            // 2. Draw only the center row onto the small canvas
            hCtx.drawImage(firstImageBitmap, 0, yMid, w, 1, 0, 0, w, 1);
            const hData = hCtx.getImageData(0, 0, w, 1).data;
            hCanvas.width = hCanvas.height = 1; // Deallocate

            // 3. Create a small canvas for the vertical center line
            const xMid = Math.floor(w / 2);
            const vCanvas = document.createElement('canvas');
            vCanvas.width = 1;
            vCanvas.height = h;
            const vCtx = vCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
            if (!vCtx) return false;

            // 4. Draw only the center column onto the small canvas
            vCtx.drawImage(firstImageBitmap, xMid, 0, 1, h, 0, 0, 1, h);
            const vData = vCtx.getImageData(0, 0, 1, h).data;
            vCanvas.width = vCanvas.height = 1; // Deallocate

            const findHEdge = (isRight: boolean, currentThreshold: number): number | null => {
                const ASPECT_LIMIT = 2.1;
                const skipX = w / h > ASPECT_LIMIT ? Math.floor((w - h * ASPECT_LIMIT) / 2) + 1 : 0;
                for (let x = isRight ? w - skipX - 2 : skipX + 1; isRight ? x > 0 : x < w; isRight ? x-- : x++) {
                    if (Math.abs(getLuminance(hData, x * 4) - getLuminance(hData, (x + (isRight ? 1 : -1)) * 4)) > currentThreshold) return x;
                }
                return null;
            };

            const findVEdge = (isBottom: boolean, currentThreshold: number): number | null => {
                for (let y = isBottom ? Math.floor(h * 0.95) : 1; isBottom ? y > 0 : y < h; isBottom ? y-- : y++) {
                    if (Math.abs(getLuminance(vData, y * 4) - getLuminance(vData, (y + (isBottom ? 1 : -1)) * 4)) > currentThreshold) return y;
                }
                return null;
            };

            const plausible = (r: {x:number; y:number; width:number; height:number}) => {
                if (r.width < w * 0.65) return false;
                if (r.height < h * 0.50) return false;
                if (r.y + r.height > h * 0.95 + 2) return false;
                const aspect = r.width / r.height;
                if (aspect < 1.05 || aspect > 2.7) return false;
                return true;
            };

            const thresholds = [100, 80, 60, 40];

            for (const t of thresholds) {
                const left = findHEdge(false, t);
                const right = findHEdge(true, t);
                const top = findVEdge(false, t);
                const bottom = findVEdge(true, t);

                if (left !== null && right !== null && top !== null && bottom !== null) {
                    const rect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };

                    if (plausible(rect)) {
                        cropRect = rect;
                        Object.assign(newSettings, cropRect);
                        //console.log(`Auto crop matched at threshold: ${t}`);
                        return true;
                    }
                }
            }

            alert(t('alert_failed_to_detect_crop_area'));
            newSettings.cropAuto = false;
            return false;
        };
        if (!performAutoCrop(firstImageBitmap)) {
          setSettings(prev => ({ ...prev, ...newSettings }));
          return;
        }
      }

      // Ratio calculation
      if (firstImageBitmap) {
        if (settings.maskEnabled && settings.maskMode === 'ratio') {
          const r = settings.maskRatioRect;
          const x0 = cropRect.x + Math.round(clamp01(r.rx0) * cropRect.width);
          const y0 = cropRect.y + Math.round(clamp01(r.ry0) * cropRect.height);
          const x1 = cropRect.x + Math.round(clamp01(r.rx1) * cropRect.width);
          const y1 = cropRect.y + Math.round(clamp01(r.ry1) * cropRect.height);
          enemyMaskRect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
          Object.assign(newSettings, { maskX: enemyMaskRect.x, maskY: enemyMaskRect.y, maskWidth: enemyMaskRect.width, maskHeight: enemyMaskRect.height });
        }
        if (settings.selfMaskEnabled && settings.selfMaskMode === 'ratio') {
          const r = settings.selfMaskRatioRect;
          const x0 = cropRect.x + Math.round(clamp01(r.rx0) * cropRect.width);
          const y0 = cropRect.y + Math.round(clamp01(r.ry0) * cropRect.height);
          const x1 = cropRect.x + Math.round(clamp01(r.rx1) * cropRect.width);
          const y1 = cropRect.y + Math.round(clamp01(r.ry1) * cropRect.height);
          selfMaskRect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
          Object.assign(newSettings, { selfMaskX: selfMaskRect.x, selfMaskY: selfMaskRect.y, selfMaskWidth: selfMaskRect.width, selfMaskHeight: selfMaskRect.height });
        }
      }

      // OCR calculation
      if (firstImageBitmap && (
        (settings.maskEnabled && settings.maskMode === 'ocr') ||
        (settings.selfMaskEnabled && settings.selfMaskMode === 'ocr')
      )) {
        setOcrStatus(t('ocr_status_starting'));
        const worker = await Tesseract.createWorker('jpn+eng', 1);
        workerRef.current = worker;
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });

        try {
            const scratch = document.createElement('canvas');
            const sctx = scratch.getContext('2d', { willReadFrequently: true, alpha: false })!;

            async function recognizeROI(sx: number, sy: number, sw: number, sh: number) {
              scratch.width = sw; scratch.height = sh;
              sctx.clearRect(0, 0, sw, sh);
              sctx.drawImage(firstImageBitmap!, sx, sy, sw, sh, 0, 0, sw, sh);
              const { data } = await worker!.recognize(scratch, {}, { blocks: true });
              return (data?.blocks ?? [])
                .flatMap((b: Block) => b.paragraphs)
                .flatMap((p: Paragraph) => p.lines)
                .flatMap((l: Line) => l.words)
                .map((w: Word) => ({ ...w, bbox: { x0: w.bbox.x0 + sx, y0: w.bbox.y0 + sy, x1: w.bbox.x1 + sx, y1: w.bbox.y1 + sy } }));
            }

            const searchY = cropRect.y + Math.floor(cropRect.height * 0.1);
            const searchHeight = Math.floor(cropRect.height * 0.11);
            const quarterWidth = Math.floor(cropRect.width / 4);

            const PADDING = 5;
            if (settings.maskEnabled && settings.maskMode === 'ocr') {
                const enemyWords = await recognizeROI(cropRect.x + (quarterWidth * 3), searchY, quarterWidth, searchHeight);
                const enemyLvWords = enemyWords.filter((w: Word) => /Lv\.\d+/i.test(w.text));
                if (enemyLvWords.length > 0) {
                    const target = enemyLvWords.reduce((p: Word, c: Word) => (p.bbox.y0 < c.bbox.y0 ? p : c));
                    const { x0, y0, y1 } = target.bbox;
                    enemyMaskRect = { x: Math.max(cropRect.x, x0 - PADDING), y: Math.max(cropRect.y, y0 - PADDING), width: Math.max(0, (cropRect.x + cropRect.width) - Math.max(cropRect.x, x0 - PADDING)), height: Math.max(0, (y1 + PADDING) - Math.max(cropRect.y, y0 - PADDING)) };
                    Object.assign(newSettings, { maskX: enemyMaskRect.x, maskY: enemyMaskRect.y, maskWidth: enemyMaskRect.width, maskHeight: enemyMaskRect.height });
                }
            }
            if (settings.selfMaskEnabled && settings.selfMaskMode === 'ocr') {
                const selfWords = await recognizeROI(cropRect.x + quarterWidth, searchY, quarterWidth, searchHeight);
                const selfLvWords = selfWords.filter((w: Word) => /Lv\.\d+/i.test(w.text));
                if (selfLvWords.length > 0) {
                    const target = selfLvWords.reduce((p: Word, c: Word) => (p.bbox.y0 < c.bbox.y0 ? p : c));
                    const { x0, y0, y1 } = target.bbox;
                    const cropCenterX = cropRect.x + Math.floor(cropRect.width / 2);
                    selfMaskRect = { x: Math.max(cropRect.x, x0 - PADDING), y: Math.max(cropRect.y, y0 - PADDING), width: Math.max(0, cropCenterX - Math.max(cropRect.x, x0 - PADDING)), height: Math.max(0, (y1 + PADDING) - Math.max(cropRect.y, y0 - PADDING)) };
                    Object.assign(newSettings, { selfMaskX: selfMaskRect.x, selfMaskY: selfMaskRect.y, selfMaskWidth: selfMaskRect.width, selfMaskHeight: selfMaskRect.height });
                }
            }
            scratch.width = scratch.height = 1;
            setOcrStatus(t('ocr_status_mask_detected'));
        } catch (e) { console.error(e); alert(t('alert_ocr_error')); }
      }

      // Early release of the first image bitmap as it's no longer needed
      if (firstImageBitmap) {
        firstImageBitmap.close();
        firstImageBitmap = null;
      }

      if (Object.keys(newSettings).length > 0) {
        setSettings(prev => ({ ...prev, ...newSettings }));
      }
      const finalSettings = { ...settings, ...newSettings };

      const montageCanvas = canvasRef.current;
      if (!montageCanvas) throw new Error(t('alert_canvas_not_ready'));
      const montageCtx = montageCanvas.getContext('2d', { alpha: false });
      if (!montageCtx) throw new Error(t('alert_failed_to_get_context'));

      montageCanvas.width = (cropRect.width * finalSettings.colCount) + (finalSettings.offsetX * (finalSettings.colCount + 1));
      montageCanvas.height = (Math.ceil(images.length / finalSettings.colCount) * cropRect.height) + (finalSettings.offsetY * (Math.ceil(images.length / finalSettings.colCount) + 1));

      // const maxPixels = 16_777_216; // Approximately 4096x4096
      // if (montageCanvas.width * montageCanvas.height > maxPixels) {
      //   throw new Error(t('alert_canvas_too_large', { maxPixels: maxPixels.toLocaleString() }));
      // }

      montageCtx.fillStyle = finalSettings.bgColor;
      montageCtx.fillRect(0, 0, montageCanvas.width, montageCanvas.height);

      for (let i = 0; i < images.length; i++) {
        const imageFile = images[i];
        const row = Math.floor(i / finalSettings.colCount);
        const col = i % finalSettings.colCount;
        const drawX = finalSettings.offsetX + col * (cropRect.width + finalSettings.offsetX);
        const drawY = finalSettings.offsetY + row * (cropRect.height + finalSettings.offsetY);

        if (!finalSettings.maskEnabled && !finalSettings.selfMaskEnabled) {
          const full = await createImageBitmap(imageFile);
          if (!reusableTempCanvas) {
            reusableTempCanvas = document.createElement('canvas');
            reusableTempCtx = reusableTempCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
            if (!reusableTempCtx) { full.close(); throw new Error('Could not get reusable temporary canvas context'); }
          }
          reusableTempCanvas.width = cropRect.width;
          reusableTempCanvas.height = cropRect.height;
          reusableTempCtx!.drawImage(full, cropRect.x, cropRect.y, cropRect.width, cropRect.height, 0, 0, cropRect.width, cropRect.height);
          full.close();
          montageCtx.drawImage(reusableTempCanvas, drawX, drawY);
        } else {
          const bitmap = await createImageBitmap(imageFile);
          if (!reusableTempCanvas) {
            reusableTempCanvas = document.createElement('canvas');
            reusableTempCtx = reusableTempCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
            if (!reusableTempCtx) {
              bitmap.close();
              throw new Error('Could not get reusable temporary canvas context');
            }
          }
          // Resize canvas to crop size, not full image size
          reusableTempCanvas.width = cropRect.width;
          reusableTempCanvas.height = cropRect.height;

          // Draw only the cropped portion of the bitmap to the small temp canvas
          reusableTempCtx!.drawImage(bitmap, cropRect.x, cropRect.y, cropRect.width, cropRect.height, 0, 0, cropRect.width, cropRect.height);
          bitmap.close(); // Close bitmap as soon as it's on the temp canvas

          // Adjust mask coordinates to be relative to the cropped canvas
          if (finalSettings.maskEnabled) {
            reusableTempCtx!.fillStyle = finalSettings.maskColor;
            reusableTempCtx!.fillRect(enemyMaskRect.x - cropRect.x, enemyMaskRect.y - cropRect.y, enemyMaskRect.width, enemyMaskRect.height);
          }
          if (finalSettings.selfMaskEnabled) {
            reusableTempCtx!.fillStyle = finalSettings.selfMaskColor;
            reusableTempCtx!.fillRect(selfMaskRect.x - cropRect.x, selfMaskRect.y - cropRect.y, selfMaskRect.width, selfMaskRect.height);
          }

          // Draw the small, masked canvas to the final montage
          montageCtx.drawImage(reusableTempCanvas, drawX, drawY);
        }
        await new Promise(r => requestAnimationFrame(r)); // Yield control to browser
      }

      let mimeType = 'image/webp';
      if (finalSettings.outputFormat === 'png') mimeType = 'image/png';
      else if (finalSettings.outputFormat === 'jpeg') mimeType = 'image/jpeg';

      const montageBlob = await new Promise<Blob | null>(resolve => montageCanvas.toBlob(resolve, mimeType, finalSettings.quality / 100));

      if (montageBlob) {
        const getTimestamp = () => {
          const d = new Date();
          const pad = (n: number) => n.toString().padStart(2, '0');
          return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        };
        const ext = finalSettings.outputFormat === 'jpeg' ? 'jpg' : finalSettings.outputFormat;
        setDownloadFilename(`tile-${getTimestamp()}.${ext}`);
        setProcessedImageUrl(URL.createObjectURL(montageBlob));
        montageCanvas.width = 1;
        montageCanvas.height = 1;
      } else {
        throw new Error(t('alert_image_generation_failed'));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("An unexpected error occurred during image processing:", error);
      alert(`${t('alert_processing_failed')}: ${errorMessage}`);

      // Best-effort cleanup before reloading
      try {
        workerRef.current?.terminate();
      } catch {}
      if (reusableTempCanvas) {
        reusableTempCanvas.width = 1;
        reusableTempCanvas.height = 1;
      }
      if (canvasRef.current) {
        canvasRef.current.width = 1;
        canvasRef.current.height = 1;
      }

      window.location.reload();
    } finally {
      if (firstImageBitmap) {
        firstImageBitmap.close();
      }
      if (reusableTempCanvas) { // Deallocate reusable canvas
        reusableTempCanvas.width = 1;
        reusableTempCanvas.height = 1;
      }
      if (workerRef.current) {
        await workerRef.current.terminate();
        workerRef.current = null;
      }
      setOcrStatus(t('status_releasing_memory'));
      // Add a small delay to allow GC to run before re-enabling the button
      const isOcrUsed = (settings.maskEnabled && settings.maskMode === 'ocr') || (settings.selfMaskEnabled && settings.selfMaskMode === 'ocr');
      await new Promise(resolve => setTimeout(resolve, isOcrUsed ? 5000 : 1000));
      setOcrStatus(''); // Clear OCR status message
      setIsProcessing(false);
    }
  };

  return (
    <Container maxWidth="lg" sx={{ mt: 4, pb: 20, minHeight: '100vh' }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 2 }}>
        <Typography variant="h4" component="h1">{t('title')}</Typography>
        <Typography variant="caption" color="text.secondary">v{packageJson.version}</Typography>
      </Box>
      <Grid container spacing={3}>
        <Grid size={{xs:12, md:4}}>
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
                <Typography variant="h6">{t('settings')}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('columns')}: {settings.colCount}, {t('quality')}: {settings.quality}%
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Grid container spacing={2}>
                <Grid size={{xs:12}}>
                  <FormControl fullWidth>
                    <InputLabel>{t('columns')}</InputLabel>
                    <Select name="colCount" value={settings.colCount} label={t('columns')} onChange={handleSettingChange}>
                      {[...Array(10)].map((_, i) => (
                        <MenuItem key={i + 1} value={i + 1}>{i + 1}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{xs:12}}>
                  <FormControl fullWidth>
                    <InputLabel>{t('offset_px')}</InputLabel>
                    <Select name="offsetX" value={settings.offsetX} label={t('offset_px')} onChange={handleSettingChange}>
                      {[...Array(51)].map((_, i) => (
                        <MenuItem key={i} value={i}>{i}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{xs:12}}><Typography gutterBottom>{t('background_color')}</Typography><Box sx={{ display: 'flex', alignItems: 'center' }}><Input type="color" name="bgColor" value={settings.bgColor} onChange={handleSettingChange} sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }} /><TextField variant="outlined" size="small" name="bgColor" value={settings.bgColor} onChange={handleSettingChange} sx={{ ml: 2, flexGrow: 1 }} /></Box></Grid>
                <Grid size={{xs:12}}>
                  <FormControl fullWidth>
                    <InputLabel>{t('output_format')}</InputLabel>
                    <Select name="outputFormat" value={settings.outputFormat} label={t('output_format')} onChange={handleSettingChange}>
                      <MenuItem value="webp">WebP</MenuItem>
                      <MenuItem value="png">PNG</MenuItem>
                      <MenuItem value="jpeg">JPEG</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{xs:12}}><Typography gutterBottom>{t('quality')}</Typography><Slider name="quality" value={settings.quality} onChange={handleSliderChange('quality')} aria-labelledby="input-slider" min={1} max={100} valueLabelDisplay="auto" /></Grid>
              </Grid>
            </AccordionDetails>
          </Accordion>

          <Accordion sx={{ mt: 2 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
                <Typography variant="h6">{t('cropping')}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {settings.cropAuto ? t('auto_mode') : `${settings.cropWidth}x${settings.cropHeight}`}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
                <FormControlLabel control={<Switch checked={settings.cropAuto} onChange={handleSettingChange} name="cropAuto" />} label={t('auto_mode')} />
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}><TextField label={t('x')} type="number" name="cropX" value={settings.cropX} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('y')} type="number" name="cropY" value={settings.cropY} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('width')} type="number" name="cropWidth" value={settings.cropWidth} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('height')} type="number" name="cropHeight" value={settings.cropHeight} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                </Grid>
            </AccordionDetails>
          </Accordion>

          <Accordion sx={{ mt: 2 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
                <Typography variant="h6">{t('masking')}</Typography>
                <Typography variant="caption" color={settings.maskEnabled ? "primary" : "text.secondary"}>
                  {settings.maskEnabled ? t(`mode_${settings.maskMode}`) : t('enable') + ': OFF'}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
                <FormControlLabel control={<Switch checked={settings.maskEnabled} onChange={handleSettingChange} name="maskEnabled" />} label={t('enable')} />
                {settings.maskEnabled && (
                  <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                    <InputLabel>{t('mode')}</InputLabel>
                    <Select name="maskMode" value={settings.maskMode} label={t('mode')} onChange={handleSettingChange} sx={{ '& .MuiSelect-select': { textAlign: 'center', display: 'flex', justifyContent: 'center' } }}>
                      <MenuItem value="manual" sx={{ justifyContent: 'center' }}>{t('mode_manual')}</MenuItem>
                      <MenuItem value="ratio" sx={{ justifyContent: 'center' }}>{t('mode_ratio')}</MenuItem>
                      <MenuItem value="ocr" sx={{ justifyContent: 'center' }}>{t('mode_ocr')}</MenuItem>
                    </Select>
                  </FormControl>
                )}
                {settings.maskEnabled && settings.maskMode === 'ratio' && (
                  <Box sx={{ mt: 2, px: 1 }}>
                    <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                      <InputLabel>{t('preset')}</InputLabel>
                      <Select
                        value={getActivePreset(settings.maskRatioRect, MASK_PRESETS)}
                        label={t('preset')}
                        onChange={handlePresetChange('maskRatioRect')}
                        sx={{ '& .MuiSelect-select': { textAlign: 'center' } }}
                      >
                        <MenuItem value="custom" disabled sx={{ justifyContent: 'center', fontStyle: 'italic' }}>{t('preset_custom')}</MenuItem>
                        <MenuItem value="name" sx={{ justifyContent: 'center' }}>{t('preset_name')}</MenuItem>
                        <MenuItem value="title" sx={{ justifyContent: 'center' }}>{t('preset_title')}</MenuItem>
                        <MenuItem value="full" sx={{ justifyContent: 'center' }}>{t('preset_full')}</MenuItem>
                      </Select>
                    </FormControl>
                    <Typography variant="caption" gutterBottom>{t('range_horizontal')}</Typography>
                    <Slider
                      value={[settings.maskRatioRect.rx0, settings.maskRatioRect.rx1]}
                      onChange={handleRatioSliderChange('maskRatioRect', 'horizontal')}
                      valueLabelDisplay="auto"
                      min={0} max={1} step={0.001}
                    />
                    <Typography variant="caption" gutterBottom>{t('range_vertical')}</Typography>
                    <Slider
                      value={[settings.maskRatioRect.ry0, settings.maskRatioRect.ry1]}
                      onChange={handleRatioSliderChange('maskRatioRect', 'vertical')}
                      valueLabelDisplay="auto"
                      min={0} max={1} step={0.001}
                    />
                    <Grid container spacing={2} sx={{ mt: 0 }}>
                      <Grid size={{xs:6}}><TextField label={t('ratio_left')} type="number" name="maskRatioRect.rx0" value={settings.maskRatioRect.rx0} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('ratio_top')} type="number" name="maskRatioRect.ry0" value={settings.maskRatioRect.ry0} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('ratio_right')} type="number" name="maskRatioRect.rx1" value={settings.maskRatioRect.rx1} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('ratio_bottom')} type="number" name="maskRatioRect.ry1" value={settings.maskRatioRect.ry1} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                    </Grid>
                  </Box>
                )}
                {settings.maskEnabled && settings.maskMode !== 'ratio' && (
                  <Grid container spacing={2} sx={{ mt: 1 }}>
                      <Grid size={{xs:6}}><TextField label={t('x')} type="number" name="maskX" value={settings.maskX} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('y')} type="number" name="maskY" value={settings.maskY} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('width')} type="number" name="maskWidth" value={settings.maskWidth} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('height')} type="number" name="maskHeight" value={settings.maskHeight} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                  </Grid>
                )}
                {settings.maskEnabled && (
                  <Box sx={{ mt: 2 }}>
                    <Typography gutterBottom>{t('color')}</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Input type="color" name="maskColor" value={settings.maskColor} onChange={handleSettingChange} sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }} />
                      <TextField variant="outlined" size="small" name="maskColor" value={settings.maskColor} onChange={handleSettingChange} sx={{ ml: 2, flexGrow: 1 }} inputProps={{ style: { textAlign: 'center' } }} />
                    </Box>
                  </Box>
                )}
            </AccordionDetails>
          </Accordion>

          <Accordion sx={{ mt: 2 }}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
                <Typography variant="h6">{t('self_mask')}</Typography>
                <Typography variant="caption" color={settings.selfMaskEnabled ? "primary" : "text.secondary"}>
                  {settings.selfMaskEnabled ? t(`mode_${settings.selfMaskMode}`) : t('enable') + ': OFF'}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
                <FormControlLabel control={<Switch checked={settings.selfMaskEnabled} onChange={handleSettingChange} name="selfMaskEnabled" />} label={t('enable')} />
                {settings.selfMaskEnabled && (
                  <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                    <InputLabel>{t('mode')}</InputLabel>
                    <Select name="selfMaskMode" value={settings.selfMaskMode} label={t('mode')} onChange={handleSettingChange} sx={{ '& .MuiSelect-select': { textAlign: 'center', display: 'flex', justifyContent: 'center' } }}>
                      <MenuItem value="manual" sx={{ justifyContent: 'center' }}>{t('mode_manual')}</MenuItem>
                      <MenuItem value="ratio" sx={{ justifyContent: 'center' }}>{t('mode_ratio')}</MenuItem>
                      <MenuItem value="ocr" sx={{ justifyContent: 'center' }}>{t('mode_ocr')}</MenuItem>
                    </Select>
                  </FormControl>
                )}
                {settings.selfMaskEnabled && settings.selfMaskMode === 'ratio' && (
                  <Box sx={{ mt: 2, px: 1 }}>
                    <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                      <InputLabel>{t('preset')}</InputLabel>
                      <Select
                        value={getActivePreset(settings.selfMaskRatioRect, SELF_MASK_PRESETS)}
                        label={t('preset')}
                        onChange={handlePresetChange('selfMaskRatioRect')}
                        sx={{ '& .MuiSelect-select': { textAlign: 'center' } }}
                      >
                        <MenuItem value="custom" disabled sx={{ justifyContent: 'center', fontStyle: 'italic' }}>{t('preset_custom')}</MenuItem>
                        <MenuItem value="name" sx={{ justifyContent: 'center' }}>{t('preset_name')}</MenuItem>
                        <MenuItem value="title" sx={{ justifyContent: 'center' }}>{t('preset_title')}</MenuItem>
                        <MenuItem value="full" sx={{ justifyContent: 'center' }}>{t('preset_full')}</MenuItem>
                      </Select>
                    </FormControl>
                    <Typography variant="caption" gutterBottom>{t('range_horizontal')}</Typography>
                    <Slider
                      value={[settings.selfMaskRatioRect.rx0, settings.selfMaskRatioRect.rx1]}
                      onChange={handleRatioSliderChange('selfMaskRatioRect', 'horizontal')}
                      valueLabelDisplay="auto"
                      min={0} max={1} step={0.001}
                    />
                    <Typography variant="caption" gutterBottom>{t('range_vertical')}</Typography>
                    <Slider
                      value={[settings.selfMaskRatioRect.ry0, settings.selfMaskRatioRect.ry1]}
                      onChange={handleRatioSliderChange('selfMaskRatioRect', 'vertical')}
                      valueLabelDisplay="auto"
                      min={0} max={1} step={0.001}
                    />
                    <Grid container spacing={2} sx={{ mt: 0 }}>
                      <Grid size={{xs:6}}><TextField label={t('ratio_left')} type="number" name="selfMaskRatioRect.rx0" value={settings.selfMaskRatioRect.rx0} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('ratio_top')} type="number" name="selfMaskRatioRect.ry0" value={settings.selfMaskRatioRect.ry0} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('ratio_right')} type="number" name="selfMaskRatioRect.rx1" value={settings.selfMaskRatioRect.rx1} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('ratio_bottom')} type="number" name="selfMaskRatioRect.ry1" value={settings.selfMaskRatioRect.ry1} onChange={handleSettingChange} fullWidth inputProps={{ step: 0.01, style: { textAlign: 'center' } }} /></Grid>
                    </Grid>
                  </Box>
                )}
                {settings.selfMaskEnabled && settings.selfMaskMode !== 'ratio' && (
                  <Grid container spacing={2} sx={{ mt: 1 }}>
                      <Grid size={{xs:6}}><TextField label={t('x')} type="number" name="selfMaskX" value={settings.selfMaskX} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('y')} type="number" name="selfMaskY" value={settings.selfMaskY} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('width')} type="number" name="selfMaskWidth" value={settings.selfMaskWidth} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                      <Grid size={{xs:6}}><TextField label={t('height')} type="number" name="selfMaskHeight" value={settings.selfMaskHeight} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskMode === 'ocr'} inputProps={{ style: { textAlign: 'center' } }} /></Grid>
                  </Grid>
                )}
                {settings.selfMaskEnabled && (
                  <Box sx={{ mt: 2 }}>
                    <Typography gutterBottom>{t('color')}</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Input type="color" name="selfMaskColor" value={settings.selfMaskColor} onChange={handleSettingChange} sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }} />
                      <TextField variant="outlined" size="small" name="selfMaskColor" value={settings.selfMaskColor} onChange={handleSettingChange} sx={{ ml: 2, flexGrow: 1 }} inputProps={{ style: { textAlign: 'center' } }} />
                    </Box>
                  </Box>
                )}
            </AccordionDetails>
          </Accordion>
        </Grid>
        <Grid size={{xs:12, md:8}}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>{t('upload_and_process')}</Typography>
              <Button variant="contained" component="label" fullWidth startIcon={<AddPhotoIcon />}>
                {t('upload_images')}
                <input type="file" hidden accept="image/png, image/jpeg" multiple onChange={handleFileChange} />
              </Button>
              {images.length > 0 && <Typography sx={{ mt: 1 }}>{t('files_selected', { count: images.length })}</Typography>}
              <Box sx={{ my: 2 }}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={processImages}
                  disabled={isProcessing || images.length === 0}
                  fullWidth
                  size="large"
                  startIcon={!isProcessing && <PlayArrow />}
                  sx={{ py: 1.5, fontWeight: 'bold', fontSize: '1.1rem' }}
                >
                  {isProcessing ? <CircularProgress size={26} color="inherit" /> : t('process_images')}
                </Button>
              </Box>
              {ocrStatus && <Typography sx={{ mt: 1 }} translate="no">{ocrStatus}</Typography>}
              {processedImageUrl && (
                <Box sx={{ mt: 2, overflowAnchor: 'none' }} ref={resultRef}>
                  <Typography variant="h6" gutterBottom>{t('result')}</Typography>
                  <img src={processedImageUrl} alt="Processed Montage" style={{ maxWidth: '100%', border: '1px solid #ccc', borderRadius: '4px' }} />
                  <Button variant="contained" href={processedImageUrl} download={downloadFilename} fullWidth sx={{ mt: 1 }} startIcon={<DownloadIcon />}>
                    {t('download_image')}
                  </Button>
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
      <canvas ref={canvasRef} style={{ display: 'none' }}></canvas>
    </Container>
  );
};

export default ImageProcessor;
