import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, ButtonBase, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, LinearProgress, Box, Slider, Switch, FormControlLabel, FormHelperText, Select, MenuItem, InputLabel, FormControl, Accordion, AccordionSummary, AccordionDetails, IconButton, Menu, ListItemIcon, ListItemText, Tooltip, InputAdornment, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Collapse, useMediaQuery } from '@mui/material';
import { useColorScheme, useTheme, styled, alpha } from '@mui/material/styles';
import { PlayArrow, ExpandMore as ExpandMoreIcon, ExpandLess as ExpandLessIcon, GetApp as DownloadIcon, Share as ShareIcon, AddPhotoAlternate as AddPhotoIcon, LightMode as LightModeIcon, DarkMode as DarkModeIcon, SettingsBrightness as SystemModeIcon, Language as LanguageIcon, RestartAlt as RestartAltIcon, Check as CheckIcon, Close as CloseIcon, DeleteOutline as DeleteOutlineIcon, LockOutlined as LockOutlinedIcon, ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from '@mui/icons-material';
import type { SelectChangeEvent } from '@mui/material';
import Tesseract, { PSM } from 'tesseract.js';
import packageJson from '../package.json';
import { LANGUAGE_STORAGE_KEY } from './i18n';
import {
  type OcrSessionController,
  isAbortError,
  releaseOcrResources,
  runOcrMaskDetection,
  startOcrSession,
} from './ocrHelpers.ts';
import {
  type ImageSettings,
  type MaskMode,
  type RatioRect,
  type SettingFieldKey,
  type SettingsAccordionId,
  type SortOrder,
  MASK_PRESETS,
  MAX_COL_COUNT,
  MAX_OFFSET_PX,
  MAX_WEBP_DIMENSION,
  MIN_COL_COUNT,
  MIN_OFFSET_PX,
  SELF_MASK_PRESETS,
  areSettingsDefault,
  cloneSettings,
  commitRatioRectField,
  createDefaultSettings,
  evaluateMontageCanvasSize,
  formatRatioPercent,
  getResultStaleReason,
  isRatioRectEqual,
  loadSettingsFromStorage,
  normalizeHexColor,
  resolveCanvasSizeErrorUiTarget,
  saveSettingsToStorage,
  validateSettingsBeforeProcess,
} from './settingsHelpers.ts';
import { detectAutoCropFromImage } from './cropHelpers.ts';
import {
  ImageDecodeError,
  ImageResolutionMismatchError,
  canShareImageFile,
  decodeImageWithFallback,
  formatFileSize,
  formatOutputFormatLabel,
  getMemoryReleaseDelayMs,
  guardWindowFileDragEvent,
  hasExternalFilesDataTransfer,
  mergeInputImageFiles,
  prepareMontagePlan,
  renderMontageToBlob,
  resolveActionButtonVariants,
  resolveAdjacentPreviewFile,
  resolveMontageAbortUiTarget,
  resolveNextPreviewAfterRemoval,
  resolveOutputExtension,
  shouldScrollToResult,
  splitFilenameForMiddleEllipsis,
  type ImageDimensions,
} from './montageHelpers.ts';

const fileKeyMap = new WeakMap<File, number>();
let nextFileKeyId = 1;
const getFileKey = (file: File): number => {
  let id = fileKeyMap.get(file);
  if (id === undefined) {
    id = nextFileKeyId++;
    fileKeyMap.set(file, id);
  }
  return id;
};

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
  error?: boolean;
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
  error = false,
  onCommit,
}) => {
  const { t } = useTranslation();
  const normalizedValue = normalizeHexColor(value) ?? '#000000';
  const colorPickerLabel = t('color_picker_aria', { label });
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
      error={error}
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
                value={normalizedValue}
                disabled={disabled}
                onChange={handleSwatchChange}
                aria-label={colorPickerLabel}
                title={colorPickerLabel}
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
  error?: boolean;
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
  error = false,
  onCommit,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const isFocusedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const preEditValueRef = useRef(value);
  const [commitVersion, setCommitVersion] = useState(0);
  const syncedCommitVersionRef = useRef(0);

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
    // Resync DOM value and pre-edit baseline after commits even if parent swap/clamp keeps `value` unchanged.
    if ((!isFocusedRef.current || !isDirtyRef.current) && inputRef.current) {
      syncedCommitVersionRef.current = commitVersion;
      inputRef.current.value = String(value);
      preEditValueRef.current = value;
    }
  }, [value, disabled, commitVersion]);

  const handleFocus = () => {
    isFocusedRef.current = true;
    isDirtyRef.current = false;
    preEditValueRef.current = value;
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    if (raw === '') {
      isDirtyRef.current = true;
      return;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      isDirtyRef.current = true;
      return;
    }

    if (!isFocusedRef.current) {
      isDirtyRef.current = false;
      onCommit(name, normalize(parsed), { finalize: true });
      setCommitVersion((prev) => prev + 1);
      return;
    }

    isDirtyRef.current = true;
    const withinBounds =
      (min === undefined || parsed >= min) &&
      (max === undefined || parsed <= max);
    if (withinBounds) {
      onCommit(name, normalize(parsed), { finalize: false });
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
    setCommitVersion((prev) => prev + 1);
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
      error={error}
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
  description: string;
  expanded: boolean;
  onAccordionChange: (event: React.SyntheticEvent, isExpanded: boolean) => void;
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
  errorFields?: ReadonlySet<SettingFieldKey>;
  onSettingChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent<number | string>) => void;
  onNumericCommit: (name: string, value: number, options?: { finalize?: boolean }) => void;
  onColorCommit: (name: string, value: string) => void;
  onRatioSliderChange: (axis: 'horizontal' | 'vertical') => (event: Event, value: number | number[]) => void;
  onPresetChange: (event: SelectChangeEvent<string>) => void;
}

