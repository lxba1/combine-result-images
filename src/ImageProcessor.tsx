import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, Box, Slider, Switch, FormControlLabel, Select, MenuItem, InputLabel, FormControl, Accordion, AccordionSummary, AccordionDetails, IconButton, Menu, ListItemIcon, ListItemText, Tooltip, InputAdornment, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Collapse } from '@mui/material';
import { useColorScheme, styled } from '@mui/material/styles';
import { PlayArrow, ExpandMore as ExpandMoreIcon, ExpandLess as ExpandLessIcon, GetApp as DownloadIcon, AddPhotoAlternate as AddPhotoIcon, LightMode as LightModeIcon, DarkMode as DarkModeIcon, SettingsBrightness as SystemModeIcon, Language as LanguageIcon, RestartAlt as RestartAltIcon, Check as CheckIcon, Close as CloseIcon, DeleteOutline as DeleteOutlineIcon, LockOutlined as LockOutlinedIcon } from '@mui/icons-material';
import type { SelectChangeEvent } from '@mui/material';
import Tesseract, { PSM } from 'tesseract.js';
import packageJson from '../package.json';
import { LANGUAGE_STORAGE_KEY } from './i18n';
import {
  type OcrSessionController,
  releaseOcrResources,
  runOcrMaskDetection,
  startOcrSession,
} from './ocrHelpers.ts';
import {
  type ImageSettings,
  type MaskMode,
  type RatioRect,
  type SortOrder,
  MASK_PRESETS,
  MAX_COL_COUNT,
  MAX_OFFSET_PX,
  MAX_WEBP_DIMENSION,
  MIN_COL_COUNT,
  MIN_OFFSET_PX,
  SELF_MASK_PRESETS,
  areSettingsDefault,
  commitRatioRectField,
  createDefaultSettings,
  evaluateMontageCanvasSize,
  isRatioRectEqual,
  loadSettingsFromStorage,
  normalizeHexColor,
  saveSettingsToStorage,
  validateSettingsBeforeProcess,
} from './settingsHelpers.ts';
import { detectAutoCropFromImage } from './cropHelpers.ts';
import {
  ImageDecodeError,
  ImageResolutionMismatchError,
  decodeImageWithFallback,
  prepareMontagePlan,
  renderMontageToBlob,
  resolveOutputExtension,
  type ImageDimensions,
} from './montageHelpers.ts';

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

/** Creates a lightweight 24-hour local timestamp formatter, omitting the current year to save space. */
const createFileTimestampFormatter = (locale?: string) => {
  const currentYear = new Date().getFullYear();
  const baseOptions: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  };
  const sameYearFmt = new Intl.DateTimeFormat(locale, baseOptions);
  const otherYearFmt = new Intl.DateTimeFormat(locale, { year: '2-digit', ...baseOptions });

  return (timestamp: number): string => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return '';
    }
    const date = new Date(timestamp);
    return (date.getFullYear() === currentYear ? sameYearFmt : otherYearFmt).format(date);
  };
};

interface HeaderMenuOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactElement;
}

interface HeaderMenuButtonProps<T extends string> {
  menuId: string;
  label: string;
  tooltip: string;
  icon: React.ReactElement;
  value: T;
  options: HeaderMenuOption<T>[];
  onSelect: (value: T) => void;
}

