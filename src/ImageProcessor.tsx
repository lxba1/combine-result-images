import React, { useState, useRef, useEffect } from 'react';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Input, Switch, FormControlLabel } from '@mui/material';

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
}

const ImageProcessor: React.FC = () => {
  const [settings, setSettings] = useState<ImageSettings>(() => {
    const savedSettings = localStorage.getItem('imageProcessorSettings');
    if (savedSettings) {
      return JSON.parse(savedSettings);
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
        maskEnabled: false,
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
      alert('Please select images first.');
      return;
    }

    // Validation for Columns and Offset
    if (isNaN(settings.colCount) || settings.colCount <= 0) {
      alert('Columns must be a positive number.');
      return;
    }
    if (isNaN(settings.offsetX) || settings.offsetX < 0) {
      alert('Offset (px) cannot be empty or negative.');
      return;
    }

    // Validation for Cropping parameters
    if (isNaN(settings.cropX) || isNaN(settings.cropY) || isNaN(settings.cropWidth) || isNaN(settings.cropHeight)) {
      alert('Cropping parameters (X, Y, Width, Height) cannot be empty.');
      return;
    }
    if (settings.cropWidth <= 0 || settings.cropHeight <= 0) {
      alert('Cropping Width and Height must be positive values.');
      return;
    }
    if (settings.cropX < 0 || settings.cropY < 0) {
      alert('Cropping X and Y coordinates cannot be negative.');
      return;
    }

    // Validation for Masking parameters if enabled
    if (settings.maskEnabled) {
      if (isNaN(settings.maskX) || isNaN(settings.maskY) || isNaN(settings.maskWidth) || isNaN(settings.maskHeight)) {
        alert('Masking parameters (X, Y, Width, Height) cannot be empty when enabled.');
        return;
      }
      if (settings.maskWidth <= 0 || settings.maskHeight <= 0) {
        alert('Masking Width and Height must be positive values when enabled.');
        return;
      }
      if (settings.maskX < 0 || settings.maskY < 0) {
        alert('Masking X and Y coordinates cannot be negative when enabled.');
        return;
      }
    }

    setIsProcessing(true);
    setProcessedImageUrl(null);

    const cropRect = { x: settings.cropX, y: settings.cropY, width: settings.cropWidth, height: settings.cropHeight };
    const drawRect = { x: 1308 - cropRect.x, y: 209 - cropRect.y, width: 1566 - 1308, height: 247 - 209, color: '#ffe1d8' };

    const processedImages: HTMLCanvasElement[] = await Promise.all(
      images.map(imageFile => {
        return new Promise<HTMLCanvasElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            // Create a temporary canvas for the original image to apply mask
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (!tempCtx) return reject(new Error('Could not get temporary canvas context'));

            // Draw original image onto temporary canvas
            tempCtx.drawImage(img, 0, 0);

            // Apply mask if enabled
            if (settings.maskEnabled) {
              tempCtx.fillStyle = settings.maskColor;
              tempCtx.fillRect(settings.maskX, settings.maskY, settings.maskWidth, settings.maskHeight);
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
      })
    );

    if (processedImages.length > 0) {
      const firstImage = processedImages[0];
      const imageWidth = firstImage.width;
      const imageHeight = firstImage.height;
      const cols = Math.min(settings.colCount, processedImages.length);
      const rows = Math.ceil(processedImages.length / cols);

      const montageCanvas = canvasRef.current;
      if (!montageCanvas) {
        setIsProcessing(false);
        return;
      }
      const montageCtx = montageCanvas.getContext('2d');
      if (!montageCtx) {
        setIsProcessing(false);
        return;
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

      const url = montageCanvas.toDataURL('image/webp', settings.quality / 100);
      setProcessedImageUrl(url);
    }

    setIsProcessing(false);
  };

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Image Combiner
      </Typography>
      <Grid container spacing={3}>
        <Grid size={{xs:12, md:4}}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>
                Settings
              </Typography>
              <Grid container spacing={2}>
                <Grid size={{xs:12}}>
                  <TextField label="Columns" type="number" name="colCount" value={settings.colCount} onChange={handleSettingChange} fullWidth />
                </Grid>
                <Grid size={{xs:12}}>
                  <TextField label="Offset (px)" type="number" name="offsetX" value={settings.offsetX} onChange={handleSettingChange} fullWidth />
                </Grid>
                <Grid size={{xs:12}}>
                    <Typography gutterBottom>Background Color</Typography>
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
                    <Typography gutterBottom>Quality</Typography>
                    <Slider name="quality" value={settings.quality} onChange={handleSliderChange('quality')} aria-labelledby="input-slider" min={1} max={100} />
                </Grid>
              </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>
                    Cropping
                </Typography>
                <Grid container spacing={2}>
                    <Grid size={{xs:6}}><TextField label="Crop X" type="number" name="cropX" value={settings.cropX} onChange={handleSettingChange} fullWidth /></Grid>
                    <Grid size={{xs:6}}><TextField label="Crop Y" type="number" name="cropY" value={settings.cropY} onChange={handleSettingChange} fullWidth /></Grid>
                    <Grid size={{xs:6}}><TextField label="Crop Width" type="number" name="cropWidth" value={settings.cropWidth} onChange={handleSettingChange} fullWidth /></Grid>
                    <Grid size={{xs:6}}><TextField label="Crop Height" type="number" name="cropHeight" value={settings.cropHeight} onChange={handleSettingChange} fullWidth /></Grid>
                </Grid>
            </CardContent>
          </Card>
          <Card sx={{ mt: 3 }}>
            <CardContent>
                <Typography variant="h5" component="h2" gutterBottom>
                    Masking
                </Typography>
                <FormControlLabel
                    control={<Switch checked={settings.maskEnabled} onChange={handleSettingChange} name="maskEnabled" />}
                    label="Enable Mask"
                />
                <Grid container spacing={2} sx={{ mt: 1 }}>
                    <Grid size={{xs:6}}>
                        <TextField label="Mask X" type="number" name="maskX" value={settings.maskX} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled} />
                    </Grid>
                    <Grid size={{xs:6}}>
                        <TextField label="Mask Y" type="number" name="maskY" value={settings.maskY} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled} />
                    </Grid>
                    <Grid size={{xs:6}}>
                        <TextField label="Mask Width" type="number" name="maskWidth" value={settings.maskWidth} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled} />
                    </Grid>
                    <Grid size={{xs:6}}>
                        <TextField label="Mask Height" type="number" name="maskHeight" value={settings.maskHeight} onChange={handleSettingChange} fullWidth disabled={!settings.maskEnabled} />
                    </Grid>
                    <Grid size={{xs:12}}>
                        <Typography gutterBottom>Mask Color</Typography>
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
                Upload & Process
              </Typography>
              <Button variant="contained" component="label" fullWidth>
                Upload Images
                <input type="file" hidden accept="image/png" multiple onChange={handleFileChange} />
              </Button>
              {images.length > 0 && <Typography sx={{ mt: 1 }}>{images.length} files selected</Typography>}
              <Box sx={{ my: 2 }}>
                <Button variant="contained" color="primary" onClick={processImages} disabled={isProcessing || images.length === 0} fullWidth>
                  {isProcessing ? <CircularProgress size={24} /> : 'Process Images'}
                </Button>
              </Box>
              {processedImageUrl && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="h6" gutterBottom>Result</Typography>
                  <img src={processedImageUrl} alt="Processed Montage" style={{ maxWidth: '100%', border: '1px solid #ccc', borderRadius: '4px' }} />
                  <Button variant="contained" href={processedImageUrl} download="tile.webp" fullWidth sx={{ mt: 1 }}>
                    Download Image
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