/** Shared settings accordion for target and self masking controls with compact 2-column pairing. */
const MaskAccordion: React.FC<MaskAccordionProps> = ({
  title,
  description,
  expanded,
  onAccordionChange,
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
  errorFields,
  onSettingChange,
  onNumericCommit,
  onColorCommit,
  onRatioSliderChange,
  onPresetChange,
}) => {
  const { t } = useTranslation();
  const hasError = (field: SettingFieldKey): boolean => Boolean(errorFields?.has(field));
  const ratioAxes: ReadonlyArray<{
    axis: 'horizontal' | 'vertical';
    labelId: string;
    label: string;
    range: [number, number];
    mt: number;
  }> = [
    {
      axis: 'horizontal',
      labelId: `${ratioKey}-horizontal-label`,
      label: t('range_horizontal'),
      range: [Math.min(ratioRect.rx0, ratioRect.rx1), Math.max(ratioRect.rx0, ratioRect.rx1)],
      mt: 0,
    },
    {
      axis: 'vertical',
      labelId: `${ratioKey}-vertical-label`,
      label: t('range_vertical'),
      range: [Math.min(ratioRect.ry0, ratioRect.ry1), Math.max(ratioRect.ry0, ratioRect.ry1)],
      mt: 1,
    },
  ];

  return (
    <Accordion expanded={expanded} onChange={onAccordionChange} sx={{ mt: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', pr: 2, alignItems: 'center' }}>
          <Typography variant="h6">{title}</Typography>
          <Typography variant="caption" color={enabled ? 'primary' : 'text.secondary'}>
            {enabled ? t(`mode_${mode}`) : 'OFF'}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {description}
        </Typography>
        <FormControlLabel
          disabled={disabled}
          control={<Switch checked={enabled} disabled={disabled} onChange={onSettingChange} name={enabledName} />}
          label={t('enable')}
        />
        {enabled && (
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 6 }}>
              <FormControl fullWidth size="small" disabled={disabled} error={hasError(modeName)}>
                <InputLabel id={`${modeName}-label`}>{t('mode')}</InputLabel>
                <Select labelId={`${modeName}-label`} name={modeName} value={mode} label={t('mode')} onChange={onSettingChange}>
                  <MenuItem value="manual">{t('mode_manual')}</MenuItem>
                  <MenuItem value="ratio">{t('mode_ratio')}</MenuItem>
                  <MenuItem value="ocr">{t('mode_ocr')}</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 6 }}>
              <ColorSettingField label={t('color')} name={colorName} value={colorValue} disabled={disabled} error={hasError(colorName)} onCommit={onColorCommit} />
            </Grid>
            <Grid size={{ xs: 12 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {t(`mask_mode_${mode}_help`)}
              </Typography>
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
                  {ratioAxes.map(({ axis, labelId, label, range, mt }) => (
                    <React.Fragment key={axis}>
                      <Typography
                        id={labelId}
                        variant="body2"
                        color={disabled ? 'text.disabled' : 'text.secondary'}
                        gutterBottom
                        sx={{ mt, fontVariantNumeric: 'tabular-nums' }}
                      >
                        {label}: {formatRatioPercent(range[0])} – {formatRatioPercent(range[1])}
                      </Typography>
                      <Box sx={{ px: 1 }}>
                        <Slider
                          size="small"
                          disabled={disabled}
                          value={range}
                          onChange={onRatioSliderChange(axis)}
                          aria-labelledby={labelId}
                          valueLabelDisplay="auto"
                          valueLabelFormat={formatRatioPercent}
                          getAriaValueText={formatRatioPercent}
                          min={0}
                          max={1}
                          step={0.001}
                        />
                      </Box>
                    </React.Fragment>
                  ))}
                </Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_left')} name={`${ratioKey}.rx0`} value={ratioRect.rx0} min={0} max={1} step={0.001} disabled={disabled} error={hasError(`${ratioKey}.rx0`)} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_top')} name={`${ratioKey}.ry0`} value={ratioRect.ry0} min={0} max={1} step={0.001} disabled={disabled} error={hasError(`${ratioKey}.ry0`)} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_right')} name={`${ratioKey}.rx1`} value={ratioRect.rx1} min={0} max={1} step={0.001} disabled={disabled} error={hasError(`${ratioKey}.rx1`)} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_bottom')} name={`${ratioKey}.ry1`} value={ratioRect.ry1} min={0} max={1} step={0.001} disabled={disabled} error={hasError(`${ratioKey}.ry1`)} onCommit={onNumericCommit} /></Grid>
              </>
            ) : (
              <>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('x')} name={`${rectPrefix}X`} value={rectValues.x} min={0} integer disabled={disabled || mode === 'ocr'} error={hasError(`${rectPrefix}X`)} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('y')} name={`${rectPrefix}Y`} value={rectValues.y} min={0} integer disabled={disabled || mode === 'ocr'} error={hasError(`${rectPrefix}Y`)} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('width')} name={`${rectPrefix}Width`} value={rectValues.width} min={1} integer disabled={disabled || mode === 'ocr'} error={hasError(`${rectPrefix}Width`)} onCommit={onNumericCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('height')} name={`${rectPrefix}Height`} value={rectValues.height} min={1} integer disabled={disabled || mode === 'ocr'} error={hasError(`${rectPrefix}Height`)} onCommit={onNumericCommit} /></Grid>
              </>
            )}
          </Grid>
        )}
      </AccordionDetails>
    </Accordion>
  );
};

type ProcessingProgressState =
  | { phase: 'preparing' }
  | { phase: 'ocr' }
  | { phase: 'confirming' }
  | { phase: 'drawing'; current: number; total: number }
  | { phase: 'encoding' }
  | { phase: 'releasing' };

interface ProcessedMontageResult {
  blob: Blob;
  url: string;
  filename: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  formatLabel: string;
  settingsSnapshot: ImageSettings;
  imagesSnapshot: File[];
}

const waitWithAbort = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timerId);
      resolve();
    };
    const timerId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

interface RenderedPreviewState {
  file: File;
  url: string;
  dimensions: ImageDimensions | null;
  error: boolean;
}

const preloadPreviewImage = (url: string): Promise<ImageDimensions> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'sync';
    img.onload = async () => {
      try {
        if (typeof img.decode === 'function') {
          await img.decode();
        }
      } catch {
        // Ignore decode() errors when onload already produced valid dimensions
      }
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        reject(new Error('Invalid preview image dimensions'));
      }
    };
    img.onerror = () => {
      reject(new Error('Failed to load preview image'));
    };
    img.src = url;
  });