/** Compact icon button with an anchored dropdown menu for header preferences. */
function HeaderMenuButton<T extends string>({
  menuId,
  label,
  tooltip,
  icon,
  value,
  options,
  onSelect,
}: HeaderMenuButtonProps<T>) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const showIconColumn = options.some((option) => Boolean(option.icon));

  return (
    <>
      <Tooltip title={tooltip}>
        <IconButton
          size="small"
          onClick={(event) => setAnchorEl(event.currentTarget)}
          aria-label={label}
          aria-controls={anchorEl ? menuId : undefined}
          aria-haspopup="true"
          aria-expanded={Boolean(anchorEl)}
          sx={{ border: 1, borderColor: 'divider' }}
        >
          {icon}
        </IconButton>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {options.map((option) => (
          <MenuItem
            key={option.value}
            selected={value === option.value}
            onClick={() => {
              onSelect(option.value);
              setAnchorEl(null);
            }}
          >
            {showIconColumn && <ListItemIcon>{option.icon ?? null}</ListItemIcon>}
            <ListItemText>{option.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
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

  const currentMode: ThemeMode = mode ?? 'system';
  const currentOption = THEME_MODES.find((option) => option.value === currentMode) ?? THEME_MODES[0];

  return (
    <HeaderMenuButton
      menuId="theme-mode-menu"
      label={t('theme_mode')}
      tooltip={`${t('theme_mode')}: ${t(currentOption.labelKey)}`}
      icon={currentOption.icon}
      value={currentMode}
      options={THEME_MODES.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
        icon: option.icon,
      }))}
      onSelect={(nextMode) => setMode(nextMode)}
    />
  );
};

type SupportedLanguage = 'ja' | 'en';

const LANGUAGE_OPTIONS: { value: SupportedLanguage; label: string }[] = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
];

/** Compact header menu button for manually switching the UI language and persisting it. */
const LanguageButton: React.FC = () => {
  const { t, i18n } = useTranslation();

  const currentLanguage: SupportedLanguage = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
  const currentOption = LANGUAGE_OPTIONS.find((option) => option.value === currentLanguage) ?? LANGUAGE_OPTIONS[0];

  const handleSelectLanguage = (lng: SupportedLanguage) => {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
    } catch (error) {
      console.warn('Failed to persist language selection:', error);
    }
    void i18n.changeLanguage(lng);
  };

  return (
    <HeaderMenuButton
      menuId="language-menu"
      label={t('language')}
      tooltip={`${t('language')}: ${currentOption.label}`}
      icon={<LanguageIcon fontSize="small" />}
      value={currentLanguage}
      options={LANGUAGE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        icon: option.value === currentLanguage ? <CheckIcon fontSize="small" /> : undefined,
      }))}
      onSelect={handleSelectLanguage}
    />
  );
};

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
  '&:disabled': { cursor: 'not-allowed', opacity: 0.5 },
  '&::-webkit-color-swatch-wrapper': { padding: 0 },
  '&::-webkit-color-swatch': { border: 'none', borderRadius: 3 },
  '&::-moz-color-swatch': { border: 'none', borderRadius: 3 },
});

interface ColorSettingFieldProps {
  label: string;
  name: string;
  value: string;
  disabled?: boolean;
  onCommit: (name: string, value: string) => void;
}

/**
 * Compact outlined hex color field with an inline clickable color swatch.
 * Allows free text editing while focused and commits normalized lowercase `#rrggbb` values.
 */
