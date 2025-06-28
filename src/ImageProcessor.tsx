import React, { useState, useRef, useEffect } from 'react';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Input } from '@mui/material';

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

  const handleSettingChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = event.target;
    setSettings(prev => ({
      ...prev,
      [name]: type === 'number' ? parseInt(value, 10) : value,
    }));
  };

  const handleSliderChange = (name: string) => (event: Event, value: number | number[]) => {
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
    setIsProcessing(true);
    setProcessedImageUrl(null);

    const cropRect = { x: settings.cropX, y: settings.cropY, width: settings.cropWidth, height: settings.cropHeight };
    const drawRect = { x: 1308 - cropRect.x, y: 209 - cropRect.y, width: 1566 - 1308, height: 247 - 209, color: '#ffe1d8' };

    const processedImages: HTMLCanvasElement[] = await Promise.all(
      images.map(imageFile => {
        return new Promise<HTMLCanvasElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = cropRect.width;
            canvas.height = cropRect.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return reject(new Error('Could not get canvas context'));

            // Crop
            ctx.drawImage(img, cropRect.x, cropRect.y, cropRect.width, cropRect.height, 0, 0, cropRect.width, cropRect.height);

            // Draw rectangle
            ctx.fillStyle = drawRect.color;
            ctx.fillRect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);

            resolve(canvas);
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
        <Grid xs={12} md={4}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" gutterBottom>
                Settings
              </Typography>
              <Grid container spacing={2}>
                <Grid xs={12}>
                  <TextField label="Columns" type="number" name="colCount" value={settings.colCount} onChange={handleSettingChange} fullWidth />
                </Grid>
                <Grid xs={12}>
                  <TextField label="Offset (px)" type="number" name="offsetX" value={settings.offsetX} onChange={handleSettingChange} fullWidth />
                </Grid>
                <Grid xs={12}>
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
                <Grid xs={12}>
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
                    <Grid xs={6}><TextField label="Crop X" type="number" name="cropX" value={settings.cropX} onChange={handleSettingChange} fullWidth /></Grid>
                    <Grid xs={6}><TextField label="Crop Y" type="number" name="cropY" value={settings.cropY} onChange={handleSettingChange} fullWidth /></Grid>
                    <Grid xs={6}><TextField label="Crop Width" type="number" name="cropWidth" value={settings.cropWidth} onChange={handleSettingChange} fullWidth /></Grid>
                    <Grid xs={6}><TextField label="Crop Height" type="number" name="cropHeight" value={settings.cropHeight} onChange={handleSettingChange} fullWidth /></Grid>
                </Grid>
            </CardContent>
          </Card>
        </Grid>
        <Grid xs={12} md={8}>
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
