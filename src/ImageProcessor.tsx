import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Input, Switch, FormControlLabel } from '@mui/material';
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
}

const ImageProcessor: React.FC = () => {
  const { t } = useTranslation();

  const [settings, setSettings] = useState<ImageSettings>(() => {
    const savedSettings = localStorage.getItem('imageProcessorSettings');
    if (savedSettings) {
      const loadedSettings = JSON.parse(savedSettings);
      // Ensure cropAuto exists to avoid issues with old saved settings
      return {
        ...{ // Default values
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
        },
        ...loadedSettings
      };
    } else {
      return {
        colCount: 4,
        offsetX: 8,
        offsetY: 8,
        bgColor: '#000000',
        quality: 80,
        webpMethod: 6, // This is a placeholder as canvas.toDataURL doesn't support webp:method
        cropX: 31,
        cropY: 117,
        cropWidth: 1538,
        cropHeight: 665,
        cropAuto: true,
        maskEnabled: false,
        maskAuto: false,
        maskX: 0,
        maskY: 0,
        maskWidth: 100,
        maskHeight: 100,
        maskColor: '#FFFFFF',
      };
    }
  });

  useEffect(() => {
    localStorage.setItem('imageProcessorSettings', JSON.stringify(settings));
  }, [settings]);

  const [images, setImages] = useState<File[]>([]);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setImages(Array.from(event.target.files));
      setProcessedImageUrl(null);
    }
  };

  const handleSettingChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = event.target;
    let newValue: string | number | boolean = value;

    if (event.target instanceof HTMLInputElement) {
      if (event.target.type === 'number') {
        newValue = parseInt(value, 10);
      } else if (event.target.type === 'checkbox') {
        newValue = event.target.checked;
      }
    }

    setSettings(prev => ({
      ...prev,
      [name]: newValue,
    }));
  };

  const handleSliderChange = (name: string) => (_event: Event, value: number | number[]) => {
    setSettings(prev => ({
        ...prev,
        [name]: value as number,
    }));
  };

  const processImages = async () => {
    if (images.length === 0) {
      alert(t('alert_select_images_first'));
      return;
    }

    const validateSettings = (): boolean => {
      // Validation for Columns and Offset
      if (isNaN(settings.colCount) || settings.colCount <= 0) {
        alert(t('alert_columns_must_be_positive'));
        return false;
      }
      if (isNaN(settings.offsetX) || settings.offsetX < 0) {
        alert(t('alert_offset_cannot_be_empty_or_negative'));
        return false;
      }

      // Validation for Cropping parameters
      if (isNaN(settings.cropX) || isNaN(settings.cropY) || isNaN(settings.cropWidth) || isNaN(settings.cropHeight)) {
        alert(t('alert_cropping_params_cannot_be_empty'));
        return false;
      }
      if (settings.cropWidth <= 0 || settings.cropHeight <= 0) {
        alert(t('alert_cropping_width_height_must_be_positive'));
        return false;
      }
      if (settings.cropX < 0 || settings.cropY < 0) {
        alert(t('alert_cropping_xy_cannot_be_negative'));
        return false;
      }

      // Validation for Masking parameters if enabled
      if (settings.maskEnabled) {
        if (isNaN(settings.maskX) || isNaN(settings.maskY) || isNaN(settings.maskWidth) || isNaN(settings.maskHeight)) {
          alert(t('alert_masking_params_cannot_be_empty'));
          return false;
        }
        if (settings.maskWidth <= 0 || settings.maskHeight <= 0) {
          alert(t('alert_masking_width_height_must_be_positive'));
          return false;
        }
        if (settings.maskX < 0 || settings.maskY < 0) {
          alert(t('alert_masking_xy_cannot_be_negative'));
          return false;
        }
      }
      return true;
    };

    if (!validateSettings()) {
      return;
    }

    setIsProcessing(true);
    setProcessedImageUrl(null);

    let cropRect = { x: settings.cropX, y: settings.cropY, width: settings.cropWidth, height: settings.cropHeight };
    let currentMaskRect = { x: settings.maskX, y: settings.maskY, width: settings.maskWidth, height: settings.maskHeight };

    const loadAndDrawFirstImage = async (): Promise<HTMLImageElement | null> => {
        if (images.length === 0) return null;
        const firstImageFile = images[0];
        const img = new Image();
        img.src = URL.createObjectURL(firstImageFile);
        await new Promise(resolve => img.onload = resolve);
        return img;
    };

    let firstImageLoaded: HTMLImageElement | null = null;
    if (settings.cropAuto || (settings.maskEnabled && settings.maskAuto)) {
        firstImageLoaded = await loadAndDrawFirstImage();
        if (!firstImageLoaded) {
            setIsProcessing(false);
            return;
        }
    }

    if (settings.cropAuto) {
        const performAutoCrop = (): boolean => {
            const THRESHOLD = 40;
            const ASPECT_LIMIT = 2.1;

            const getLuminance = (data: Uint8ClampedArray, i: number) => {
                return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            }

            const getBandSkipX = (width: number, height: number) => {
                if (width / height > ASPECT_LIMIT) {
                    const logicalW = height * ASPECT_LIMIT;
                    return Math.floor((width - logicalW) / 2) + 1;
                }
                return 0;
            }

            const findLeftToRight = (data: Uint8ClampedArray, w: number, h: number, skipX: number) => {
                const y = Math.floor(h / 2);
                for (let x = skipX + 1; x < w; x++) {
                    const i = (y * w + x);
                    const d = Math.abs(getLuminance(data, i * 4) - getLuminance(data, (i - 1) * 4));
                    if (d > THRESHOLD) {
                        return { x, y };
                    }
                }
                return null;
            }

            const findRightToLeft = (data: Uint8ClampedArray, w: number, h: number, skipX: number) => {
                const y = Math.floor(h / 2);
                for (let x = w - skipX - 2; x > 0; x--) {
                    const i = (y * w + x);
                    const d = Math.abs(getLuminance(data, i * 4) - getLuminance(data, (i + 1) * 4));
                    if (d > THRESHOLD) {
                        return { x, y };
                    }
                }
                return null;
            }

            const findTopToBottom = (data: Uint8ClampedArray, w: number, h: number) => {
                const x = Math.floor(w / 2);
                for (let y = 1; y < h; y++) {
                    const d = Math.abs(getLuminance(data, (y * w + x) * 4) - getLuminance(data, ((y - 1) * w + x) * 4));
                    if (d > THRESHOLD) {
                        return { x, y };
                    }
                }
                return null;
            }

            const findBottomToTop = (data: Uint8ClampedArray, w: number, h: number) => {
                const x = Math.floor(w / 2);
                for (let y = Math.floor(h * 0.95); y > 0; y--) {
                    const d = Math.abs(getLuminance(data, (y * w + x) * 4) - getLuminance(data, ((y + 1) * w + x) * 4));
                    if (d > THRESHOLD) {
                        return { x, y };
                    }
                }
                return null;
            }

            // Use a temporary canvas for image manipulation within auto-crop
            const tempCanvas = document.createElement('canvas');
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) {
                alert(t('alert_failed_to_get_temp_canvas_context_for_auto_crop'));
                return false;
            }

            tempCanvas.width = firstImageLoaded!.naturalWidth;
            tempCanvas.height = firstImageLoaded!.naturalHeight;
            tempCtx.drawImage(firstImageLoaded!, 0, 0);

            const w = tempCanvas.width, h = tempCanvas.height;
            const data = tempCtx.getImageData(0, 0, w, h).data;
            const skipX = getBandSkipX(w, h);

            const left = findLeftToRight(data, w, h, skipX);
            const right = findRightToLeft(data, w, h, skipX);
            const top = findTopToBottom(data, w, h);
            const bottom = findBottomToTop(data, w, h);

            if (left && right && top && bottom) {
                cropRect = {
                    x: left.x,
                    y: top.y,
                    width: right.x - left.x + 1,
                    height: bottom.y - top.y + 1
                };
                setSettings(prev => ({ ...prev, ...cropRect }));
                return true;
            } else {
                alert(t('alert_failed_to_detect_crop_area'));
                setSettings(prev => ({ ...prev, cropAuto: false }));
                return false;
            }
        };
        if (!performAutoCrop()) {
            setIsProcessing(false);
            return;
        }
    }

    if (settings.maskEnabled && settings.maskAuto) {
        const performAutoMask = async (): Promise<boolean> => {
            if (!firstImageLoaded) {
                alert(t('alert_first_image_not_loaded_for_auto_mask'));
                setSettings(prev => ({ ...prev, maskAuto: false }));
                return false;
            }

            setOcrStatus(t('ocr_status_starting'));

            const worker = await Tesseract.createWorker('jpn+eng', 1, {
                logger: m => {
                    switch (m.status) {
                        case 'loading tesseract core':
                            setOcrStatus(t('ocr_status_loading_core'));
                            break;
                        case 'initializing tesseract':
                            setOcrStatus(t('ocr_status_initializing_tesseract'));
                            break;
                        case 'initializing api':
                            setOcrStatus(t('ocr_status_initializing_api'));
                            break;
                        case 'loading language traineddata':
                            setOcrStatus(t('ocr_status_loading_language'));
                            break;
                        case 'recognizing text':
                            setOcrStatus(t('ocr_status_recognizing', { progress: Math.round(m.progress * 100) }));
                            break;
                        case 'done':
                            setOcrStatus(t('ocr_status_done'));
                            break;
                        default:
                            // 未知のステータスは念のためそのまま表示
                            setOcrStatus(m.status);
                    }
                },
            });

            await worker.setParameters({
                tessedit_pageseg_mode: PSM.SPARSE_TEXT, // PSM.SPARSE_TEXT for sparse text
            });

            try {
                const arrayBuffer = await images[0].arrayBuffer() as any;
                const ocrResult = await worker.recognize(arrayBuffer, {}, { blocks: true });

                if (!ocrResult.data.blocks) {
                    console.error("'blocks' property is missing in OCR result data.");
                    throw new Error("Blocks array is not available in OCR result.");
                }

                const words = ocrResult.data.blocks
                    .map(block => block.paragraphs
                        .map(paragraph => paragraph.lines
                            .map(line => line.words)))
                    .flat(3);

                if (!words || !Array.isArray(words)) {
                    console.error("'words' property is missing or not an array after extraction.");
                    throw new Error("Words array is not available in OCR result.");
                }

                const lvWords = words.filter(word => word.text && word.text.match(/Lv\.\d+/i));

                let targetLvWord = null;
                if (lvWords.length > 0) {
                    const imageCenterX = firstImageLoaded.naturalWidth / 2;
                    const imageTopSectionY = firstImageLoaded.naturalHeight * 0.4;

                    const potentialLvWords = lvWords.filter(word => {
                        const bbox = word.bbox;
                        return bbox.x0 > imageCenterX && bbox.y0 < imageTopSectionY;
                    });

                    if (potentialLvWords.length > 0) {
                        targetLvWord = potentialLvWords.reduce((prev, current) => {
                            if (prev.bbox.y0 === current.bbox.y0) {
                                return (prev.bbox.x0 < current.bbox.x0) ? prev : current;
                            }
                            return (prev.bbox.y0 < current.bbox.y0) ? prev : current;
                        });
                    }
                }

                if (targetLvWord) {
                    const lvBbox = targetLvWord.bbox;
                    console.log("Detected Lv bbox:", lvBbox); // Log Lv bbox for debugging

                    const maskPaddingYTop = 5;
                    const maskPaddingYBottom = 5;
                    const maskPaddingXLeft = 5;

                    const finalMaskX = Math.max(0, lvBbox.x0 - maskPaddingXLeft);
                    const baseTopY = lvBbox.y0; // Masking based only on Lv bbox
                    const finalMaskY = Math.max(0, baseTopY - maskPaddingYTop);
                    const baseBottomY = lvBbox.y1; // Masking based only on Lv bbox
                    const finalMaskHeight = (baseBottomY - baseTopY) + maskPaddingYTop + maskPaddingYBottom;
                    const finalMaskWidth = firstImageLoaded.naturalWidth - finalMaskX;

                    currentMaskRect = {
                        x: finalMaskX,
                        y: finalMaskY,
                        width: finalMaskWidth,
                        height: Math.min(finalMaskHeight, firstImageLoaded.naturalHeight - finalMaskY),
                    };
                    setSettings(prev => ({ ...prev, ...currentMaskRect })); // settingsも更新しておく
                    setOcrStatus(t('ocr_status_mask_detected'));
                    return true;

                } else {
                    alert(t('alert_could_not_find_lv_text'));
                    setSettings(prev => ({ ...prev, maskAuto: false }));
                    setOcrStatus('');
                    return false;
                }
            } catch (error) {
                console.error("OCR Error:", error);
                alert(t('alert_ocr_error'));
                setSettings(prev => ({ ...prev, maskAuto: false }));
                setOcrStatus('');
                return false;
            } finally {
                await worker.terminate();
            }
        };
        if (!await performAutoMask()) {
            setIsProcessing(false);
            return;
        }
    }

    const drawRect = { x: 1308 - cropRect.x, y: 209 - cropRect.y, width: 1566 - 1308, height: 247 - 209, color: '#ffe1d8' };

    const processSingleImage = (imageFile: File): Promise<HTMLCanvasElement> => {
        return new Promise<HTMLCanvasElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                // Create a temporary canvas for image manipulation
                const tempCanvas = document.createElement('canvas');
                const tempCtx = tempCanvas.getContext('2d');
                if (!tempCtx) return reject(new Error('Could not get temporary canvas context'));

                tempCanvas.width = img.width;
                tempCanvas.height = img.height;
                tempCtx.drawImage(img, 0, 0);

                // Apply mask if enabled
                if (settings.maskEnabled) {
                    tempCtx.fillStyle = settings.maskColor;
                    tempCtx.fillRect(currentMaskRect.x, currentMaskRect.y, currentMaskRect.width, currentMaskRect.height);
                }

                // Now, create the final canvas for cropping
                const finalCanvas = document.createElement('canvas');
                finalCanvas.width = cropRect.width;
                finalCanvas.height = cropRect.height;
                const finalCtx = finalCanvas.getContext('2d');
                if (!finalCtx) return reject(new Error('Could not get final canvas context'));

                // Crop from the temporary canvas onto the final canvas
                finalCtx.drawImage(tempCanvas, cropRect.x, cropRect.y, cropRect.width, cropRect.height, 0, 0, cropRect.width, cropRect.height);

                // Draw rectangle (original feature) - this should be relative to the cropped canvas
                finalCtx.fillStyle = drawRect.color;
                finalCtx.fillRect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);

                resolve(finalCanvas);
            };
            img.onerror = reject;
            img.src = URL.createObjectURL(imageFile);
        });
    };

    const processedImages: HTMLCanvasElement[] = await Promise.all(
      images.map(imageFile => processSingleImage(imageFile))
    );

    const createMontage = (): string | null => {
        if (processedImages.length === 0) {
            return null;
        }
        const firstImage = processedImages[0];
        const imageWidth = firstImage.width;
        const imageHeight = firstImage.height;
        const cols = Math.min(settings.colCount, processedImages.length);
        const rows = Math.ceil(processedImages.length / cols);

        const montageCanvas = canvasRef.current;
        if (!montageCanvas) {
            setIsProcessing(false);
            return null;
        }
        const montageCtx = montageCanvas.getContext('2d');
        if (!montageCtx) {
            setIsProcessing(false);
            return null;
        }

        montageCanvas.width = (imageWidth * cols) + (settings.offsetX * (cols + 1));
        montageCanvas.height = (imageHeight * rows) + (settings.offsetY * (rows + 1));


        // Background color
        montageCtx.fillStyle = settings.bgColor;
        montageCtx.fillRect(0, 0, montageCanvas.width, montageCanvas.height);

        // Draw images
        processedImages.forEach((img, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            const x = settings.offsetX + col * (imageWidth + settings.offsetX);
            const y = settings.offsetY + row * (imageHeight + settings.offsetY);
            montageCtx.drawImage(img, x, y);
        });

        return montageCanvas.toDataURL('image/webp', settings.quality / 100);
    };

    const url = createMontage();
    setProcessedImageUrl(url);

    setIsProcessing(false);
  };

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        {t('title')}
      </Typography>
      <Grid container spacing={3}>
        <Grid size={{xs:12, md:4}}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>
                {t('settings')}
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{xs:12}}>
                  <TextField label={t('columns')} type="number" name="colCount" value={settings.colCount} onChange={handleSettingChange} fullWidth />
                </Grid>
                <Grid size={{xs:12}}>
                  <TextField label={t('offset_px')} type="number" name="offsetX" value={settings.offsetX} onChange={handleSettingChange} fullWidth />
                </Grid>
                <Grid size={{xs:12}}>
                    <Typography gutterBottom>{t('background_color')}</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Input
                            type="color"
                            name="bgColor"
                            value={settings.bgColor}
                            onChange={handleSettingChange}
                            sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }}
                        />
                        <TextField
                            variant="outlined"
                            size="small"
                            name="bgColor"
                            value={settings.bgColor}
                            onChange={handleSettingChange}
                            sx={{ ml: 2, flexGrow: 1 }}
                        />
                    </Box>
                </Grid>
                <Grid size={{xs:12}}>
                    <Typography gutterBottom>{t('quality')}</Typography>
                    <Slider name="quality" value={settings.quality} onChange={handleSliderChange('quality')} aria-labelledby="input-slider" min={1} max={100} />
                </Grid>
              </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>
                    {t('cropping')}
                </Typography>
                <FormControlLabel
                    control={<Switch checked={settings.cropAuto} onChange={handleSettingChange} name="cropAuto" />}
                    label={t('enable_auto_mode')}
                />
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}><TextField label={t('crop_x')} type="number" name="cropX" value={settings.cropX} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('crop_y')} type="number" name="cropY" value={settings.cropY} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('crop_width')} type="number" name="cropWidth" value={settings.cropWidth} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                    <Grid size={{xs:6}}><TextField label={t('crop_height')} type="number" name="cropHeight" value={settings.cropHeight} onChange={handleSettingChange} fullWidth disabled={settings.cropAuto} /></Grid>
                </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>
                    {t('masking')}
                </Typography>
                <FormControlLabel
                    control={<Switch checked={settings.maskEnabled} onChange={handleSettingChange} name="maskEnabled" />}
                    label={t('enable_mask')}
                />
                {settings.maskEnabled && (
                    <FormControlLabel
                        control={<Switch checked={settings.maskAuto} onChange={handleSettingChange} name="maskAuto" />}
                        label={t('enable_auto_mode')}
                    />
                )}
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}>
                        <TextField label={t('mask_x')} type="number" name="maskX" value={settings.maskX} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} />
                    </Grid>
                    <Grid size={{xs:6}}>
                        <TextField label={t('mask_y')} type="number" name="maskY" value={settings.maskY} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} />
                    </Grid>
                    <Grid size={{xs:6}}>
                        <TextField label={t('mask_width')} type="number" name="maskWidth" value={settings.maskWidth} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} />
                    </Grid>
                    <Grid size={{xs:6}}>
                        <TextField label={t('mask_height')} type="number" name="maskHeight" value={settings.maskHeight} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled || settings.maskAuto} />
                    </Grid>
                    <Grid size={{xs:12}}>
                        <Typography gutterBottom>{t('mask_color')}</Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Input
                                type="color"
                                name="maskColor"
                                value={settings.maskColor}
                                onChange={handleSettingChange}
                                sx={{ width: 50, height: 40, p: 0, border: 'none', '&::-webkit-color-swatch-wrapper': { p: 0 }, '&::-webkit-color-swatch': { border: 'none' } }}
                                disabled={!settings.maskEnabled}
                            />
                            <TextField
                                variant="outlined"
                                size="small"
                                name="maskColor"
                                value={settings.maskColor}
                                onChange={handleSettingChange}
                                sx={{ ml: 2, flexGrow: 1 }}
                                disabled={!settings.maskEnabled}
                            />
                        </Box>
                    </Grid>
                </Grid>
            </CardContent>
          </Card>
        </Grid>
        <Grid size={{xs:12, md:8}}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>
                {t('upload_and_process')}
              </Typography>
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