const ImageProcessor: React.FC = () => {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const isCompactViewport = useMediaQuery(theme.breakpoints.down('md'));
  const isCompactViewportRef = useRef(isCompactViewport);

  const [settings, setSettings] = useState<ImageSettings>(() => loadSettingsFromStorage());

  useEffect(() => {
    saveSettingsToStorage(settings);
  }, [settings]);

  const [images, setImages] = useState<File[]>([]);
  const [fileListExpanded, setFileListExpanded] = useState(true);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [fileSelectionNotice, setFileSelectionNotice] = useState<{
    severity: 'info' | 'warning';
    message: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [requestedPreviewFile, setRequestedPreviewFile] = useState<File | null>(null);
  const [renderedPreview, setRenderedPreview] = useState<RenderedPreviewState | null>(null);
  const [processedResult, setProcessedResult] = useState<ProcessedMontageResult | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgressState | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [expandedAccordions, setExpandedAccordions] = useState<Record<SettingsAccordionId, boolean>>({
    settings: false,
    crop: false,
    mask: false,
    selfMask: false,
  });
  const [processError, setProcessError] = useState<{
    message: string;
    fields: ReadonlySet<SettingFieldKey>;
  } | null>(null);
  const [largeCanvasConfirm, setLargeCanvasConfirm] = useState<{ open: boolean; message: string }>({
    open: false,
    message: '',
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ocrSessionRef = useRef<OcrSessionController<Tesseract.Worker> | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  const processAbortRef = useRef<AbortController | null>(null);
  const fileDragDepthRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const requestedPreviewFileRef = useRef<File | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const processAlertRef = useRef<HTMLDivElement>(null);
  const largeCanvasConfirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const isMountedRef = useRef(true);

  const isDefaultSettings = areSettingsDefault(settings);
  const isReleasingMemory = processingProgress?.phase === 'releasing';

  const canCancelProcessing = isProcessing && !isReleasingMemory;

  const handleCancelProcessing = () => {
    if (!canCancelProcessing || isCancelling || !processAbortRef.current) return;
    setIsCancelling(true);
    processAbortRef.current.abort();
    ocrAbortRef.current?.abort();
    resolveLargeCanvasConfirm(false);
  };

  const hasFieldError = (field: SettingFieldKey): boolean =>
    Boolean(processError?.fields.has(field));

  const handleAccordionChange =
    (id: SettingsAccordionId) => (_event: React.SyntheticEvent, isExpanded: boolean) => {
      setExpandedAccordions((prev) => ({ ...prev, [id]: isExpanded }));
    };

  const expandAccordions = (ids: readonly SettingsAccordionId[]) => {
    if (ids.length === 0) return;
    setExpandedAccordions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        if (!next[id]) {
          next[id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  };

  const reportProcessError = (
    message: string,
    target: { accordions?: readonly SettingsAccordionId[]; fields?: readonly SettingFieldKey[] } = {}
  ) => {
    if (!isMountedRef.current) return;
    expandAccordions(target.accordions ?? []);
    setProcessError({
      message,
      fields: new Set(target.fields ?? []),
    });
  };

  const resolveLargeCanvasConfirm = (confirmed: boolean) => {
    const resolve = largeCanvasConfirmResolverRef.current;
    largeCanvasConfirmResolverRef.current = null;
    if (isMountedRef.current) {
      setLargeCanvasConfirm({ open: false, message: '' });
    }
    resolve?.(confirmed);
  };

  const requestLargeCanvasConfirm = (message: string): Promise<boolean> => {
    if (largeCanvasConfirmResolverRef.current) {
      largeCanvasConfirmResolverRef.current(false);
      largeCanvasConfirmResolverRef.current = null;
    }
    return new Promise<boolean>((resolve) => {
      largeCanvasConfirmResolverRef.current = resolve;
      setLargeCanvasConfirm({ open: true, message });
    });
  };

  const handleResetSettings = () => {
    if (isProcessing) return;
    setSettings(createDefaultSettings());
    setResetDialogOpen(false);
    setProcessError(null);
  };

  useEffect(() => {
    isMountedRef.current = true;
    // Abort active processing and terminate any active or still-initializing OCR worker on unmount
    return () => {
      isMountedRef.current = false;
      previewRequestIdRef.current += 1;
      processAbortRef.current?.abort();
      if (largeCanvasConfirmResolverRef.current) {
        const resolve = largeCanvasConfirmResolverRef.current;
        largeCanvasConfirmResolverRef.current = null;
        resolve(false);
      }
      void releaseOcrResources(ocrAbortRef, ocrSessionRef, { abort: true });
    };
  }, []);

  useEffect(() => {
    isCompactViewportRef.current = isCompactViewport;
  }, [isCompactViewport]);

  useEffect(() => {
    const handleWindowDragOver = (event: DragEvent) => {
      guardWindowFileDragEvent(event, 'dragover');
    };
    const handleWindowDrop = (event: DragEvent) => {
      if (guardWindowFileDragEvent(event, 'drop')) {
        fileDragDepthRef.current = 0;
        setIsFileDragOver(false);
      }
    };
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, []);

  useEffect(() => {
    if (processError) {
      processAlertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [processError]);

  useEffect(() => {
    if (!processedResult || !resultRef.current || !isCompactViewportRef.current) {
      return;
    }
    const rect = resultRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (
      shouldScrollToResult({
        isCompactViewport: true,
        resultTop: rect.top,
        viewportHeight,
      })
    ) {
      resultRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [processedResult]);

  useEffect(() => {
    // This effect manages the lifecycle of the generated object URL.
    // It runs when the component unmounts or before the effect runs again
    // (i.e., when processedResult changes).
    const url = processedResult?.url;
    return () => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [processedResult]);

  useEffect(() => {
    const url = renderedPreview?.url;
    return () => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [renderedPreview]);

  const orderedImages = useMemo(
    () => sortImageFiles(images, settings.sortOrder),
    [images, settings.sortOrder]
  );

  const activeLocale = i18n.resolvedLanguage || i18n.language || undefined;
  const formatFileTimestamp = useMemo(
    () => createFileTimestampFormatter(activeLocale),
    [activeLocale]
  );

  const addImageFiles = (incoming: File[]) => {
    if (isProcessing || incoming.length === 0) return;
    const merged = mergeInputImageFiles(images, incoming);
    if (merged.addedCount === 0 && merged.duplicateCount === 0) {
      setFileSelectionNotice(null);
      reportProcessError(t('alert_no_supported_images'));
      return;
    }
    if (merged.addedCount > 0) {
      setImages(merged.files);
      setProcessError(null);
    }
    if (merged.unsupportedCount > 0 && merged.duplicateCount > 0) {
      setFileSelectionNotice({
        severity: 'warning',
        message: t('notice_skipped_both', {
          unsupportedCount: merged.unsupportedCount,
          duplicateCount: merged.duplicateCount,
        }),
      });
    } else if (merged.unsupportedCount > 0) {
      setFileSelectionNotice({
        severity: 'warning',
        message: t('notice_skipped_unsupported', { count: merged.unsupportedCount }),
      });
    } else if (merged.duplicateCount > 0) {
      setFileSelectionNotice({
        severity: 'info',
        message: t('notice_skipped_duplicate', { count: merged.duplicateCount }),
      });
    } else {
      setFileSelectionNotice(null);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (isProcessing) {
      event.target.value = '';
      return;
    }
    const files = event.target.files;
    if (files && files.length > 0) {
      addImageFiles(Array.from(files));
    }
    // Reset input value so picking the exact same file(s) again still triggers onChange
    event.target.value = '';
  };

  const handleClearImages = () => {
    if (isProcessing) return;
    previewRequestIdRef.current += 1;
    requestedPreviewFileRef.current = null;
    setImages([]);
    setProcessedResult(null);
    setShareError(null);
    setFileSelectionNotice(null);
    setProcessError(null);
    setFileListExpanded(true);
    setPreviewOpen(false);
    setRequestedPreviewFile(null);
    setRenderedPreview(null);
  };

  const removeImageFile = (targetFile: File) => {
    const nextImages = images.filter((file) => file !== targetFile);
    if (nextImages.length === 0) {
      setFileListExpanded(true);
      setProcessedResult(null);
      setShareError(null);
    }
    setImages(nextImages);
    setFileSelectionNotice(null);
    setProcessError(null);
  };

  const handleRemoveImage = (targetFile: File) => {
    if (isProcessing) return;
    if (
      renderedPreview?.file === targetFile ||
      requestedPreviewFileRef.current === targetFile
    ) {
      previewRequestIdRef.current += 1;
      setPreviewOpen(false);
    }
    removeImageFile(targetFile);
  };

  const startPreviewLoad = (file: File) => {
    const requestId = ++previewRequestIdRef.current;
    requestedPreviewFileRef.current = file;
    setRequestedPreviewFile(file);
    const objectUrl = URL.createObjectURL(file);

    void preloadPreviewImage(objectUrl).then(
      (dimensions) => {
        if (!isMountedRef.current || previewRequestIdRef.current !== requestId) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setRenderedPreview({
          file,
          url: objectUrl,
          dimensions,
          error: false,
        });
      },
      () => {
        URL.revokeObjectURL(objectUrl);
        if (!isMountedRef.current || previewRequestIdRef.current !== requestId) {
          return;
        }
        setRenderedPreview({
          file,
          url: '',
          dimensions: null,
          error: true,
        });
      }
    );
  };

  const handleOpenPreview = (file: File) => {
    setPreviewOpen(true);
    startPreviewLoad(file);
  };

  const handleStepPreview = (step: -1 | 1) => {
    const baseFile = requestedPreviewFileRef.current ?? renderedPreview?.file ?? null;
    if (!baseFile) return;
    const nextFile = resolveAdjacentPreviewFile(orderedImages, baseFile, step);
    if (nextFile) {
      startPreviewLoad(nextFile);
    }
  };

  const handlePreviewKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      handleStepPreview(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      handleStepPreview(1);
    }
  };

  const handleClosePreview = () => {
    previewRequestIdRef.current += 1;
    setPreviewOpen(false);
  };

  const handlePreviewExited = () => {
    previewRequestIdRef.current += 1;
    requestedPreviewFileRef.current = null;
    setRequestedPreviewFile(null);
    setRenderedPreview(null);
  };

  const handleRemovePreviewImage = () => {
    const targetFile = renderedPreview?.file ?? requestedPreviewFileRef.current;
    if (isProcessing || !targetFile) return;
    const nextFile = resolveNextPreviewAfterRemoval(orderedImages, targetFile);
    removeImageFile(targetFile);
    if (nextFile) {
      startPreviewLoad(nextFile);
    } else {
      previewRequestIdRef.current += 1;
      requestedPreviewFileRef.current = null;
      setRequestedPreviewFile(null);
      setPreviewOpen(false);
    }
  };

  const handleCardDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    if (isProcessing) return;
    fileDragDepthRef.current += 1;
    setIsFileDragOver(true);
  };

  const handleCardDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = isProcessing ? 'none' : 'copy';
  };

  const handleCardDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesDataTransfer(event.dataTransfer)) return;
    if (
      event.relatedTarget !== null &&
      !event.currentTarget.contains(event.relatedTarget as Node)
    ) {
      fileDragDepthRef.current = 0;
      setIsFileDragOver(false);
      return;
    }
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDragOver(false);
    }
  };

  const handleCardDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasExternalFilesDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setIsFileDragOver(false);
    if (isProcessing) return;
    addImageFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const handleNumericSettingCommit = (name: string, newValue: number, options?: { finalize?: boolean }) => {
    if (isProcessing) return;
    if (name.startsWith('maskRatioRect.') || name.startsWith('selfMaskRatioRect.')) {
      const [parent, key] = name.split('.') as ['maskRatioRect' | 'selfMaskRatioRect', keyof RatioRect];
      const currentRect = settings[parent];
      const nextRect = commitRatioRectField(currentRect, key, newValue, options);
      if (
        currentRect.rx0 === nextRect.rx0 &&
        currentRect.ry0 === nextRect.ry0 &&
        currentRect.rx1 === nextRect.rx1 &&
        currentRect.ry1 === nextRect.ry1
      ) {
        return;
      }
      setSettings(prev => ({
        ...prev,
        [parent]: commitRatioRectField(prev[parent], key, newValue, options),
      }));
      setProcessError(null);
      return;
    }

    if (settings[name as keyof ImageSettings] === newValue) {
      return;
    }

    setSettings(prev => ({
      ...prev,
      [name]: newValue,
    }));
    setProcessError(null);
  };

  const handleColorSettingCommit = (name: string, newValue: string) => {
    if (isProcessing) return;
    if (name !== 'bgColor' && name !== 'maskColor' && name !== 'selfMaskColor') return;
    const normalized = normalizeHexColor(newValue);
    if (!normalized || settings[name] === normalized) return;
    setSettings(prev => (prev[name] === normalized ? prev : { ...prev, [name]: normalized }));
    setProcessError(null);
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
        if (settings.offsetX === newValue && settings.offsetY === newValue) {
            return;
        }
        setSettings(prev => ({
            ...prev,
            offsetX: newValue as number,
            offsetY: newValue as number,
        }));
        setProcessError(null);
        return;
    }

    if (settings[name as keyof ImageSettings] === newValue) {
        return;
    }

    setSettings(prev => ({
      ...prev,
      [name]: newValue,
    }));
    setProcessError(null);
  };

  const handleSliderChange = (name: string) => (_event: Event, value: number | number[]) => {
    if (isProcessing) return;
    const numValue = value as number;
    if (name === 'offsetX') {
        if (settings.offsetX === numValue && settings.offsetY === numValue) return;
    } else if (settings[name as keyof ImageSettings] === numValue) {
        return;
    }
    setSettings(prev => {
        if (name === 'offsetX') { // If the offset slider is moved, update both X and Y
            return { ...prev, offsetX: numValue, offsetY: numValue };
        }
        return { ...prev, [name]: numValue };
    });
    setProcessError(null);
  };

  const handleRatioSliderChange = (parent: 'maskRatioRect' | 'selfMaskRatioRect', axis: 'horizontal' | 'vertical') => (_event: Event, value: number | number[]) => {
    if (isProcessing) return;
    if (!Array.isArray(value)) return;
    const [start, end] = value;
    const current = settings[parent];
    const changed = axis === 'horizontal'
      ? current.rx0 !== start || current.rx1 !== end
      : current.ry0 !== start || current.ry1 !== end;
    if (!changed) return;
    setSettings(prev => ({
        ...prev,
        [parent]: {
            ...(prev[parent] as RatioRect),
            ...(axis === 'horizontal' ? { rx0: start, rx1: end } : { ry0: start, ry1: end })
        }
    }));
    setProcessError(null);
  };

  const handlePresetChange = (parent: 'maskRatioRect' | 'selfMaskRatioRect') => (event: SelectChangeEvent<string>) => {
    if (isProcessing) return;
    const presetKey = event.target.value;
    const presets = parent === 'maskRatioRect' ? MASK_PRESETS : SELF_MASK_PRESETS;
    if (presetKey && presets[presetKey]) {
        if (isRatioRectEqual(settings[parent], presets[presetKey])) return;
        setSettings(prev => ({
            ...prev,
            [parent]: { ...presets[presetKey] }
        }));
        setProcessError(null);
    }
  };

  const processImages = async () => {
    if (isProcessing) return;
    if (images.length === 0) {
      reportProcessError(t('alert_select_images_first'));
      return;
    }

    const validation = validateSettingsBeforeProcess(settings);
    if (!validation.valid) {
      reportProcessError(t(validation.alertKey), {
        accordions: [validation.accordion],
        fields: validation.fields,
      });
      return;
    }

    const abortController = new AbortController();
    processAbortRef.current = abortController;
    const { signal } = abortController;
    const forwardAbortToOcr = () => {
      ocrAbortRef.current?.abort();
    };
    signal.addEventListener('abort', forwardAbortToOcr, { once: true });

    setIsProcessing(true);
    setIsCancelling(false);
    fileDragDepthRef.current = 0;
    setIsFileDragOver(false);
    setProcessError(null);
    setProcessedResult(null);
    setShareError(null);
    setFileSelectionNotice(null);
    setProcessingProgress({ phase: 'preparing' });

    // Add a short delay to allow the UI to update (e.g., show progress) before blocking the main thread.
    await waitWithAbort(200, signal);

    let firstImageBitmap: ImageBitmap | null = null;
    let ocrSessionStarted = false;
    let montageCanvasUsed = false;
    let reloadTriggered = false;
    const releaseFirstImageBitmap = () => {
      if (firstImageBitmap) {
        firstImageBitmap.close();
        firstImageBitmap = null;
      }
    };
    try {
      if (signal.aborted) {
        return;
      }
      // Always check first image dimensions (also runs auto-crop / OCR ROI when needed).
      firstImageBitmap = await decodeImageWithFallback<File, ImageBitmap>(orderedImages[0]);
      if (signal.aborted) {
        return;
      }
      const expectedDimensions: ImageDimensions = {
        width: firstImageBitmap.width,
        height: firstImageBitmap.height,
      };
      const sourceBitmap = firstImageBitmap;

      const plan = await prepareMontagePlan({
        settings,
        imageSize: expectedDimensions,
        detectAutoCrop: () => detectAutoCropFromImage(sourceBitmap),
        detectOcrMasks: ({ cropRect, needsEnemyOcr, needsSelfOcr }) => {
          if (signal.aborted) {
            return Promise.resolve({ status: 'aborted' });
          }
          return runOcrMaskDetection<Tesseract.Worker, HTMLCanvasElement, ImageBitmap>({
            sourceImage: sourceBitmap,
            cropRect,
            needsEnemyOcr,
            needsSelfOcr,
            abortHolder: ocrAbortRef,
            sessionHolder: ocrSessionRef,
            onSourceConsumed: releaseFirstImageBitmap,
            startSession: (ocrSignal) => {
              ocrSessionStarted = true;
              return startOcrSession({
                createWorkerFn: (langs, oem, opts) => Tesseract.createWorker(langs, oem, opts),
                configureWorker: (w) => w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }),
                signal: ocrSignal,
              });
            },
            onStatus: (status) => {
              if (status === 'starting' && !signal.aborted && isMountedRef.current) {
                setProcessingProgress({ phase: 'ocr' });
              }
            },
          });
        },
      });

      if (signal.aborted) {
        return;
      }

      const nextSettings =
        Object.keys(plan.settingsPatch).length > 0
          ? { ...settings, ...plan.settingsPatch }
          : settings;
      if (Object.keys(plan.settingsPatch).length > 0) {
        setSettings(nextSettings);
      }

      if (plan.status === 'abort') {
        const uiTarget = resolveMontageAbortUiTarget(plan.alert, nextSettings);
        switch (plan.alert.kind) {
          case 'auto_crop_context_error':
            reportProcessError(t('alert_failed_to_get_temp_canvas_context_for_auto_crop'), uiTarget);
            break;
          case 'auto_crop_not_found':
            reportProcessError(t('alert_failed_to_detect_crop_area'), uiTarget);
            break;
          case 'crop_outside_image':
            reportProcessError(
              t('alert_crop_outside_image', {
                width: plan.alert.width,
                height: plan.alert.height,
              }),
              uiTarget
            );
            break;
          case 'invalid_mask_area':
            reportProcessError(t('alert_invalid_mask_area'), uiTarget);
            break;
          case 'mask_outside_crop':
            reportProcessError(t('alert_mask_outside_crop'), uiTarget);
            break;
          case 'ocr_aborted':
            break;
          case 'ocr_error':
            console.error(plan.alert.error);
            reportProcessError(t('alert_ocr_error'), uiTarget);
            break;
          case 'ocr_not_found':
            reportProcessError(
              [
                plan.alert.enemyMissing ? t('alert_could_not_find_right_lv') : '',
                plan.alert.selfMissing ? t('alert_could_not_find_left_lv') : '',
              ].filter(Boolean).join('\n'),
              uiTarget
            );
            break;
        }
        return;
      }

      const { cropRect, finalSettings, tileMasks } = plan;

      const sizeEval = evaluateMontageCanvasSize(orderedImages.length, cropRect, finalSettings);
      if (sizeEval.status === 'invalid') {
        const sizeUiTarget = resolveCanvasSizeErrorUiTarget(sizeEval.reason, finalSettings.cropAuto);
        if (sizeEval.reason === 'exceeds_webp_dimension') {
          reportProcessError(
            t('alert_webp_canvas_size', {
              width: sizeEval.width.toLocaleString(),
              height: sizeEval.height.toLocaleString(),
              maxWebpDimension: MAX_WEBP_DIMENSION.toLocaleString(),
            }),
            sizeUiTarget
          );
        } else {
          reportProcessError(
            t('alert_invalid_canvas_size', { width: sizeEval.width, height: sizeEval.height }),
            sizeUiTarget
          );
        }
        return;
      }
      if (sizeEval.status === 'confirm_required') {
        // Release before blocking on user confirmation or allocating an oversized montage.
        releaseFirstImageBitmap();
        setProcessingProgress({ phase: 'confirming' });
        const confirmMessage = t('confirm_large_canvas_size', {
          width: sizeEval.width.toLocaleString(),
          height: sizeEval.height.toLocaleString(),
          pixels: sizeEval.pixels.toLocaleString(),
        });
        if (!(await requestLargeCanvasConfirm(confirmMessage)) || signal.aborted) {
          return;
        }
      }

      let mimeType = 'image/webp';
      if (finalSettings.outputFormat === 'png') mimeType = 'image/png';
      else if (finalSettings.outputFormat === 'jpeg') mimeType = 'image/jpeg';

      const montageCanvas = canvasRef.current;
      if (!montageCanvas) {
        throw new Error(t('alert_canvas_not_ready'));
      }

      montageCanvasUsed = true;
      const renderResult = await renderMontageToBlob<File, ImageBitmap>({
        dimensions: sizeEval,
        bgColor: finalSettings.bgColor,
        mimeType,
        quality: finalSettings.quality / 100,
        canvas: montageCanvas,
        files: orderedImages,
        colCount: finalSettings.colCount,
        offsetX: finalSettings.offsetX,
        offsetY: finalSettings.offsetY,
        cropRect,
        masks: tileMasks,
        expectedDimensions,
        signal,
        onPhaseChange: (phase) => {
          if (signal.aborted || !isMountedRef.current) return;
          if (phase === 'drawing') {
            setProcessingProgress({ phase: 'drawing', current: 0, total: orderedImages.length });
          } else {
            setProcessingProgress({ phase: 'encoding' });
          }
        },
        onProgress: (current, total) => {
          if (signal.aborted || !isMountedRef.current) return;
          setProcessingProgress({ phase: 'drawing', current, total });
        },
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

      if (renderResult.status === 'aborted' || signal.aborted) {
        return;
      }
      if (renderResult.status === 'context_failed') {
        throw new Error(t('alert_failed_to_get_context'));
      }
      if (renderResult.status === 'dimension_mismatch') {
        console.warn(
          `Encoded output dimension mismatch: expected ${sizeEval.width}x${sizeEval.height}, got ${renderResult.actualWidth}x${renderResult.actualHeight}`
        );
        reportProcessError(
          t('alert_output_dimension_mismatch', {
            expectedWidth: sizeEval.width.toLocaleString(),
            expectedHeight: sizeEval.height.toLocaleString(),
            actualWidth: renderResult.actualWidth.toLocaleString(),
            actualHeight: renderResult.actualHeight.toLocaleString(),
          })
        );
        return;
      }
      if (renderResult.status === 'allocation_failed' || renderResult.status === 'encode_failed') {
        reportProcessError(t('alert_image_generation_failed'));
        return;
      }

      const montageBlob = renderResult.blob;
      const getTimestamp = () => {
        const d = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      };
      const ext = resolveOutputExtension(montageBlob.type, finalSettings.outputFormat);
      setProcessedResult({
        blob: montageBlob,
        url: URL.createObjectURL(montageBlob),
        filename: `tile-${getTimestamp()}.${ext}`,
        width: sizeEval.width,
        height: sizeEval.height,
        fileSizeBytes: montageBlob.size,
        formatLabel: formatOutputFormatLabel(ext),
        settingsSnapshot: cloneSettings(finalSettings),
        imagesSnapshot: [...images],
      });

    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      if (error instanceof ImageDecodeError) {
        console.error(`Failed to decode image "${error.fileName}":`, error);
        reportProcessError(t('alert_image_decode_failed', { fileName: error.fileName }));
        return;
      }
      if (error instanceof ImageResolutionMismatchError) {
        console.warn(
          `Image resolution mismatch for "${error.fileName}": expected ${error.expectedWidth}x${error.expectedHeight}, got ${error.actualWidth}x${error.actualHeight}`
        );
        reportProcessError(
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

      reloadTriggered = true;
      window.location.reload();
    } finally {
      signal.removeEventListener('abort', forwardAbortToOcr);
      if (processAbortRef.current === abortController) {
        processAbortRef.current = null;
      }
      releaseFirstImageBitmap();
      const releaseDelayMs = isMountedRef.current
        ? getMemoryReleaseDelayMs({
            ocrSessionStarted,
            montageCanvasUsed,
            reloadTriggered,
          })
        : 0;
      if (isMountedRef.current && releaseDelayMs > 0) {
        setProcessingProgress({ phase: 'releasing' });
      }
      await releaseOcrResources(ocrAbortRef, ocrSessionRef);
      if (isMountedRef.current) {
        if (releaseDelayMs > 0) {
          // Add a small delay to allow GC to run before re-enabling the button
          await new Promise(resolve => setTimeout(resolve, releaseDelayMs));
        }
        if (isMountedRef.current) {
          setProcessingProgress(null);
          setIsCancelling(false);
          setIsProcessing(false);
        }
      }
    }
  };

  const processingStatusText = (() => {
    if (!processingProgress) return '';
    if (isReleasingMemory) {
      return processedResult
        ? t('status_releasing_memory_ready')
        : t('status_releasing_memory');
    }
    if (isCancelling) {
      return t('status_cancelling');
    }
    switch (processingProgress.phase) {
      case 'preparing':
        return t('status_preparing');
      case 'ocr':
        return t('ocr_status_starting');
      case 'confirming':
        return '';
      case 'drawing':
        return t('status_processing_progress', {
          current: processingProgress.current,
          total: processingProgress.total,
        });
      case 'encoding':
        return t('status_encoding');
    }
  })();

  const drawingProgress =
    !isCancelling &&
    processingProgress?.phase === 'drawing' &&
    processingProgress.total > 0
      ? processingProgress
      : null;

  const resultStaleReason = useMemo(() => {
    if (!processedResult) return 'none';
    return getResultStaleReason({
      currentSettings: settings,
      snapshotSettings: processedResult.settingsSnapshot,
      currentImages: images,
      snapshotImages: processedResult.imagesSnapshot,
    });
  }, [processedResult, settings, images]);

  const staleAlertMessage =
    resultStaleReason === 'settings'
      ? t('result_stale_settings')
      : resultStaleReason === 'images'
        ? t('result_stale_images')
        : resultStaleReason === 'both'
          ? t('result_stale_both')
          : null;

  const buttonVariants = resolveActionButtonVariants({
    hasImages: images.length > 0,
    hasFreshResult: Boolean(processedResult) && resultStaleReason === 'none',
  });

  const shareableResultFile = useMemo(() => {
    if (!processedResult) return null;
    return new File([processedResult.blob], processedResult.filename, {
      type: processedResult.blob.type || 'application/octet-stream',
    });
  }, [processedResult]);

  const canShareResult = useMemo(
    () => canShareImageFile(shareableResultFile),
    [shareableResultFile]
  );

  const handleShareResult = async () => {
    if (
      !shareableResultFile ||
      isSharing ||
      typeof navigator === 'undefined' ||
      typeof navigator.share !== 'function'
    ) {
      return;
    }
    setIsSharing(true);
    setShareError(null);
    try {
      await navigator.share({
        files: [shareableResultFile],
        title: t('title'),
      });
    } catch (error) {
      const isCancelled =
        isAbortError(error) ||
        (typeof DOMException !== 'undefined' &&
          error instanceof DOMException &&
          error.name === 'AbortError');
      if (!isCancelled) {
        console.warn('Failed to share result image:', error);
        if (isMountedRef.current) {
          setShareError(t('alert_share_failed'));
        }
      }
    } finally {
      if (isMountedRef.current) {
        setIsSharing(false);
      }
    }
  };

  const activePreviewFile = renderedPreview?.file ?? requestedPreviewFile;
  const previewDimensions =
    renderedPreview && renderedPreview.file === activePreviewFile
      ? renderedPreview.dimensions
      : null;
  const previewLoadError =
    Boolean(renderedPreview && renderedPreview.file === activePreviewFile && renderedPreview.error);
  const previewMetaSeparator = activeLocale?.startsWith('ja') ? ' ・ ' : ' · ';
  const previewMetaText = activePreviewFile
    ? [
        previewDimensions
          ? `${previewDimensions.width.toLocaleString()} × ${previewDimensions.height.toLocaleString()} px`
          : null,
        formatFileSize(activePreviewFile.size),
        formatFileTimestamp(activePreviewFile.lastModified) || null,
      ]
        .filter(Boolean)
        .join(previewMetaSeparator)
    : '';
  const previewIndex = activePreviewFile ? orderedImages.indexOf(activePreviewFile) : -1;
  const hasMultiplePreviewFiles = orderedImages.length > 1 && previewIndex !== -1;
  const canStepPreviewPrev = hasMultiplePreviewFiles && previewIndex > 0;
  const canStepPreviewNext = hasMultiplePreviewFiles && previewIndex < orderedImages.length - 1;

  return (
    <Container maxWidth="lg" sx={{ mt: { xs: 2, sm: 4 }, pb: { xs: 6, md: 20 }, minHeight: '100vh' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 2 }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <Typography
              variant="h4"
              component="h1"
              sx={{ fontSize: { xs: '1.375rem', sm: '1.875rem', md: '2.125rem' } }}
            >
              {t('title')}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              v{packageJson.version}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {t('subtitle')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          <LanguageButton />
          <ThemeModeButton />
        </Box>
      </Box>
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 5, lg: 4 }} sx={{ order: { xs: 2, md: 1 } }}>
          <Accordion expanded={expandedAccordions.settings} onChange={handleAccordionChange('settings')}>
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
                  <FormControl fullWidth size="small" disabled={isProcessing} error={hasFieldError('colCount')}>
                    <InputLabel id="col-count-label">{t('columns')}</InputLabel>
                    <Select labelId="col-count-label" name="colCount" value={settings.colCount} label={t('columns')} onChange={handleSettingChange}>
                      {Array.from({ length: MAX_COL_COUNT - MIN_COL_COUNT + 1 }, (_, i) => {
                        const val = MIN_COL_COUNT + i;
                        return <MenuItem key={val} value={val}>{val}</MenuItem>;
                      })}
                    </Select>
                    <FormHelperText>{t('columns_help')}</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small" disabled={isProcessing} error={hasFieldError('offsetX')}>
                    <InputLabel id="offset-label">{t('offset_px')}</InputLabel>
                    <Select labelId="offset-label" name="offsetX" value={settings.offsetX} label={t('offset_px')} onChange={handleSettingChange}>
                      {Array.from({ length: MAX_OFFSET_PX - MIN_OFFSET_PX + 1 }, (_, i) => {
                        const val = MIN_OFFSET_PX + i;
                        return <MenuItem key={val} value={val}>{val}</MenuItem>;
                      })}
                    </Select>
                    <FormHelperText>{t('offset_help')}</FormHelperText>
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
                <Grid size={{ xs: 6 }}><ColorSettingField label={t('background_color')} name="bgColor" value={settings.bgColor} disabled={isProcessing} error={hasFieldError('bgColor')} onCommit={handleColorSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}>
                  <FormControl fullWidth size="small" disabled={isProcessing} error={hasFieldError('outputFormat')}>
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
                  {settings.outputFormat === 'png' && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      {t('quality_png_help')}
                    </Typography>
                  )}
                </Grid>
              </Grid>
            </AccordionDetails>
          </Accordion>

          <Accordion expanded={expandedAccordions.crop} onChange={handleAccordionChange('crop')} sx={{ mt: 2 }}>
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
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                {t('crop_auto_help')}
              </Typography>
              {settings.cropAuto && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {t('crop_auto_coords_help')}
                </Typography>
              )}
              <Grid container spacing={2} sx={{ mt: 1 }}>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('x')} name="cropX" value={settings.cropX} min={0} integer disabled={isProcessing || settings.cropAuto} error={hasFieldError('cropX')} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('y')} name="cropY" value={settings.cropY} min={0} integer disabled={isProcessing || settings.cropAuto} error={hasFieldError('cropY')} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('width')} name="cropWidth" value={settings.cropWidth} min={1} integer disabled={isProcessing || settings.cropAuto} error={hasFieldError('cropWidth')} onCommit={handleNumericSettingCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('height')} name="cropHeight" value={settings.cropHeight} min={1} integer disabled={isProcessing || settings.cropAuto} error={hasFieldError('cropHeight')} onCommit={handleNumericSettingCommit} /></Grid>
              </Grid>
            </AccordionDetails>
          </Accordion>

          <MaskAccordion
            title={t('masking')}
            description={t('mask_description')}
            expanded={expandedAccordions.mask}
            onAccordionChange={handleAccordionChange('mask')}
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
            errorFields={processError?.fields}
            onSettingChange={handleSettingChange}
            onNumericCommit={handleNumericSettingCommit}
            onColorCommit={handleColorSettingCommit}
            onRatioSliderChange={(axis) => handleRatioSliderChange('maskRatioRect', axis)}
            onPresetChange={handlePresetChange('maskRatioRect')}
          />

          <MaskAccordion
            title={t('self_mask')}
            description={t('self_mask_description')}
            expanded={expandedAccordions.selfMask}
            onAccordionChange={handleAccordionChange('selfMask')}
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
            errorFields={processError?.fields}
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
        <Grid size={{ xs: 12, md: 7, lg: 8 }} sx={{ order: { xs: 1, md: 2 } }}>
          <Card
            onDragEnter={handleCardDragEnter}
            onDragOver={handleCardDragOver}
            onDragLeave={handleCardDragLeave}
            onDrop={handleCardDrop}
            sx={{ position: 'relative' }}
          >
            {isFileDragOver && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  p: 3,
                  borderRadius: 'inherit',
                  border: 2,
                  borderStyle: 'dashed',
                  borderColor: 'primary.main',
                  bgcolor: (muiTheme) => alpha(muiTheme.palette.background.paper, 0.9),
                  pointerEvents: 'none',
                }}
              >
                <Typography variant="h6" color="primary" align="center">
                  {t('drop_images_here')}
                </Typography>
              </Box>
            )}
            <CardContent>
              <Typography variant="h5" component="h2" sx={{ mb: 0.75 }}>{t('upload_and_process')}</Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 0.75,
                  mb: images.length === 0 ? 1 : 2,
                  color: 'text.secondary',
                }}
              >
                <LockOutlinedIcon sx={{ fontSize: 15, mt: '2px', flexShrink: 0 }} aria-hidden="true" />
                <Typography variant="caption" color="text.secondary">
                  {t('local_processing_notice')}
                </Typography>
              </Box>
              {images.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  {t('upload_intro')}
                </Typography>
              )}
              <Button
                variant={buttonVariants.upload}
                component="label"
                fullWidth
                size="large"
                startIcon={<AddPhotoIcon />}
                disabled={isProcessing}
              >
                {images.length > 0 ? t('add_images') : t('upload_images')}
                <input
                  type="file"
                  hidden
                  accept="image/png, image/jpeg"
                  multiple
                  disabled={isProcessing}
                  onChange={handleFileChange}
                />
              </Button>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  display: { xs: 'none', sm: 'block' },
                  mt: 0.75,
                  textAlign: 'center',
                }}
              >
                {t('drop_zone_hint')}
              </Typography>
              {fileSelectionNotice && (
                <Alert
                  severity={fileSelectionNotice.severity}
                  onClose={() => setFileSelectionNotice(null)}
                  sx={{ mt: 1.5 }}
                >
                  {fileSelectionNotice.message}
                </Alert>
              )}
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
                        maxHeight: { xs: 260, sm: 220 },
                        overflowY: 'auto',
                        border: 1,
                        borderColor: 'divider',
                        borderRadius: 1,
                        bgcolor: 'background.default',
                      }}
                    >
                      {orderedImages.map((file, index) => {
                        const { head, tail } = splitFilenameForMiddleEllipsis(file.name);
                        return (
                          <Box
                            component="li"
                            key={getFileKey(file)}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              pr: { xs: 0.5, sm: 1 },
                              borderBottom: index < orderedImages.length - 1 ? 1 : 0,
                              borderColor: 'divider',
                            }}
                          >
                            <ButtonBase
                              onClick={() => handleOpenPreview(file)}
                              aria-label={t('preview_file', { name: file.name })}
                              sx={{
                                flex: 1,
                                minWidth: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'flex-start',
                                gap: { xs: 0.5, sm: 1 },
                                pl: { xs: 1, sm: 1.25 },
                                pr: { xs: 0.5, sm: 1 },
                                py: { xs: 0.75, sm: 0.5 },
                                textAlign: 'left',
                                '&:hover': { bgcolor: 'action.hover' },
                              }}
                            >
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{
                                  minWidth: '2.2ch',
                                  textAlign: 'right',
                                  flexShrink: 0,
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {index + 1}.
                              </Typography>
                              <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Box
                                  title={file.name}
                                  sx={{
                                    display: 'flex',
                                    alignItems: 'baseline',
                                    minWidth: 0,
                                  }}
                                >
                                  {head && (
                                    <Typography component="span" variant="body2" noWrap sx={{ minWidth: 0 }}>
                                      {head}
                                    </Typography>
                                  )}
                                  <Typography
                                    component="span"
                                    variant="body2"
                                    sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                                  >
                                    {tail}
                                  </Typography>
                                </Box>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    display: { xs: 'block', sm: 'none' },
                                    fontVariantNumeric: 'tabular-nums',
                                    lineHeight: 1.2,
                                  }}
                                >
                                  {formatFileTimestamp(file.lastModified)}
                                </Typography>
                              </Box>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{
                                  display: { xs: 'none', sm: 'block' },
                                  flexShrink: 0,
                                  whiteSpace: 'nowrap',
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {formatFileTimestamp(file.lastModified)}
                              </Typography>
                            </ButtonBase>
                            <IconButton
                              size="small"
                              aria-label={t('remove_file', { name: file.name })}
                              onClick={() => handleRemoveImage(file)}
                              disabled={isProcessing}
                              sx={{
                                minWidth: { xs: 40, sm: 30 },
                                minHeight: { xs: 40, sm: 30 },
                                p: { xs: 1, sm: 0.5 },
                                ml: { xs: 0.25, sm: 0.5 },
                                flexShrink: 0,
                                color: 'text.secondary',
                                '&:hover': { color: 'error.main' },
                              }}
                            >
                              <CloseIcon sx={{ fontSize: { xs: 20, sm: 16 } }} />
                            </IconButton>
                          </Box>
                        );
                      })}
                    </Box>
                  </Collapse>
                </Box>
              )}
              <Box sx={{ mt: 2, display: 'flex', gap: 1.5, alignItems: 'stretch' }}>
                <Button
                  variant={buttonVariants.process}
                  color="primary"
                  onClick={processImages}
                  disabled={isProcessing || images.length === 0}
                  fullWidth={!canCancelProcessing}
                  size="large"
                  startIcon={
                    isProcessing && !isReleasingMemory ? (
                      <CircularProgress size={20} color="inherit" />
                    ) : (
                      <PlayArrow />
                    )
                  }
                  sx={{ flex: 1 }}
                >
                  {!isProcessing
                    ? t('process_images')
                    : isReleasingMemory
                      ? t('releasing_memory')
                      : t('processing')}
                </Button>
                {canCancelProcessing && (
                  <Button
                    variant="outlined"
                    color="inherit"
                    size="large"
                    startIcon={<CloseIcon />}
                    onClick={handleCancelProcessing}
                    disabled={isCancelling}
                    sx={{
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                      color: 'text.secondary',
                      borderColor: 'divider',
                    }}
                  >
                    {isCancelling ? t('cancelling') : t('cancel')}
                  </Button>
                )}
              </Box>
              {processError && (
                <Alert
                  ref={processAlertRef}
                  severity="error"
                  onClose={() => setProcessError(null)}
                  sx={{ mt: 2, whiteSpace: 'pre-line' }}
                >
                  {processError.message}
                </Alert>
              )}
              <Box sx={{ mt: processingStatusText ? 1.5 : 0 }} translate="no">
                <Typography
                  variant="body2"
                  color="text.secondary"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {processingStatusText}
                </Typography>
                {isProcessing && !isReleasingMemory && processingStatusText && (
                  <LinearProgress
                    variant={drawingProgress ? 'determinate' : 'indeterminate'}
                    value={
                      drawingProgress
                        ? (drawingProgress.current / drawingProgress.total) * 100
                        : undefined
                    }
                    aria-label={processingStatusText}
                    sx={{ mt: 0.75, borderRadius: 1 }}
                  />
                )}
              </Box>
              {processedResult && (
                <Box sx={{ mt: 3, overflowAnchor: 'none' }} ref={resultRef}>
                  <Box
                    sx={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 1,
                      mb: 1,
                    }}
                  >
                    <Typography variant="h6">{t('result')}</Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {t('result_summary', {
                        width: processedResult.width.toLocaleString(),
                        height: processedResult.height.toLocaleString(),
                        size: formatFileSize(processedResult.fileSizeBytes),
                        format: processedResult.formatLabel,
                      })}
                    </Typography>
                  </Box>
                  {staleAlertMessage && (
                    <Alert severity="warning" sx={{ mb: 1.5 }}>
                      {staleAlertMessage}
                    </Alert>
                  )}
                  <Box
                    component="img"
                    src={processedResult.url}
                    alt={t('result_image_alt')}
                    width={processedResult.width}
                    height={processedResult.height}
                    sx={{
                      display: 'block',
                      maxWidth: '100%',
                      height: 'auto',
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                    }}
                  />
                  {shareError && (
                    <Alert
                      severity="warning"
                      onClose={() => setShareError(null)}
                      sx={{ mt: 1.5 }}
                    >
                      {shareError}
                    </Alert>
                  )}
                  <Box sx={{ mt: 2, display: 'flex', gap: 1.5, alignItems: 'stretch' }}>
                    <Button
                      variant={buttonVariants.download}
                      href={processedResult.url}
                      download={processedResult.filename}
                      fullWidth={!canShareResult}
                      size="large"
                      sx={{ flex: 1 }}
                      startIcon={<DownloadIcon />}
                    >
                      {t('download_image')}
                    </Button>
                    {canShareResult && (
                      <Button
                        variant="outlined"
                        color="primary"
                        size="large"
                        startIcon={<ShareIcon />}
                        onClick={handleShareResult}
                        disabled={isSharing}
                        sx={{ flexShrink: 0, whiteSpace: 'nowrap', minWidth: { xs: 112, sm: 128 } }}
                      >
                        {t('share_image')}
                      </Button>
                    )}
                  </Box>
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
      <Dialog
        open={largeCanvasConfirm.open}
        onClose={() => resolveLargeCanvasConfirm(false)}
        aria-labelledby="large-canvas-confirm-dialog-title"
        aria-describedby="large-canvas-confirm-dialog-description"
      >
        <DialogTitle id="large-canvas-confirm-dialog-title">
          {t('confirm_large_canvas_title')}
        </DialogTitle>
        <DialogContent>
          <DialogContentText
            id="large-canvas-confirm-dialog-description"
            sx={{ whiteSpace: 'pre-line' }}
          >
            {largeCanvasConfirm.message}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => resolveLargeCanvasConfirm(false)}>{t('cancel')}</Button>
          <Button
            onClick={() => resolveLargeCanvasConfirm(true)}
            color="warning"
            variant="contained"
          >
            {t('continue')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={previewOpen && Boolean(activePreviewFile)}
        onClose={handleClosePreview}
        onKeyDown={handlePreviewKeyDown}
        maxWidth="md"
        fullWidth
        aria-labelledby="file-preview-dialog-title"
        slotProps={{
          paper: { sx: { m: { xs: 1.5, sm: 3 } } },
          transition: { onExited: handlePreviewExited },
        }}
      >
        <DialogTitle
          id="file-preview-dialog-title"
          component="div"
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
            pb: 1.25,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="subtitle1"
              component="h2"
              sx={{ fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}
            >
              {activePreviewFile?.name}
            </Typography>
            {previewMetaText && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 0.25, fontVariantNumeric: 'tabular-nums' }}
              >
                {previewMetaText}
              </Typography>
            )}
          </Box>
          <IconButton
            size="small"
            aria-label={t('close')}
            onClick={handleClosePreview}
            sx={{
              minWidth: { xs: 36, sm: 32 },
              minHeight: { xs: 36, sm: 32 },
              mt: -0.5,
              mr: -1,
              color: 'text.secondary',
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent
          dividers
          sx={{
            px: { xs: 1.5, sm: 2.5 },
            py: { xs: 1.5, sm: 2 },
            height: { xs: 'auto', sm: '62vh' },
            minHeight: { xs: renderedPreview ? 0 : 160, sm: 320 },
            maxHeight: { xs: 'none', sm: 620 },
            overflow: { xs: 'auto', sm: 'hidden' },
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {previewLoadError ? (
            <Alert severity="error" sx={{ width: '100%' }}>
              {t('preview_image_load_failed')}
            </Alert>
          ) : (
            renderedPreview &&
            renderedPreview.url !== '' && (
              <Box
                component="img"
                src={renderedPreview.url}
                alt={renderedPreview.file.name}
                sx={{
                  display: 'block',
                  maxWidth: '100%',
                  maxHeight: { xs: '60vh', sm: '100%' },
                  width: 'auto',
                  height: 'auto',
                  objectFit: 'contain',
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                  bgcolor: 'background.default',
                }}
              />
            )
          )}
        </DialogContent>
        {hasMultiplePreviewFiles && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              px: { xs: 1.5, sm: 2.5 },
              py: 1,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<ChevronLeftIcon />}
              onClick={() => handleStepPreview(-1)}
              disabled={!canStepPreviewPrev}
              sx={{ minHeight: { xs: 40, sm: 34 }, minWidth: { xs: 96, sm: 100 } }}
            >
              {t('previous_file')}
            </Button>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}
            >
              {previewIndex + 1} / {orderedImages.length}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              endIcon={<ChevronRightIcon />}
              onClick={() => handleStepPreview(1)}
              disabled={!canStepPreviewNext}
              sx={{ minHeight: { xs: 40, sm: 34 }, minWidth: { xs: 96, sm: 100 } }}
            >
              {t('next_file')}
            </Button>
          </Box>
        )}
        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5, justifyContent: 'space-between' }}>
          <Button
            color="error"
            variant="outlined"
            startIcon={<DeleteOutlineIcon />}
            onClick={handleRemovePreviewImage}
            disabled={isProcessing || !activePreviewFile}
            sx={{ minHeight: { xs: 40, sm: 36 } }}
          >
            {t('remove_from_list')}
          </Button>
          <Button
            onClick={handleClosePreview}
            variant="contained"
            autoFocus
            sx={{ minHeight: { xs: 40, sm: 36 } }}
          >
            {t('close')}
          </Button>
        </DialogActions>
      </Dialog>
      <canvas ref={canvasRef} width={1} height={1} style={{ display: 'none' }} aria-hidden="true"></canvas>
    </Container>
  );
};

export default ImageProcessor;