const ColorSettingField: React.FC<ColorSettingFieldProps> = ({
  label,
  name,
  value,
  disabled = false,
  onCommit,
}) => {
  const normalizedValue = normalizeHexColor(value) ?? '#000000';
  const inputRef = useRef<HTMLInputElement>(null);
  const isFocusedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const lastValidRef = useRef(normalizedValue);

  useEffect(() => {
    lastValidRef.current = normalizedValue;
    if (disabled) {
      isFocusedRef.current = false;
      isDirtyRef.current = false;
    }
    if ((!isFocusedRef.current || !isDirtyRef.current) && inputRef.current) {
      inputRef.current.value = normalizedValue;
    }
  }, [normalizedValue, disabled]);

  const handleFocus = () => {
    isFocusedRef.current = true;
    isDirtyRef.current = false;
    lastValidRef.current = normalizedValue;
  };

  const handleTextChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    isDirtyRef.current = true;
    const trimmed = event.target.value.trim();
    if (trimmed.length === 7) {
      const next = normalizeHexColor(trimmed);
      if (next) {
        lastValidRef.current = next;
        onCommit(name, next);
      }
    }
  };

  const handleSwatchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = normalizeHexColor(event.target.value) ?? lastValidRef.current;
    lastValidRef.current = next;
    isDirtyRef.current = false;
    if (inputRef.current) {
      inputRef.current.value = next;
    }
    onCommit(name, next);
  };

  const commitDraft = () => {
    const raw = inputRef.current?.value ?? '';
    const next = normalizeHexColor(raw) ?? lastValidRef.current;
    lastValidRef.current = next;
    isDirtyRef.current = false;
    if (inputRef.current) {
      inputRef.current.value = next;
    }
    onCommit(name, next);
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
      variant="outlined"
      size="small"
      fullWidth
      name={name}
      defaultValue={normalizedValue}
      disabled={disabled}
      inputRef={inputRef}
      onFocus={handleFocus}
      onChange={handleTextChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      slotProps={{
        inputLabel: { shrink: true },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <ColorSwatchInput
                type="color"
                name={name}
                value={normalizedValue}
                disabled={disabled}
                onChange={handleSwatchChange}
                aria-label={label}
              />
            </InputAdornment>
          ),
        },
      }}
    />
  );
};

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
  for (const [key, val] of Object.entries(presets)) {
    if (isRatioRectEqual(current, val)) return key;
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
  disabled?: boolean;
  onSettingChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number | string>) => void;
  onNumericCommit: (name: string, value: number, options?: { finalize?: boolean }) => void;
  onColorCommit: (name: string, value: string) => void;
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
  disabled = false,
  onSettingChange,
  onNumericCommit,
  onColorCommit,
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
          disabled={disabled}
          control={<Switch checked={enabled} disabled={disabled} onChange={onSettingChange} name={enabledName} />}
          label={t('enable')}
        />
        {enabled && (
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 6 }}>
              <FormControl fullWidth size="small" disabled={disabled}>
                <InputLabel id={`${modeName}-label`}>{t('mode')}</InputLabel>
                <Select labelId={`${modeName}-label`} name={modeName} value={mode} label={t('mode')} onChange={onSettingChange}>
                  <MenuItem value="manual">{t('mode_manual')}</MenuItem>
                  <MenuItem value="ratio">{t('mode_ratio')}</MenuItem>
                  <MenuItem value="ocr">{t('mode_ocr')}</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 6 }}>
              <ColorSettingField label={t('color')} name={colorName} value={colorValue} disabled={disabled} onCommit={onColorCommit} />
            </Grid>
            {mode === 'ratio' ? (
              <>
                <Grid size={{ xs: 12 }}>
                  <FormControl fullWidth size="small" disabled={disabled}>
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
                  <Typography variant="body2" color={disabled ? 'text.disabled' : 'text.secondary'} gutterBottom>{t('range_horizontal')}</Typography>
                  <Box sx={{ px: 1 }}>
                    <Slider
                      size="small"
                      disabled={disabled}
                      value={[Math.min(ratioRect.rx0, ratioRect.rx1), Math.max(ratioRect.rx0, ratioRect.rx1)]}
                      onChange={onRatioSliderChange('horizontal')}
                      valueLabelDisplay="auto"
                      min={0}
                      max={1}
                      step={0.001}
                    />
                  </Box>
                  <Typography variant="body2" color={disabled ? 'text.disabled' : 'text.secondary'} sx={{ mt: 1 }} gutterBottom>{t('range_vertical')}</Typography>
                  <Box sx={{ px: 1 }}>
                    <Slider
                      size="small"
                      disabled={disabled}
                      value={[Math.min(ratioRect.ry0, ratioRect.ry1), Math.max(ratioRect.ry0, ratioRect.ry1)]}
                      onChange={onRatioSliderChange('vertical')}
                      valueLabelDisplay="auto"
                      min={0}
                      max={1}
                      step={0.001}
                    />
                  </Box>
                </Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_left')} name={`${ratioKey}.rx0`} value={ratioRect.rx0} min={0} max={1} step={0.001} disabled={disabled} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_top')} name={`${ratioKey}.ry0`} value={ratioRect.ry0} min={0} max={1} step={0.001} disabled={disabled} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_right')} name={`${ratioKey}.rx1`} value={ratioRect.rx1} min={0} max={1} step={0.001} disabled={disabled} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_bottom')} name={`${ratioKey}.ry1`} value={ratioRect.ry1} min={0} max={1} step={0.001} disabled={disabled} onCommit={onNumericCommit} /></Grid>
              </>
            ) : (
              <>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('x')} name={`${rectPrefix}X`} value={rectValues.x} min={0} integer disabled={disabled || mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('y')} name={`${rectPrefix}Y`} value={rectValues.y} min={0} integer disabled={disabled || mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('width')} name={`${rectPrefix}Width`} value={rectValues.width} min={1} integer disabled={disabled || mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('height')} name={`${rectPrefix}Height`} value={rectValues.height} min={1} integer disabled={disabled || mode === 'ocr'} onCommit={onNumericCommit} /></Grid>
              </>
            )}
          </Grid>
        )}
      </AccordionDetails>
    </Accordion>
  );
};

