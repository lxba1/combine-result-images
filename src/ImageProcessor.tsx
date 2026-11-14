import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Switch, FormControlLabel, Select, MenuItem, InputLabel, FormControl, Accordion, AccordionSummary, AccordionDetails, IconButton, Menu, ListItemIcon, ListItemText, Tooltip, InputAdornment } from '@mui/material';
import { useColorScheme, styled } from '@mui/material/styles';
import { PlayArrow, ExpandMore as ExpandMoreIcon, GetApp as DownloadIcon, AddPhotoAlternate as AddPhotoIcon, LightMode as LightModeIcon, DarkMode as DarkModeIcon, SettingsBrightness as SystemModeIcon } from '@mui/icons-material';
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
type SortOrder = 'date_asc' | 'date_desc' | 'name_asc' | 'name_desc' | 'none';

const compareFileNames = (a: File, b: File) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Returns image files ordered according to the selected sort mode without mutating the source array. */
const sortImageFiles = (files: File[], sortOrder: SortOrder): File[] => {
  if (sortOrder === 'none') {
    return files;
  }
  return [...files].sort((a, b) => {
    switch (sortOrder) {
      case 'date_asc':
        return (a.lastModified - b.lastModified) || compareFileNames(a, b);
      case 'date_desc':
        return (b.lastModified - a.lastModified) || compareFileNames(b, a);
      case 'name_asc':
        return compareFileNames(a, b);
      case 'name_desc':
        return compareFileNames(b, a);
      default:
        return 0;
    }
  });
};

