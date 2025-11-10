import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Input, Switch, FormControlLabel, Select, MenuItem, InputLabel, FormControl } from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import Tesseract, { PSM } from 'tesseract.js';

interface ImageSettings {
  colCount: number;
  offsetX: number;
  offsetY: number;
  bgColor: string;
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
  cropAuto: boolean;
  maskAuto: boolean;
  selfMaskEnabled: boolean;
  selfMaskAuto: boolean;
  selfMaskX: number;
  selfMaskY: number;
  selfMaskWidth: number;
  selfMaskHeight: number;
  selfMaskColor: string;
}

const ImageProcessor: React.FC = () => {
  const { t } = useTranslation();

  const [settings, setSettings] = useState<ImageSettings>(() => {
    const savedSettings = localStorage.getItem('imageProcessorSettings');
    const defaults: ImageSettings = {
      colCount: 4,
      offsetX: 8,
      offsetY: 8,
      bgColor: '#000000',
      quality: 80,
      webpMethod: 6,
      cropX: 31,
      cropY: 117,
      cropWidth: 1538,
      cropHeight: 665,
      cropAuto: true,
      maskEnabled: false,
      maskAuto: true,
      maskX: 0,
      maskY: 0,
      maskWidth: 100,
      maskHeight: 100,
      maskColor: '#FFFFFF',
      selfMaskEnabled: false,
      selfMaskAuto: true,
      selfMaskX: 0,
      selfMaskY: 0,
      selfMaskWidth: 100,
      selfMaskHeight: 100,
      selfMaskColor: '#FFFFFF',
    };
    if (savedSettings) {
      return { ...defaults, ...JSON.parse(savedSettings) };
    }
    return defaults;
  });

  useEffect(() => {
    localStorage.setItem('imageProcessorSettings', JSON.stringify(settings));
  }, [settings]);

  const [images, setImages] = useState<File[]>([]);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Tesseract.Worker | null>(null);

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

  const handleSettingChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number>) => {
    const name = event.target.name;
    let newValue: string | number | boolean;

    if ('type' in event.target && event.target.type === 'checkbox') { // Checkbox
        newValue = (event.target as HTMLInputElement).checked;
    } else if ('type' in event.target && event.target.type === 'number') { // TextField type="number"
        newValue = parseInt(event.target.value as string, 10) || 0; // Explicitly cast to string
    } else if (name === 'colCount' || name === 'offsetX') { // Select components
        newValue = event.target.value as number; // Value is already a number from SelectChangeEvent<number>
    } else { // Default for other text inputs (e.g., color pickers)
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

  async function decodeFirst(file: File): Promise<ImageBitmap> {
    try {
      return await createImageBitmap(file);
    } catch (error) {
      console.warn("createImageBitmap failed, falling back to Image element:", error);
      // Retry with an alternative path if createImageBitmap fails
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
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

    let firstImageBitmap: ImageBitmap | null = null;
    let reusableTempCanvas: HTMLCanvasElement | null = null;
    let reusableTempCtx: CanvasRenderingContext2D | null = null;
    try {
      let cropRect = { x: settings.cropX, y: settings.cropY, width: settings.cropWidth, height: settings.cropHeight };
      let enemyMaskRect = { x: settings.maskX, y: settings.maskY, width: settings.maskWidth, height: settings.maskHeight };
      let selfMaskRect = { x: settings.selfMaskX, y: settings.selfMaskY, width: settings.selfMaskWidth, height: settings.selfMaskHeight };
      const newSettings: Partial<ImageSettings> = {};

      if (settings.cropAuto || (settings.maskEnabled && settings.maskAuto) || (settings.selfMaskEnabled && settings.selfMaskAuto)) {
          firstImageBitmap = await loadAndDrawFirstImage();
          if (!firstImageBitmap) return;
      }

      if (settings.cropAuto && firstImageBitmap) {
        const performAutoCrop = (firstImageBitmap: ImageBitmap): boolean => {
            const w = firstImageBitmap.width;
            const h = firstImageBitmap.height;
            const THRESHOLD = 40;
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

            const findHEdge = (isRight: boolean): number | null => {
                const ASPECT_LIMIT = 2.1;
                const skipX = w / h > ASPECT_LIMIT ? Math.floor((w - h * ASPECT_LIMIT) / 2) + 1 : 0;
                for (let x = isRight ? w - skipX - 2 : skipX + 1; isRight ? x > 0 : x < w; isRight ? x-- : x++) {
                    if (Math.abs(getLuminance(hData, x * 4) - getLuminance(hData, (x + (isRight ? 1 : -1)) * 4)) > THRESHOLD) return x;
                }
                return null;
            };

            const findVEdge = (isBottom: boolean): number | null => {
                for (let y = isBottom ? Math.floor(h * 0.95) : 1; isBottom ? y > 0 : y < h; isBottom ? y-- : y++) {
                    if (Math.abs(getLuminance(vData, y * 4) - getLuminance(vData, (y + (isBottom ? 1 : -1)) * 4)) > THRESHOLD) return y;
                }
                return null;
            };

            const left = findHEdge(false);
            const right = findHEdge(true);
            const top = findVEdge(false);
            const bottom = findVEdge(true);

            if (left !== null && right !== null && top !== null && bottom !== null) {
                cropRect = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
                Object.assign(newSettings, cropRect);
                return true;
            } else {
                alert(t('alert_failed_to_detect_crop_area'));
                newSettings.cropAuto = false;
                return false;
            }
        };
        if (!performAutoCrop(firstImageBitmap)) {
          setSettings(prev => ({ ...prev, ...newSettings }));
          return;
        }
      }
      if ((settings.maskEnabled && settings.maskAuto) || (settings.selfMaskEnabled && settings.selfMaskAuto)) {
        const performAutoMask = async (firstImageBitmap: ImageBitmap): Promise<boolean> => {
            let worker = workerRef.current;
            if (!worker) {
              setOcrStatus(t('ocr_status_starting'));
              worker = await Tesseract.createWorker('jpn+eng', 1, { logger: m => { /* logger logic */ } });
              workerRef.current = worker;
            }
            await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
            try {
                const W = firstImageBitmap.width, H = firstImageBitmap.height;
                const centerX = Math.floor(W / 2);
                const scratch = document.createElement('canvas');
                const sctx = scratch.getContext('2d', { willReadFrequently: true, alpha: false })!;

                async function recognizeROI(sx: number, sy: number, sw: number, sh: number) {
                  scratch.width = sw; scratch.height = sh;
                  sctx.clearRect(0, 0, sw, sh);
                  sctx.drawImage(firstImageBitmap, sx, sy, sw, sh, 0, 0, sw, sh);
                  const { data } = await worker!.recognize(scratch, {}, { blocks: true });
                  return (data?.blocks ?? [])
                    .flatMap(b => b.paragraphs).flatMap(p => p.lines).flatMap(l => l.words)
                    .map(w => ({ ...w, bbox: { x0: w.bbox.x0 + sx, y0: w.bbox.y0 + sy, x1: w.bbox.x1 + sx, y1: w.bbox.y1 + sy } }));
                }

                // Left-top 40%
                const wordsLeftTop = await recognizeROI(0, 0, centerX, Math.floor(H * 0.4));
                // Right-top 40%
                const wordsRightTop = await recognizeROI(centerX, 0, W - centerX, Math.floor(H * 0.4));
                scratch.width = scratch.height = 1; // Deallocate scratch canvas

                const words = [...wordsLeftTop, ...wordsRightTop];
                const lvWords = words.filter(w => /Lv\.\d+/i.test(w.text));

                if (settings.maskEnabled && settings.maskAuto) {
                    const enemyLvWords = lvWords.filter(w => w.bbox.x0 > centerX);
                    const target = enemyLvWords.length > 0 ? enemyLvWords.reduce((p, c) => (p.bbox.y0 < c.bbox.y0 ? p : c)) : null;
                    if (target) {
                        const { x0, y0, y1 } = target.bbox;
                        enemyMaskRect = { x: x0 - 5, y: y0 - 5, width: W - (x0 - 5), height: (y1 - y0) + 10 };
                        Object.assign(newSettings, { maskX: enemyMaskRect.x, maskY: enemyMaskRect.y, maskWidth: enemyMaskRect.width, maskHeight: enemyMaskRect.height });
                    } else { newSettings.maskAuto = false; }
                }
                if (settings.selfMaskEnabled && settings.selfMaskAuto) {
                    const selfLvWords = lvWords.filter(w => w.bbox.x0 < centerX);
                    const target = selfLvWords.length > 0 ? selfLvWords.reduce((p, c) => (p.bbox.y0 < c.bbox.y0 ? p : c)) : null;
                    if (target) {
                        const { x0, y0, y1 } = target.bbox;
                        selfMaskRect = { x: x0 - 5, y: y0 - 5, width: centerX - (x0 - 5), height: (y1 - y0) + 10 };
                        Object.assign(newSettings, { selfMaskX: selfMaskRect.x, selfMaskY: selfMaskRect.y, selfMaskWidth: selfMaskRect.width, selfMaskHeight: selfMaskRect.height });
                    } else { newSettings.selfMaskAuto = false; }
                }
                setOcrStatus(t('ocr_status_mask_detected'));
                return true;
            } catch (e) { console.error(e); alert(t('alert_ocr_error')); return false; }
        };
        if (firstImageBitmap && !await performAutoMask(firstImageBitmap)) {
          setSettings(prev => ({ ...prev, ...newSettings }));
          return;
        }
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

      const montageBlob = await new Promise<Blob | null>(resolve => montageCanvas.toBlob(resolve, 'image/webp', finalSettings.quality / 100));

      if (montageBlob) {
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
      // Add a small delay to allow GC to run before re-enabling the button
      await new Promise(resolve => setTimeout(resolve, 500));
      setOcrStatus(''); // Clear OCR status message
      setIsProcessing(false);
    }
  };

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>{t('title')}</Typography>
      <Grid container spacing={3}>
        <Grid size={{xs:12, md:4}}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>{t('settings')}</Typography>
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
                <Grid size={{xs:12}}><Typography gutterBottom>{t('quality')}</Typography><Slider name="quality" value={settings.quality} onChange={handleSliderChange('quality')} aria-labelledby="input-slider" min={1} max={100} valueLabelDisplay="auto" /></Grid>
              </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>{t('cropping')}</Typography>
                <FormControlLabel control={<Switch checked={settings.cropAuto} onChange={handleSettingChange} name="cropAuto" />} label={t('auto_mode')} />
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}><TextField label={t('x')} type="number" name="cropX" value={settings.cropX} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('y')} type="number" name="cropY" value={settings.cropY} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('width')} type="number" name="cropWidth" value={settings.cropWidth} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('height')} type="number" name="cropHeight" value={settings.cropHeight} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>{t('masking')}</Typography>
                <FormControlLabel control={<Switch checked={settings.maskEnabled} onChange={handleSettingChange} name="maskEnabled" />} label={t('enable')} />
                {settings.maskEnabled && <FormControlLabel control={<Switch checked={settings.maskAuto} onChange={handleSettingChange} name="maskAuto" />} label={t('auto_mode')} />}
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}><TextField label={t('x')} type="number" name="maskX" value={settings.maskX} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('y')} type="number" name="maskY" value={settings.maskY} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('width')} type="number" name="maskWidth" value={settings.maskWidth} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('height')} type="number" name="maskHeight" value={settings.maskHeight} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} /></Grid>
                    <Grid size={{xs:12}}><Typography gutterBottom>{t('color')}</Typography><Box sx={{ display: 'flex', alignItems: 'center' }}><Input type="color" name="maskColor" value={settings.maskColor} onChange={handleSettingChange} disabled={!settings.maskEnabled} sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }} /><TextField variant="outlined" size="small" name="maskColor" value={settings.maskColor} onChange={handleSettingChange} sx={{ ml: 2, flexGrow: 1 }} disabled={!settings.maskEnabled} /></Box></Grid>
                </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>{t('self_mask')}</Typography>
                <FormControlLabel control={<Switch checked={settings.selfMaskEnabled} onChange={handleSettingChange} name="selfMaskEnabled" />} label={t('enable')} />
                {settings.selfMaskEnabled && <FormControlLabel control={<Switch checked={settings.selfMaskAuto} onChange={handleSettingChange} name="selfMaskAuto" />} label={t('auto_mode')} />}
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}><TextField label={t('x')} type="number" name="selfMaskX" value={settings.selfMaskX} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('y')} type="number" name="selfMaskY" value={settings.selfMaskY} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('width')} type="number" name="selfMaskWidth" value={settings.selfMaskWidth} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('height')} type="number" name="selfMaskHeight" value={settings.selfMaskHeight} onChange={handleSettingChange} fullWidth disabled={!settings.selfMaskEnabled || settings.selfMaskAuto} /></Grid>
                    <Grid size={{xs:12}}><Typography gutterBottom>{t('color')}</Typography><Box sx={{ display: 'flex', alignItems: 'center' }}><Input type="color" name="selfMaskColor" value={settings.selfMaskColor} onChange={handleSettingChange} disabled={!settings.selfMaskEnabled} sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }} /><TextField variant="outlined" size="small" name="selfMaskColor" value={settings.selfMaskColor} onChange={handleSettingChange} sx={{ ml: 2, flexGrow: 1 }} disabled={!settings.selfMaskEnabled} /></Box></Grid>
                </Grid>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{xs:12, md:8}}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>{t('upload_and_process')}</Typography>
              <Button variant="contained" component="label" fullWidth>
                {t('upload_images')}
                <input type="file" hidden accept="image/png" multiple onChange={handleFileChange} />
              </Button>
              {images.length > 0 && <Typography sx={{ mt: 1 }}>{t('files_selected', { count: images.length })}</Typography>}
              <Box sx={{ my: 2 }}>
                <Button variant="contained" color="primary" onClick={processImages} disabled={isProcessing || images.length === 0} fullWidth>
                  {isProcessing ? <CircularProgress size={24} /> : t('process_images')}
                </Button>
              </Box>
              {ocrStatus && <Typography sx={{ mt: 1 }} translate="no">{ocrStatus}</Typography>}
              {processedImageUrl && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="h6" gutterBottom>{t('result')}</Typography>
                  <img src={processedImageUrl} alt="Processed Montage" style={{ maxWidth: '100%', border: '1px solid #ccc', borderRadius: '4px' }} />
                  <Button variant="contained" href={processedImageUrl} download="tile.webp" fullWidth sx={{ mt: 1 }}>
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