const ImageProcessor: React.FC = () => {
  const { t, i18n } = useTranslation();

  const [settings, setSettings] = useState<ImageSettings>(() => loadSettingsFromStorage());

  useEffect(() => {
    saveSettingsToStorage(settings);
  }, [settings]);

  const [images, setImages] = useState<File[]>([]);
  const [fileListExpanded, setFileListExpanded] = useState(true);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState<string>('tile.webp');
  const [isProcessing, setIsProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState('');
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const ocrSessionRef = useRef<OcrSessionController<Tesseract.Worker> | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const isDefaultSettings = areSettingsDefault(settings);

  const handleResetSettings = () => {
    if (isProcessing) return;
    setSettings(createDefaultSettings());
    setResetDialogOpen(false);
  };

  useEffect(() => {
    // Abort and terminate any active or still-initializing OCR worker on unmount
    return () => {
      void releaseOcrResources(ocrAbortRef, ocrSessionRef, { abort: true });
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

  const orderedImages = useMemo(
    () => sortImageFiles(images, settings.sortOrder),
    [images, settings.sortOrder]
  );

  const activeLocale = i18n.resolvedLanguage || i18n.language || undefined;
  const formatFileTimestamp = useMemo(
    () => createFileTimestampFormatter(activeLocale),
    [activeLocale]
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (isProcessing) {
      event.target.value = '';
      return;
    }
    const files = event.target.files;
    if (files && files.length > 0) {
      setImages(Array.from(files));
      setProcessedImageUrl(null); // This will also trigger the cleanup effect for the old URL
    }
    // Reset input value so picking the exact same file(s) again still triggers onChange
    event.target.value = '';
  };

  const handleClearImages = () => {
    if (isProcessing) return;
    setImages([]);
    setProcessedImageUrl(null);
    setFileListExpanded(true);
  };

  const handleRemoveImage = (targetFile: File) => {
    if (isProcessing) return;
    if (images.length <= 1) {
      setFileListExpanded(true);
    }
    setImages((prev) => prev.filter((file) => file !== targetFile));
    setProcessedImageUrl(null);
  };

  const handleNumericSettingCommit = (name: string, newValue: number, options?: { finalize?: boolean }) => {
    if (isProcessing) return;
    if (name.startsWith('maskRatioRect.') || name.startsWith('selfMaskRatioRect.')) {
      const [parent, key] = name.split('.') as ['maskRatioRect' | 'selfMaskRatioRect', keyof RatioRect];
      setSettings(prev => ({
        ...prev,
        [parent]: commitRatioRectField(prev[parent], key, newValue, options),
      }));
      return;
    }

    setSettings(prev => ({
      ...prev,
      [name]: newValue,
    }));
  };

  const handleColorSettingCommit = (name: string, newValue: string) => {
    if (isProcessing) return;
    if (name !== 'bgColor' && name !== 'maskColor' && name !== 'selfMaskColor') return;
    const normalized = normalizeHexColor(newValue);
    if (!normalized) return;
    setSettings(prev => (prev[name] === normalized ? prev : { ...prev, [name]: normalized }));
  };

  const handleSettingChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number | string>) => {
    if (isProcessing) return;
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
    if (isProcessing) return;
    const numValue = value as number;
    setSettings(prev => {
        if (name === 'offsetX') { // If the offset slider is moved, update both X and Y
            return { ...prev, offsetX: numValue, offsetY: numValue };
        }
        return { ...prev, [name]: numValue };
    });
  };

  const handleRatioSliderChange = (parent: 'maskRatioRect' | 'selfMaskRatioRect', axis: 'horizontal' | 'vertical') => (_event: Event, value: number | number[]) => {
    if (isProcessing) return;
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
    if (isProcessing) return;
    const presetKey = event.target.value;
    const presets = parent === 'maskRatioRect' ? MASK_PRESETS : SELF_MASK_PRESETS;
    if (presetKey && presets[presetKey]) {
        setSettings(prev => ({
            ...prev,
            [parent]: { ...presets[presetKey] }
        }));
    }
  };

  const processImages = async () => {
    if (isProcessing) return;
    if (images.length === 0) {
      alert(t('alert_select_images_first'));
      return;
    }

    const validation = validateSettingsBeforeProcess(settings);
    if (!validation.valid) {
      alert(t(validation.alertKey));
      return;
    }

    setIsProcessing(true);
    setProcessedImageUrl(null);
    setOcrStatus('');

    // Add a short delay to allow the UI to update (e.g., show spinner) before blocking the main thread.
    await new Promise(resolve => setTimeout(resolve, 200));

    let firstImageBitmap: ImageBitmap | null = null;
    const releaseFirstImageBitmap = () => {
      if (firstImageBitmap) {
        firstImageBitmap.close();
        firstImageBitmap = null;
      }
    };
    try {
      // Always check first image dimensions (also runs auto-crop / OCR ROI when needed).
      firstImageBitmap = await decodeImageWithFallback<File, ImageBitmap>(orderedImages[0]);
      const expectedDimensions: ImageDimensions = {
        width: firstImageBitmap.width,
        height: firstImageBitmap.height,
      };
      const sourceBitmap = firstImageBitmap;

      const plan = await prepareMontagePlan({
        settings,
        imageSize: expectedDimensions,
        detectAutoCrop: () => detectAutoCropFromImage(sourceBitmap),
        detectOcrMasks: ({ cropRect, needsEnemyOcr, needsSelfOcr }) =>
          runOcrMaskDetection<Tesseract.Worker, HTMLCanvasElement, ImageBitmap>({
            sourceImage: sourceBitmap,
            cropRect,
            needsEnemyOcr,
            needsSelfOcr,
            abortHolder: ocrAbortRef,
            sessionHolder: ocrSessionRef,
            onSourceConsumed: releaseFirstImageBitmap,
            startSession: (signal) =>
              startOcrSession({
                createWorkerFn: (langs, oem, opts) => Tesseract.createWorker(langs, oem, opts),
                configureWorker: (w) => w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }),
                signal,
              }),
            onStatus: (status) => {
              if (status === 'starting') {
                setOcrStatus(t('ocr_status_starting'));
              }
            },
          }),
      });

      if (Object.keys(plan.settingsPatch).length > 0) {
        setSettings(prev => ({ ...prev, ...plan.settingsPatch }));
      }

      if (plan.status === 'abort') {
        switch (plan.alert.kind) {
          case 'auto_crop_context_error':
            alert(t('alert_failed_to_get_temp_canvas_context_for_auto_crop'));
            break;
          case 'auto_crop_not_found':
            alert(t('alert_failed_to_detect_crop_area'));
            break;
          case 'crop_outside_image':
            alert(
              t('alert_crop_outside_image', {
                width: plan.alert.width,
                height: plan.alert.height,
              })
            );
            break;
          case 'invalid_mask_area':
            alert(t('alert_invalid_mask_area'));
            break;
          case 'mask_outside_crop':
            alert(t('alert_mask_outside_crop'));
            break;
          case 'ocr_aborted':
            setOcrStatus('');
            break;
          case 'ocr_error':
            console.error(plan.alert.error);
            setOcrStatus('');
            alert(t('alert_ocr_error'));
            break;
          case 'ocr_not_found':
            setOcrStatus('');
            alert(
              [
                plan.alert.enemyMissing ? t('alert_could_not_find_right_lv') : '',
                plan.alert.selfMissing ? t('alert_could_not_find_left_lv') : '',
              ].filter(Boolean).join('\n')
            );
            break;
        }
        return;
      }

      const { cropRect, finalSettings, tileMasks } = plan;
      if (
        (finalSettings.maskEnabled && finalSettings.maskMode === 'ocr') ||
        (finalSettings.selfMaskEnabled && finalSettings.selfMaskMode === 'ocr')
      ) {
        setOcrStatus(t('ocr_status_mask_detected'));
      }

      const sizeEval = evaluateMontageCanvasSize(orderedImages.length, cropRect, finalSettings);
      if (sizeEval.status === 'invalid') {
        alert(t('alert_invalid_canvas_size', { width: sizeEval.width, height: sizeEval.height }));
        return;
      }
      if (sizeEval.status === 'confirm_required') {
        // Release before blocking on user confirmation or allocating an oversized montage.
        releaseFirstImageBitmap();
        const confirmMessage =
          sizeEval.reason === 'exceeds_webp_dimension'
            ? t('confirm_webp_canvas_size', {
                width: sizeEval.width.toLocaleString(),
                height: sizeEval.height.toLocaleString(),
                pixels: sizeEval.pixels.toLocaleString(),
                maxWebpDimension: MAX_WEBP_DIMENSION.toLocaleString(),
              })
            : t('confirm_large_canvas_size', {
                width: sizeEval.width.toLocaleString(),
                height: sizeEval.height.toLocaleString(),
                pixels: sizeEval.pixels.toLocaleString(),
              });
        if (!window.confirm(confirmMessage)) {
          return;
        }
      }

      let mimeType = 'image/webp';
      if (finalSettings.outputFormat === 'png') mimeType = 'image/png';
      else if (finalSettings.outputFormat === 'jpeg') mimeType = 'image/jpeg';

      const renderResult = await renderMontageToBlob<File, ImageBitmap>({
        dimensions: sizeEval,
        bgColor: finalSettings.bgColor,
        mimeType,
        quality: finalSettings.quality / 100,
        files: orderedImages,
        colCount: finalSettings.colCount,
        offsetX: finalSettings.offsetX,
        offsetY: finalSettings.offsetY,
        cropRect,
        masks: tileMasks,
        expectedDimensions,
        getFileName: (file) => file.name,
        decodeImage: (file, index) => {
          if (index === 0 && firstImageBitmap) {
            const reusedBitmap = firstImageBitmap;
            firstImageBitmap = null;
            return Promise.resolve(reusedBitmap);
          }
          return decodeImageWithFallback<File, ImageBitmap>(file);
        },
      });

      if (renderResult.status === 'context_failed') {
        throw new Error(t('alert_failed_to_get_context'));
      }
      if (renderResult.status === 'allocation_failed') {
        alert(t('alert_image_generation_failed'));
        return;
      }
      if (renderResult.status === 'encode_failed') {
        throw new Error(t('alert_image_generation_failed'));
      }

      const montageBlob = renderResult.blob;
      const getTimestamp = () => {
        const d = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      };
      const ext = resolveOutputExtension(montageBlob.type, finalSettings.outputFormat);
      setDownloadFilename(`tile-${getTimestamp()}.${ext}`);
      setProcessedImageUrl(URL.createObjectURL(montageBlob));

    } catch (error) {
      if (error instanceof ImageDecodeError) {
        console.error(`Failed to decode image "${error.fileName}":`, error);
        alert(t('alert_image_decode_failed', { fileName: error.fileName }));
        return;
      }
      if (error instanceof ImageResolutionMismatchError) {
        console.warn(
          `Image resolution mismatch for "${error.fileName}": expected ${error.expectedWidth}x${error.expectedHeight}, got ${error.actualWidth}x${error.actualHeight}`
        );
        alert(
          t('alert_image_resolution_mismatch', {
            fileName: error.fileName,
            actualWidth: error.actualWidth,
            actualHeight: error.actualHeight,
            expectedWidth: error.expectedWidth,
            expectedHeight: error.expectedHeight,
          })
        );
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("An unexpected error occurred during image processing:", error);
      alert(`${t('alert_processing_failed')}: ${errorMessage}`);

      // Best-effort cleanup before reloading
      void releaseOcrResources(ocrAbortRef, ocrSessionRef, { abort: true }).catch((cleanupError) => {
        console.warn('Failed to terminate OCR worker during cleanup:', cleanupError);
      });

      window.location.reload();
    } finally {
      releaseFirstImageBitmap();
      await releaseOcrResources(ocrAbortRef, ocrSessionRef);
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <LanguageButton />
          <ThemeModeButton />
        </Box>
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
                  <FormControl fullWidth size="small" disabled={isProcessing}>
                    <InputLabel id="col-count-label">{t('columns')}</InputLabel>
                    <Select labelId="col-count-label" name="colCount" value={settings.colCount} label={t('columns')} onChange={handleSettingChange}>
                      {Array.from({ length: MAX_COL_COUNT - MIN_COL_COUNT + 1 }, (_, i) => {
                        const val = MIN_COL_COUNT + i;
                        return <MenuItem key={val} value={val}>{val}</MenuItem>;
                      })}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small" disabled={isProcessing}>
                    <InputLabel id="offset-label">{t('offset_px')}</InputLabel>
                    <Select labelId="offset-label" name="offsetX" value={settings.offsetX} label={t('offset_px')} onChange={handleSettingChange}>
                      {Array.from({ length: MAX_OFFSET_PX - MIN_OFFSET_PX + 1 }, (_, i) => {
                        const val = MIN_OFFSET_PX + i;
                        return <MenuItem key={val} value={val}>{val}</MenuItem>;
                      })}
                    </Select>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <FormControl fullWidth size="small" disabled={isProcessing}>
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
                <Grid size={{ xs: 6 }}><ColorSettingField label={t('background_color')} name="bgColor" value={settings.bgColor} disabled={isProcessing} onCommit={handleColorSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small" disabled={isProcessing}>
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
                    color={isProcessing || settings.outputFormat === 'png' ? 'text.disabled' : 'text.secondary'}
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
                      disabled={isProcessing || settings.outputFormat === 'png'}
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
              <FormControlLabel
                disabled={isProcessing}
                control={<Switch checked={settings.cropAuto} disabled={isProcessing} onChange={handleSettingChange} name="cropAuto" />}
                label={t('auto_mode')}
              />
              <Grid container spacing={2} sx={{ mt: 1 }}>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('x')} name="cropX" value={settings.cropX} min={0} integer disabled={isProcessing || settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('y')} name="cropY" value={settings.cropY} min={0} integer disabled={isProcessing || settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('width')} name="cropWidth" value={settings.cropWidth} min={1} integer disabled={isProcessing || settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('height')} name="cropHeight" value={settings.cropHeight} min={1} integer disabled={isProcessing || settings.cropAuto} onCommit={handleNumericSettingCommit} /></Grid>
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
            disabled={isProcessing}
            onSettingChange={handleSettingChange}
            onNumericCommit={handleNumericSettingCommit}
            onColorCommit={handleColorSettingCommit}
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
            disabled={isProcessing}
            onSettingChange={handleSettingChange}
            onNumericCommit={handleNumericSettingCommit}
            onColorCommit={handleColorSettingCommit}
            onRatioSliderChange={(axis) => handleRatioSliderChange('selfMaskRatioRect', axis)}
            onPresetChange={handlePresetChange('selfMaskRatioRect')}
          />
          <Box sx={{ mt: 2 }}>
            <Button
              variant="outlined"
              color="inherit"
              fullWidth
              startIcon={<RestartAltIcon />}
              disabled={isProcessing || isDefaultSettings}
              onClick={() => setResetDialogOpen(true)}
              sx={{ '&:not(.Mui-disabled)': { color: 'text.secondary', borderColor: 'divider' } }}
            >
              {t('reset_settings')}
            </Button>
          </Box>
        </Grid>
        <Grid size={{ xs: 12, md: 7, lg: 8 }}>
          <Card>
            <CardContent>
              <Typography variant="h5" component="h2" sx={{ mb: 0.75 }}>{t('upload_and_process')}</Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 0.75,
                  mb: 2,
                  color: 'text.secondary',
                }}
              >
                <LockOutlinedIcon sx={{ fontSize: 15, mt: '2px', flexShrink: 0 }} aria-hidden="true" />
                <Typography variant="caption" color="text.secondary">
                  {t('local_processing_notice')}
                </Typography>
              </Box>
              <Button
                variant="contained"
                component="label"
                fullWidth
                size="large"
                startIcon={<AddPhotoIcon />}
                disabled={isProcessing}
              >
                {t('upload_images')}
                <input
                  type="file"
                  hidden
                  accept="image/png, image/jpeg"
                  multiple
                  disabled={isProcessing}
                  onChange={handleFileChange}
                />
              </Button>
              {images.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => setFileListExpanded((prev) => !prev)}
                      endIcon={fileListExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      aria-expanded={fileListExpanded}
                      sx={{
                        color: 'text.secondary',
                        textTransform: 'none',
                        px: 1,
                        py: 0.25,
                        minWidth: 0,
                        fontWeight: 500,
                      }}
                    >
                      {t('files_selected', { count: images.length })}
                    </Button>
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<DeleteOutlineIcon fontSize="small" />}
                      onClick={handleClearImages}
                      disabled={isProcessing}
                      sx={{
                        color: 'text.secondary',
                        textTransform: 'none',
                        px: 1,
                        py: 0.25,
                        minWidth: 0,
                        '&:hover': { color: 'error.main' },
                      }}
                    >
                      {t('clear')}
                    </Button>
                  </Box>
                  <Collapse in={fileListExpanded}>
                    <Box
                      component="ol"
                      sx={{
                        mt: 0.75,
                        mb: 0,
                        p: 0,
                        listStyle: 'none',
                        maxHeight: 200,
                        overflowY: 'auto',
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 1,
                        bgcolor: 'background.default',
                      }}
                    >
                      {orderedImages.map((file, index) => (
                        <Box
                          component="li"
                          key={`${file.name}-${file.lastModified}-${file.size}-${index}`}
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 1.25,
                            py: 0.5,
                            borderBottom: index < orderedImages.length - 1 ? 1 : 0,
                            borderColor: 'divider',
                          }}
                        >
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              minWidth: '2.5ch',
                              textAlign: 'right',
                              flexShrink: 0,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {index + 1}.
                          </Typography>
                          <Typography
                            variant="body2"
                            noWrap
                            title={file.name}
                            sx={{ flex: 1, minWidth: 0 }}
                          >
                            {file.name}
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              flexShrink: 0,
                              whiteSpace: 'nowrap',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {formatFileTimestamp(file.lastModified)}
                          </Typography>
                          <IconButton
                            size="small"
                            aria-label={t('remove_file', { name: file.name })}
                            onClick={() => handleRemoveImage(file)}
                            disabled={isProcessing}
                            sx={{
                              p: 0.25,
                              flexShrink: 0,
                              color: 'text.secondary',
                              '&:hover': { color: 'error.main' },
                            }}
                          >
                            <CloseIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Box>
                      ))}
                    </Box>
                  </Collapse>
                </Box>
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
      <Dialog
        open={resetDialogOpen}
        onClose={() => setResetDialogOpen(false)}
        aria-labelledby="reset-settings-dialog-title"
        aria-describedby="reset-settings-dialog-description"
      >
        <DialogTitle id="reset-settings-dialog-title">{t('reset_settings_confirm_title')}</DialogTitle>
        <DialogContent>
          <DialogContentText id="reset-settings-dialog-description">
            {t('reset_settings_confirm_message')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetDialogOpen(false)}>{t('cancel')}</Button>
          <Button onClick={handleResetSettings} color="error" variant="contained" disabled={isProcessing}>
            {t('reset')}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default ImageProcessor;