interface ImageSettings {
  colCount: number;
  offsetX: number;
  offsetY: number;
  sortOrder: SortOrder;
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

type ThemeMode = 'system' | 'light' | 'dark';

const THEME_MODES: { value: ThemeMode; labelKey: string; icon: React.ReactElement }[] = [
  { value: 'system', labelKey: 'theme_system', icon: <SystemModeIcon fontSize="small" /> },
  { value: 'light', labelKey: 'theme_light', icon: <LightModeIcon fontSize="small" /> },
  { value: 'dark', labelKey: 'theme_dark', icon: <DarkModeIcon fontSize="small" /> },
];

/** Compact header menu button for switching between system, light, and dark modes. */
const ThemeModeButton: React.FC = () => {
  const { t } = useTranslation();
  const { mode, setMode } = useColorScheme();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const currentMode: ThemeMode = mode ?? 'system';
  const currentOption = THEME_MODES.find((option) => option.value === currentMode) ?? THEME_MODES[0];

  return (
    <>
      <Tooltip title={`${t('theme_mode')}: ${t(currentOption.labelKey)}`}>
        <IconButton
          size="small"
          onClick={(event) => setAnchorEl(event.currentTarget)}
          aria-label={t('theme_mode')}
          aria-controls={anchorEl ? 'theme-mode-menu' : undefined}
          aria-haspopup="true"
          aria-expanded={Boolean(anchorEl)}
          sx={{ border: 1, borderColor: 'divider' }}
        >
          {currentOption.icon}
        </IconButton>
      </Tooltip>
      <Menu
        id="theme-mode-menu"
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {THEME_MODES.map((option) => (
          <MenuItem
            key={option.value}
            selected={currentMode === option.value}
            onClick={() => {
              setMode(option.value);
              setAnchorEl(null);
            }}
          >
            <ListItemIcon>{option.icon}</ListItemIcon>
            <ListItemText>{t(option.labelKey)}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

const isValidHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

const ColorSwatchInput = styled('input')({
  width: 22,
  height: 22,
  padding: 0,
  border: '1px solid rgba(128, 128, 128, 0.45)',
  borderRadius: 4,
  backgroundColor: 'transparent',
  cursor: 'pointer',
  flexShrink: 0,
  display: 'block',
  '&::-webkit-color-swatch-wrapper': { padding: 0 },
  '&::-webkit-color-swatch': { border: 'none', borderRadius: 3 },
  '&::-moz-color-swatch': { border: 'none', borderRadius: 3 },
});

interface ColorSettingFieldProps {
  label: string;
  name: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

/** Compact outlined hex color field with an inline clickable color swatch. */
const ColorSettingField: React.FC<ColorSettingFieldProps> = ({ label, name, value, onChange }) => (
  <TextField
    label={label}
    variant="outlined"
    size="small"
    fullWidth
    name={name}
    value={value}
    onChange={onChange}
    slotProps={{
      input: {
        startAdornment: (
          <InputAdornment position="start">
            <ColorSwatchInput
              type="color"
              name={name}
              value={isValidHexColor(value) ? value : '#000000'}
              onChange={onChange}
              aria-label={label}
            />
          </InputAdornment>
        ),
      },
    }}
  />
);

interface NumericTextFieldProps {
  label: string;
  name: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  onCommit: (name: string, value: number, options?: { finalize?: boolean }) => void;
}

/**
 * Uncontrolled-while-focused numeric input so users can clear or type decimals cleanly,
 * clamping and normalizing to [min, max] on blur or Enter.
 */
const NumericTextField: React.FC<NumericTextFieldProps> = ({
  label,
  name,
  value,
  min,
  max,
  step = 1,
  integer = false,
  disabled = false,
  onCommit,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const isFocusedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const preEditValueRef = useRef(value);

  const normalize = (num: number): number => {
    let next = integer ? Math.round(num) : Math.round(num * 10000) / 10000;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    return next;
  };

  useEffect(() => {
    if (disabled) {
      isFocusedRef.current = false;
      isDirtyRef.current = false;
    }
    if ((!isFocusedRef.current || !isDirtyRef.current) && inputRef.current) {
      inputRef.current.value = String(value);
      preEditValueRef.current = value;
    }
  }, [value, disabled]);

  const handleFocus = () => {
    isFocusedRef.current = true;
    isDirtyRef.current = false;
    preEditValueRef.current = value;
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    isDirtyRef.current = true;
    const raw = event.target.value;
    if (raw === '') return;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;

    const withinBounds =
      (min === undefined || parsed >= min) &&
      (max === undefined || parsed <= max);
    if (!isFocusedRef.current || withinBounds) {
      onCommit(name, normalize(parsed), { finalize: !isFocusedRef.current });
    }
  };

  const commitDraft = () => {
    const raw = inputRef.current?.value ?? '';
    const parsed = raw.trim() === '' ? preEditValueRef.current : Number(raw);
    const next = Number.isFinite(parsed) ? normalize(parsed) : normalize(preEditValueRef.current);
    preEditValueRef.current = next;
    isDirtyRef.current = false;
    if (inputRef.current) {
      inputRef.current.value = String(next);
    }
    onCommit(name, next, { finalize: true });
  };

  const handleBlur = () => {
    isFocusedRef.current = false;
    commitDraft();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      commitDraft();
    }
  };

  return (
    <TextField
      label={label}
      type="number"
      size="small"
      fullWidth
      name={name}
      defaultValue={value}
      disabled={disabled}
      inputRef={inputRef}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      slotProps={{
        inputLabel: { shrink: true },
        htmlInput: { min, max, step },
      }}
    />
  );
};

const getActivePreset = (current: RatioRect, presets: Record<string, RatioRect>): string => {
  const isMatch = (a: RatioRect, b: RatioRect) =>
    Math.abs(a.rx0 - b.rx0) < 0.0001 && Math.abs(a.ry0 - b.ry0) < 0.0001 &&
    Math.abs(a.rx1 - b.rx1) < 0.0001 && Math.abs(a.ry1 - b.ry1) < 0.0001;

  for (const [key, val] of Object.entries(presets)) {
    if (isMatch(current, val)) return key;
  }
  return 'custom';
};

interface MaskAccordionProps {
  title: string;
  enabledName: 'maskEnabled' | 'selfMaskEnabled';
  enabled: boolean;
  modeName: 'maskMode' | 'selfMaskMode';
  mode: MaskMode;
  ratioKey: 'maskRatioRect' | 'selfMaskRatioRect';
  ratioRect: RatioRect;
  presets: Record<string, RatioRect>;
  rectPrefix: 'mask' | 'selfMask';
  rectValues: { x: number; y: number; width: number; height: number };
  colorName: 'maskColor' | 'selfMaskColor';
  colorValue: string;
  onSettingChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number | string>) => void;
  onNumericCommit: (name: string, value: number, options?: { finalize?: boolean }) => void;
  onRatioSliderChange: (axis: 'horizontal' | 'vertical') => (event: Event, value: number | number[]) => void;
  onPresetChange: (event: SelectChangeEvent<string>) => void;
}

/** Shared settings accordion for target and self masking controls with compact 2-column pairing. */
const MaskAccordion: React.FC<MaskAccordionProps> = ({
  title,
  enabledName,
  enabled,
  modeName,
  mode,
  ratioKey,
  ratioRect,
  presets,
  rectPrefix,
  rectValues,
  colorName,
  colorValue,
  onSettingChange,
  onNumericCommit,
  onRatioSliderChange,
  onPresetChange,
}) => {
  const { t } = useTranslation();

  return (
    <Accordion sx={{ mt: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
          <Typography variant="h6">{title}</Typography>
          <Typography variant="caption" color={enabled ? 'primary' : 'text.secondary'}>
            {enabled ? t(`mode_${mode}`) : 'OFF'}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <FormControlLabel
          control={<Switch checked={enabled} onChange={onSettingChange} name={enabledName} />}
          label={t('enable')}
        />
        {enabled && (
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 6 }}>
              <FormControl fullWidth size="small">
                <InputLabel id={`${modeName}-label`}>{t('mode')}</InputLabel>
                <Select labelId={`${modeName}-label`} name={modeName} value={mode} label={t('mode')} onChange={onSettingChange}>
                  <MenuItem value="manual">{t('mode_manual')}</MenuItem>
                  <MenuItem value="ratio">{t('mode_ratio')}</MenuItem>
                  <MenuItem value="ocr">{t('mode_ocr')}</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 6 }}>
              <ColorSettingField label={t('color')} name={colorName} value={colorValue} onChange={onSettingChange} />
            </Grid>
            {mode === 'ratio' ? (
              <>
                <Grid size={{ xs: 12 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id={`${ratioKey}-preset-label`}>{t('preset')}</InputLabel>
                    <Select
                      labelId={`${ratioKey}-preset-label`}
                      value={getActivePreset(ratioRect, presets)}
                      label={t('preset')}
                      onChange={onPresetChange}
                    >
                      <MenuItem value="custom" disabled sx={{ fontStyle: 'italic' }}>{t('preset_custom')}</MenuItem>
                      <MenuItem value="name">{t('preset_name')}</MenuItem>
                      <MenuItem value="title">{t('preset_title')}</MenuItem>
                      <MenuItem value="full">{t('preset_full')}</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <Typography variant="body2" color="text.secondary" gutterBottom>{t('range_horizontal')}</Typography>
                  <Box sx={{ px: 1 }}>
                    <Slider
                      size="small"
                      value={[Math.min(ratioRect.rx0, ratioRect.rx1), Math.max(ratioRect.rx0, ratioRect.rx1)]}
                      onChange={onRatioSliderChange('horizontal')}
                      valueLabelDisplay="auto"
                      min={0}
                      max={1}
                      step={0.001}
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} gutterBottom>{t('range_vertical')}</Typography>
                  <Box sx={{ px: 1 }}>
                    <Slider
                      size="small"
                      value={[Math.min(ratioRect.ry0, ratioRect.ry1), Math.max(ratioRect.ry0, ratioRect.ry1)]}
                      onChange={onRatioSliderChange('vertical')}
                      valueLabelDisplay="auto"
                      min={0}
                      max={1}
                      step={0.001}
                    />
                  </Box>
                </Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_left')} name={`${ratioKey}.rx0`} value={ratioRect.rx0} min={0} max={1} step={0.001} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_top')} name={`${ratioKey}.ry0`} value={ratioRect.ry0} min={0} max={1} step={0.001} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_right')} name={`${ratioKey}.rx1`} value={ratioRect.rx1} min={0} max={1} step={0.001} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_bottom')} name={`${ratioKey}.ry1`} value={ratioRect.ry1} min={0} max={1} step={0.001} onCommit={onNumericCommit} /></Grid>
              </>
            ) : (
              <>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('x')} name={`${rectPrefix}X`} value={rectValues.x} min={0} integer disabled={mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('y')} name={`${rectPrefix}Y`} value={rectValues.y} min={0} integer disabled={mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('width')} name={`${rectPrefix}Width`} value={rectValues.width} min={1} integer disabled={mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('height')} name={`${rectPrefix}Height`} value={rectValues.height} min={1} integer disabled={mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
              </>
            )}
          </Grid>
        )}
      </AccordionDetails>
    </Accordion>
  );
};

const ImageProcessor: React.FC = () => {
  const { t } = useTranslation();

  const [settings, setSettings] = useState<ImageSettings>(() => {
    const savedSettings = localStorage.getItem('imageProcessorSettings');
    const defaults: ImageSettings = {
      colCount: 2,
      offsetX: 8,
      offsetY: 8,
      sortOrder: 'date_asc',
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
      try {
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
        const merged: ImageSettings = { ...defaults, ...parsed };
        const clampRatioRect = (rect: RatioRect): RatioRect => {
          const rx0 = clamp01(Number.isFinite(rect?.rx0) ? rect.rx0 : 0);
          const ry0 = clamp01(Number.isFinite(rect?.ry0) ? rect.ry0 : 0);
          const rx1 = clamp01(Number.isFinite(rect?.rx1) ? rect.rx1 : 1);
          const ry1 = clamp01(Number.isFinite(rect?.ry1) ? rect.ry1 : 1);
          return {
            rx0: Math.min(rx0, rx1),
            ry0: Math.min(ry0, ry1),
            rx1: Math.max(rx0, rx1),
            ry1: Math.max(ry0, ry1),
          };
        };
        const toNonNegativeInt = (v: unknown, fallback: number, min = 0) =>
          typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.round(v)) : fallback;
        return {
          ...merged,
          cropX: toNonNegativeInt(merged.cropX, defaults.cropX, 0),
          cropY: toNonNegativeInt(merged.cropY, defaults.cropY, 0),
          cropWidth: toNonNegativeInt(merged.cropWidth, defaults.cropWidth, 1),
          cropHeight: toNonNegativeInt(merged.cropHeight, defaults.cropHeight, 1),
          maskX: toNonNegativeInt(merged.maskX, defaults.maskX, 0),
          maskY: toNonNegativeInt(merged.maskY, defaults.maskY, 0),
          maskWidth: toNonNegativeInt(merged.maskWidth, defaults.maskWidth, 1),
          maskHeight: toNonNegativeInt(merged.maskHeight, defaults.maskHeight, 1),
          selfMaskX: toNonNegativeInt(merged.selfMaskX, defaults.selfMaskX, 0),
          selfMaskY: toNonNegativeInt(merged.selfMaskY, defaults.selfMaskY, 0),
          selfMaskWidth: toNonNegativeInt(merged.selfMaskWidth, defaults.selfMaskWidth, 1),
          selfMaskHeight: toNonNegativeInt(merged.selfMaskHeight, defaults.selfMaskHeight, 1),
          maskRatioRect: clampRatioRect(merged.maskRatioRect),
          selfMaskRatioRect: clampRatioRect(merged.selfMaskRatioRect),
        };
      } catch {
        return defaults;
      }
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
    const files = event.target.files;
    if (files && files.length > 0) {
      setImages(Array.from(files));
      setProcessedImageUrl(null); // This will also trigger the cleanup effect for the old URL
    }
    // Reset input value so picking the exact same file(s) again still triggers onChange
    event.target.value = '';
  };

  const handleNumericSettingCommit = (name: string, newValue: number, options?: { finalize?: boolean }) => {
    if (name.startsWith('maskRatioRect.') || name.startsWith('selfMaskRatioRect.')) {
      const [parent, key] = name.split('.') as ['maskRatioRect' | 'selfMaskRatioRect', keyof RatioRect];
      setSettings(prev => {
        const nextRect = { ...prev[parent], [key]: newValue };
        if (options?.finalize) {
          if (key === 'rx0') nextRect.rx1 = Math.max(nextRect.rx1, newValue);
          if (key === 'rx1') nextRect.rx0 = Math.min(nextRect.rx0, newValue);
          if (key === 'ry0') nextRect.ry1 = Math.max(nextRect.ry1, newValue);
          if (key === 'ry1') nextRect.ry0 = Math.min(nextRect.ry0, newValue);
        }
        return { ...prev, [parent]: nextRect };
      });
      return;
    }

    setSettings(prev => ({
      ...prev,
      [name]: newValue,
    }));
  };

  const handleSettingChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number | string>) => {
    const name = event.target.name;
    let newValue: string | number | boolean;

    if ('type' in event.target && event.target.type === 'checkbox') { // Checkbox
        newValue = (event.target as HTMLInputElement).checked;
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

    setSettings(prev => ({
      ...prev,
      [name]: newValue,
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

  const loadAndDrawFirstImage = async (firstImageFile?: File): Promise<ImageBitmap | null> => {
    if (!firstImageFile) return null;
    try {
      const bitmap = await decodeFirst(firstImageFile); // Call decodeFirst
      return bitmap;
    } catch (error) {
      console.error("Failed to decode first image even with fallback:", error);
      throw new Error('First image failed to load.', { cause: error });
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

      const orderedImages = sortImageFiles(images, settings.sortOrder);

      const needsFirstImage = settings.cropAuto ||
        (settings.maskEnabled && (settings.maskMode === 'ratio' || settings.maskMode === 'ocr')) ||
        (settings.selfMaskEnabled && (settings.selfMaskMode === 'ratio' || settings.selfMaskMode === 'ocr'));

      if (needsFirstImage) {
          firstImageBitmap = await loadAndDrawFirstImage(orderedImages[0]);
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
      montageCanvas.height = (Math.ceil(orderedImages.length / finalSettings.colCount) * cropRect.height) + (finalSettings.offsetY * (Math.ceil(orderedImages.length / finalSettings.colCount) + 1));

      // const maxPixels = 16_777_216; // Approximately 4096x4096
      // if (montageCanvas.width * montageCanvas.height > maxPixels) {
      //   throw new Error(t('alert_canvas_too_large', { maxPixels: maxPixels.toLocaleString() }));
      // }

      montageCtx.fillStyle = finalSettings.bgColor;
      montageCtx.fillRect(0, 0, montageCanvas.width, montageCanvas.height);

      for (let i = 0; i < orderedImages.length; i++) {
        const imageFile = orderedImages[i];
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
      } catch (cleanupError) {
        console.warn('Failed to terminate OCR worker during cleanup:', cleanupError);
      }
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
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography variant="h4" component="h1">{t('title')}</Typography>
          <Typography variant="caption" color="text.secondary">v{packageJson.version}</Typography>
        </Box>
        <ThemeModeButton />
      </Box>
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 5, lg: 4 }}>
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
                <Typography variant="h6">{t('settings')}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('columns')}: {settings.colCount}, {settings.outputFormat === 'png' ? 'PNG' : `${t('quality')}: ${settings.quality}%`}
                </Typography>
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Grid container spacing={2}>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="col-count-label">{t('columns')}</InputLabel>
                    <Select labelId="col-count-label" name="colCount" value={settings.colCount} label={t('columns')} onChange={handleSettingChange}>
                      {[...Array(10)].map((_, i) => (
                        <MenuItem key={i + 1} value={i + 1}>{i + 1}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="offset-label">{t('offset_px')}</InputLabel>
                    <Select labelId="offset-label" name="offsetX" value={settings.offsetX} label={t('offset_px')} onChange={handleSettingChange}>
                      {[...Array(51)].map((_, i) => (
                        <MenuItem key={i} value={i}>{i}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="sort-order-label">{t('sort_order')}</InputLabel>
                    <Select labelId="sort-order-label" name="sortOrder" value={settings.sortOrder} label={t('sort_order')} onChange={handleSettingChange}>
                      <MenuItem value="date_asc">{t('sort_date_asc')}</MenuItem>
                      <MenuItem value="date_desc">{t('sort_date_desc')}</MenuItem>
                      <MenuItem value="name_asc">{t('sort_name_asc')}</MenuItem>
                      <MenuItem value="name_desc">{t('sort_name_desc')}</MenuItem>
                      <MenuItem value="none">{t('sort_none')}</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 6 }}><ColorSettingField label={t('background_color')} name="bgColor" value={settings.bgColor} onChange={handleSettingChange} /></Grid>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="output-format-label">{t('output_format')}</InputLabel>
                    <Select labelId="output-format-label" name="outputFormat" value={settings.outputFormat} label={t('output_format')} onChange={handleSettingChange}>
                      <MenuItem value="webp">WebP</MenuItem>
                      <MenuItem value="png">PNG</MenuItem>
                      <MenuItem value="jpeg">JPEG</MenuItem>
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <Typography
                    id="quality-slider-label"
                    variant="body2"
                    color={settings.outputFormat === 'png' ? 'text.disabled' : 'text.secondary'}
                    gutterBottom
                  >
                    {t('quality')}: {settings.quality}%
                  </Typography>
                  <Box sx={{ px: 1 }}>
                    <Slider
                      size="small"
                      name="quality"
                      value={settings.quality}
                      onChange={handleSliderChange('quality')}
                      aria-labelledby="quality-slider-label"
                      min={1}
                      max={100}
                      valueLabelDisplay="auto"
                      disabled={settings.outputFormat === 'png'}
                    />
                  </Box>
                </Grid>
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
                <Grid size={{ xs: 6 }}><NumericTextField label={t('x')} name="cropX" value={settings.cropX} min={0} integer disabled={settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('y')} name="cropY" value={settings.cropY} min={0} integer disabled={settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('width')} name="cropWidth" value={settings.cropWidth} min={1} integer disabled={settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('height')} name="cropHeight" value={settings.cropHeight} min={1} integer disabled={settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
              </Grid>
            </AccordionDetails>
          </Accordion>

          <MaskAccordion
            title={t('masking')}
            enabledName="maskEnabled"
            enabled={settings.maskEnabled}
            modeName="maskMode"
            mode={settings.maskMode}
            ratioKey="maskRatioRect"
            ratioRect={settings.maskRatioRect}
            presets={MASK_PRESETS}
            rectPrefix="mask"
            rectValues={{ x: settings.maskX, y: settings.maskY, width: settings.maskWidth, height: settings.maskHeight }}
            colorName="maskColor"
            colorValue={settings.maskColor}
            onSettingChange={handleSettingChange}
            onNumericCommit={handleNumericSettingCommit}
            onRatioSliderChange={(axis) => handleRatioSliderChange('maskRatioRect', axis)}
            onPresetChange={handlePresetChange('maskRatioRect')}
          />

          <MaskAccordion
            title={t('self_mask')}
            enabledName="selfMaskEnabled"
            enabled={settings.selfMaskEnabled}
            modeName="selfMaskMode"
            mode={settings.selfMaskMode}
            ratioKey="selfMaskRatioRect"
            ratioRect={settings.selfMaskRatioRect}
            presets={SELF_MASK_PRESETS}
            rectPrefix="selfMask"
            rectValues={{ x: settings.selfMaskX, y: settings.selfMaskY, width: settings.selfMaskWidth, height: settings.selfMaskHeight }}
            colorName="selfMaskColor"
            colorValue={settings.selfMaskColor}
            onSettingChange={handleSettingChange}
            onNumericCommit={handleNumericSettingCommit}
            onRatioSliderChange={(axis) => handleRatioSliderChange('selfMaskRatioRect', axis)}
            onPresetChange={handlePresetChange('selfMaskRatioRect')}
          />
        </Grid>
        <Grid size={{ xs: 12, md: 7, lg: 8 }}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" sx={{ mb: 2 }}>{t('upload_and_process')}</Typography>
              <Button variant="contained" component="label" fullWidth size="large" startIcon={<AddPhotoIcon />}>
                {t('upload_images')}
                <input type="file" hidden accept="image/png, image/jpeg" multiple onChange={handleFileChange} />
              </Button>
              {images.length > 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {t('files_selected', { count: images.length })}
                </Typography>
              )}
              <Box sx={{ mt: 2 }}>
                <Button
                  variant="contained"
                  color="primary"
                  onClick={processImages}
                  disabled={isProcessing || images.length === 0}
                  fullWidth
                  size="large"
                  startIcon={!isProcessing && <PlayArrow />}
                >
                  {isProcessing ? <CircularProgress size={24} color="inherit" /> : t('process_images')}
                </Button>
              </Box>
              {ocrStatus && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }} translate="no">
                  {ocrStatus}
                </Typography>
              )}
              {processedImageUrl && (
                <Box sx={{ mt: 3, overflowAnchor: 'none' }} ref={resultRef}>
                  <Typography variant="h6" gutterBottom>{t('result')}</Typography>
                  <Box
                    component="img"
                    src={processedImageUrl}
                    alt="Processed Montage"
                    sx={{
                      display: 'block',
                      maxWidth: '100%',
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                    }}
                  />
                  <Button variant="contained" href={processedImageUrl} download={downloadFilename} fullWidth size="large" sx={{ mt: 2 }} startIcon={<DownloadIcon />}>
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
