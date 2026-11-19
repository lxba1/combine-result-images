import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, ButtonBase, TextField, Container, Grid, Card, CardContent, Typography, CircularProgress, LinearProgress, Box, Slider, Switch, FormControlLabel, FormHelperText, Select, MenuItem, InputLabel, FormControl, Accordion, AccordionSummary, AccordionDetails, IconButton, Menu, ListItemIcon, ListItemText, Tooltip, InputAdornment, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Collapse, useMediaQuery } from '@mui/material';
import { useColorScheme, useTheme, styled } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { PlayArrow, ExpandMore as ExpandMoreIcon, ExpandLess as ExpandLessIcon, GetApp as DownloadIcon, Share as ShareIcon, AddPhotoAlternate as AddPhotoIcon, AddPhotoAlternateOutlined as AddPhotoOutlinedIcon, LightMode as LightModeIcon, DarkMode as DarkModeIcon, SettingsBrightness as SystemModeIcon, Language as LanguageIcon, RestartAlt as RestartAltIcon, Check as CheckIcon, Close as CloseIcon, DeleteOutline as DeleteOutlineIcon, LockOutlined as LockOutlinedIcon, ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon, TuneRounded as TuneIcon, CropRounded as CropIcon, VisibilityOffOutlined as MaskIcon, FaceRetouchingOffOutlined as SelfMaskIcon } from '@mui/icons-material';
import type { SelectChangeEvent } from '@mui/material';
import Tesseract, { PSM } from 'tesseract.js';
import packageJson from '../package.json';
import { LANGUAGE_STORAGE_KEY } from './i18n';
import {
  type OcrMaskCacheEntry,
  type OcrSessionController,
  canvasToBlob,
  detectOcrMasksWithCache,
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
  computeRatioMaskOverlayBox,
  createDefaultSettings,
  evaluateMontageCanvasSize,
  formatRatioPercent,
  getResultStaleReason,
  intersectPixelRects,
  isRatioRectEqual,
  loadSettingsFromStorage,
  normalizeHexColor,
  percentInputToRatio,
  ratioToPercentInput,
  resolveCanvasSizeErrorUiTarget,
  saveSettingsToStorage,
  validateSettingsBeforeProcess,
} from './settingsHelpers.ts';
import { detectAutoCropFromImage } from './cropHelpers.ts';
import {
  ImageDecodeError,
  ImageResolutionMismatchError,
  canShareImageFile,
  computeScaledPreviewDimensions,
  decodeImageWithFallback,
  formatFileSize,
  formatOutputFormatLabel,
  getRerunCooldownRemainingMs,
  guardWindowFileDragEvent,
  hasExternalFilesDataTransfer,
  mergeInputImageFiles,
  prepareMontagePlan,
  renderMontageToBlob,
  resolveActionButtonVariants,
  resolveAdjacentPreviewFile,
  resolveFileSelectionNotice,
  resolveMaskAccordionPreviewState,
  resolveMontageAbortUiTarget,
  resolveNextPreviewAfterRemoval,
  resolveOutputExtension,
  resolveRatioPreviewBuildDelayMs,
  resolveRatioPreviewCropRect,
  resolveRemovablePreviewTarget,
  shouldScrollToResult,
  splitFilenameForMiddleEllipsis,
  updateHeavyResourceReleaseTimes,
  recordLateMontageRelease,
  NO_HEAVY_RESOURCE_RELEASES,
  PROCESS_START_SETTLE_MS,
  type FileSelectionNoticeSpec,
  type HeavyResourceReleaseTimes,
  type ImageDimensions,
  type MaskAccordionPreviewState,
  type RatioPreviewRequest,
  type RatioPreviewSnapshot,
} from './montageHelpers.ts';

/**
 * A translation key plus its interpolation params. Messages kept in state use this instead of a
 * translated string and are translated at render time, so a visible message follows the UI
 * language when it is switched.
 */
interface TranslatableMessage {
  key: string;
  params?: Record<string, string | number>;
}

const msg = (key: string, params?: TranslatableMessage['params']): TranslatableMessage =>
  params ? { key, params } : { key };

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
          sx={{
            width: 36,
            height: 36,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            color: 'text.secondary',
            '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
          }}
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

/** Theme-aware translucent palette color that follows the active light/dark scheme via CSS variables. */
const tint = (theme: Theme, color: 'primary' | 'success', opacity: number): string =>
  theme.alpha((theme.vars ?? theme).palette[color].main, opacity);

interface StatusPillProps {
  active?: boolean;
  children: React.ReactNode;
}

/**
 * Small non-interactive pill summarizing a section's current state in its header.
 * Stays on one line normally (the header moves it below the title first) and only wraps
 * its own text when even a full row is too narrow, e.g. very small screens with enlarged text.
 */
const StatusPill: React.FC<StatusPillProps> = ({ active = false, children }) => (
  <Box
    component="span"
    sx={(theme) => ({
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '100%',
      px: 1,
      py: 0.25,
      borderRadius: '12px',
      fontSize: '0.75rem',
      fontWeight: 600,
      lineHeight: 1.5,
      fontVariantNumeric: 'tabular-nums',
      ...(active
        ? { color: 'primary.main', bgcolor: tint(theme, 'primary', 0.12) }
        : { color: 'text.secondary', bgcolor: 'action.hover' }),
    })}
  >
    {children}
  </Box>
);

interface SectionSummaryProps {
  icon: React.ReactElement;
  title: string;
  meta: React.ReactNode;
}

/**
 * Accordion header row: tinted icon badge, section title, and a right-aligned status summary.
 * On narrow screens the summary wraps under the title instead of truncating it.
 */
const SectionSummary: React.FC<SectionSummaryProps> = ({ icon, title, meta }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', minWidth: 0, pr: 1 }}>
    <Box
      aria-hidden="true"
      sx={(theme) => ({
        width: 32,
        height: 32,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '10px',
        color: 'primary.main',
        bgcolor: tint(theme, 'primary', 0.1),
        '& svg': { fontSize: 18 },
      })}
    >
      {icon}
    </Box>
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: 1,
        rowGap: 0.25,
      }}
    >
      <Typography variant="h6" sx={{ minWidth: 0 }}>
        {title}
      </Typography>
      <Box sx={{ display: 'flex' }}>{meta}</Box>
    </Box>
  </Box>
);

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
  /** Optional unit shown after the number, e.g. `%`. */
  unit?: string;
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
  unit,
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
        input: unit ? { endAdornment: <InputAdornment position="end">{unit}</InputAdornment> } : undefined,
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
  icon: React.ReactElement;
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
  ratioPreview?: MaskAccordionPreviewState;
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
  icon,
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
  ratioPreview,
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
  const overlayBox = computeRatioMaskOverlayBox(ratioRect);
  const normalizedOverlayColor = normalizeHexColor(colorValue) ?? '#000000';
  // Ratio inputs show percent like the sliders; settings keep the normalized 0..1 value.
  const handleRatioPercentCommit = (name: string, percent: number, options?: { finalize?: boolean }) =>
    onNumericCommit(name, percentInputToRatio(percent), options);
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
        <SectionSummary
          icon={icon}
          title={title}
          meta={<StatusPill active={enabled}>{enabled ? t(`mode_${mode}`) : 'OFF'}</StatusPill>}
        />
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
                  <Box
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      p: 1,
                      bgcolor: 'background.default',
                    }}
                  >
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mb: 0.75 }}
                    >
                      {t('ratio_preview_title')}
                    </Typography>
                    {!ratioPreview?.hasImages ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {t('ratio_preview_empty')}
                      </Typography>
                    ) : ratioPreview.status === 'error' ? (
                      <Typography variant="caption" color="error" sx={{ display: 'block' }}>
                        {t('ratio_preview_error')}
                      </Typography>
                    ) : ratioPreview.status === 'ok' && ratioPreview.url ? (
                      <>
                        <Box
                          aria-busy={ratioPreview.isUpdating || undefined}
                          sx={{
                            position: 'relative',
                            width: 'fit-content',
                            maxWidth: '100%',
                            mx: 'auto',
                            overflow: 'hidden',
                            borderRadius: 0.5,
                            border: 1,
                            borderColor: 'divider',
                            bgcolor: 'action.hover',
                            lineHeight: 0,
                          }}
                        >
                          <Box
                            component="img"
                            src={ratioPreview.url}
                            alt={t('ratio_preview_alt')}
                            sx={{
                              display: 'block',
                              maxWidth: '100%',
                              maxHeight: { xs: 220, sm: 250 },
                              width: 'auto',
                              height: 'auto',
                              userSelect: 'none',
                              pointerEvents: 'none',
                            }}
                          />
                          {overlayBox && (
                            <Box
                              aria-hidden="true"
                              sx={{
                                position: 'absolute',
                                left: `${overlayBox.leftPct}%`,
                                top: `${overlayBox.topPct}%`,
                                width: `${overlayBox.widthPct}%`,
                                height: `${overlayBox.heightPct}%`,
                                bgcolor: normalizedOverlayColor,
                                opacity: 0.85,
                                boxSizing: 'border-box',
                                border: '1px solid rgba(255, 255, 255, 0.85)',
                                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.45)',
                                pointerEvents: 'none',
                              }}
                            />
                          )}
                          {ratioPreview.isUpdating && (
                            <Box
                              aria-hidden="true"
                              sx={{
                                position: 'absolute',
                                top: 6,
                                right: 6,
                                p: 0.5,
                                borderRadius: '50%',
                                bgcolor: 'rgba(0, 0, 0, 0.6)',
                                color: '#fff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                pointerEvents: 'none',
                              }}
                            >
                              <CircularProgress size={14} color="inherit" />
                            </Box>
                          )}
                        </Box>
                        {ratioPreview.autoCropFallback && (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                            {t('ratio_preview_autocrop_fallback')}
                          </Typography>
                        )}
                      </>
                    ) : (
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          py: 2,
                        }}
                      >
                        <CircularProgress size={18} />
                      </Box>
                    )}
                  </Box>
                </Grid>
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
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_left')} name={`${ratioKey}.rx0`} value={ratioToPercentInput(ratioRect.rx0)} min={0} max={100} step={0.1} unit="%" disabled={disabled} error={hasError(`${ratioKey}.rx0`)} onCommit={handleRatioPercentCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_top')} name={`${ratioKey}.ry0`} value={ratioToPercentInput(ratioRect.ry0)} min={0} max={100} step={0.1} unit="%" disabled={disabled} error={hasError(`${ratioKey}.ry0`)} onCommit={handleRatioPercentCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_right')} name={`${ratioKey}.rx1`} value={ratioToPercentInput(ratioRect.rx1)} min={0} max={100} step={0.1} unit="%" disabled={disabled} error={hasError(`${ratioKey}.rx1`)} onCommit={handleRatioPercentCommit} /></Grid>
                <Grid size={{ xs: 6 }}><NumericTextField label={t('ratio_bottom')} name={`${ratioKey}.ry1`} value={ratioToPercentInput(ratioRect.ry1)} min={0} max={100} step={0.1} unit="%" disabled={disabled} error={hasError(`${ratioKey}.ry1`)} onCommit={handleRatioPercentCommit} /></Grid>
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
  // `slow` turns on once the wait passes SLOW_ENCODE_WAIT_NOTICE_MS, showing the reload hint.
  | { phase: 'waiting_encode'; slow: boolean }
  | { phase: 'preparing' }
  | { phase: 'ocr' }
  | { phase: 'confirming' }
  | { phase: 'drawing'; current: number; total: number }
  | { phase: 'encoding' };

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

/**
 * How long a run waits for a cancelled run's encode before suggesting a reload. A large PNG on a
 * phone can take tens of seconds, so this only adds a hint; the wait itself goes on.
 */
const SLOW_ENCODE_WAIT_NOTICE_MS = 30_000;

/** Resolves when `task` settles or on abort, whichever comes first. */
const waitForSettleWithAbort = (task: Promise<unknown>, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    task.then(finish, finish);
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

type RatioPreviewBuildResult =
  | {
      status: 'ok';
      url: string;
      autoCropFallback: boolean;
    }
  | { status: 'error' };

const buildCroppedRatioPreview = async (params: {
  file: File;
  cropAuto: boolean;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  shouldCancel: () => boolean;
}): Promise<RatioPreviewBuildResult | null> => {
  let bitmap: ImageBitmap | null = null;
  let tempCanvas: HTMLCanvasElement | null = null;
  try {
    const decoded = await decodeImageWithFallback<File, ImageBitmap>(params.file);
    bitmap = decoded;
    if (params.shouldCancel()) {
      return null;
    }
    const sourceSize: ImageDimensions = {
      width: decoded.width,
      height: decoded.height,
    };
    const { cropRect, autoCropFallback } = resolveRatioPreviewCropRect({
      sourceSize,
      cropAuto: params.cropAuto,
      cropX: params.cropX,
      cropY: params.cropY,
      cropWidth: params.cropWidth,
      cropHeight: params.cropHeight,
      detectAutoCrop: () => detectAutoCropFromImage(decoded),
    });
    if (params.shouldCancel()) {
      return null;
    }
    const previewSize = computeScaledPreviewDimensions(cropRect.width, cropRect.height);
    tempCanvas = document.createElement('canvas');
    tempCanvas.width = previewSize.width;
    tempCanvas.height = previewSize.height;
    const ctx = tempCanvas.getContext('2d', { alpha: false });
    if (!ctx) {
      return { status: 'error' };
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, previewSize.width, previewSize.height);
    const clippedSource = intersectPixelRects(cropRect, {
      x: 0,
      y: 0,
      width: sourceSize.width,
      height: sourceSize.height,
    });
    if (clippedSource) {
      const scaleX = previewSize.width / cropRect.width;
      const scaleY = previewSize.height / cropRect.height;
      ctx.drawImage(
        decoded,
        clippedSource.x,
        clippedSource.y,
        clippedSource.width,
        clippedSource.height,
        (clippedSource.x - cropRect.x) * scaleX,
        (clippedSource.y - cropRect.y) * scaleY,
        clippedSource.width * scaleX,
        clippedSource.height * scaleY
      );
    }
    decoded.close();
    bitmap = null;

    const blob = await canvasToBlob(tempCanvas);
    if (params.shouldCancel()) {
      return null;
    }
    return {
      status: 'ok',
      url: URL.createObjectURL(blob),
      autoCropFallback,
    };
  } catch (error) {
    if (params.shouldCancel()) {
      return null;
    }
    console.warn('Failed to build ratio preview image:', error);
    return { status: 'error' };
  } finally {
    if (bitmap) {
      bitmap.close();
    }
    if (tempCanvas) {
      tempCanvas.width = 1;
      tempCanvas.height = 1;
    }
  }
};

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
  // Kept as a translation key + params (not a translated string) so a visible notice
  // follows the UI language when it is switched.
  const [fileSelectionNotice, setFileSelectionNotice] = useState<FileSelectionNoticeSpec | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [requestedPreviewFile, setRequestedPreviewFile] = useState<File | null>(null);
  const [renderedPreview, setRenderedPreview] = useState<RenderedPreviewState | null>(null);
  const [ratioPreview, setRatioPreview] = useState<RatioPreviewSnapshot<File> | null>(null);
  const [processedResult, setProcessedResult] = useState<ProcessedMontageResult | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [shareError, setShareError] = useState<TranslatableMessage | null>(null);
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
    /** Shown one per line. */
    lines: readonly TranslatableMessage[];
    fields: ReadonlySet<SettingFieldKey>;
  } | null>(null);
  const [largeCanvasConfirm, setLargeCanvasConfirm] = useState<{
    open: boolean;
    message: TranslatableMessage | null;
  }>({
    open: false,
    message: null,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ocrSessionRef = useRef<OcrSessionController<Tesseract.Worker> | null>(null);
  const ocrAbortRef = useRef<AbortController | null>(null);
  // OCR masks found for the current first image and crop, so re-runs that change only other
  // settings (columns, colors, format, ...) skip starting an OCR worker. Kept in memory only and
  // keyed by getFileKey, so it never holds on to a File that was removed from the list.
  const ocrMaskCacheRef = useRef<OcrMaskCacheEntry<number> | null>(null);
  const processAbortRef = useRef<AbortController | null>(null);
  // Synchronous twin of isSharing, so a second share call before the re-render is ignored.
  const isSharingRef = useRef(false);
  const fileDragDepthRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const requestedPreviewFileRef = useRef<File | null>(null);
  // Image and crop of the successful preview held in ratioPreview; null whenever ratioPreview
  // holds no successful preview (none yet, cleared, or an error).
  const ratioPreviewKeyRef = useRef<{ file: File; cropKey: string } | null>(null);
  // What the open ratio preview last asked for; null while no ratio preview is shown.
  const ratioPreviewRequestRef = useRef<RatioPreviewRequest<File> | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const fileSelectionNoticeRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processAlertRef = useRef<HTMLDivElement>(null);
  const largeCanvasConfirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const isMountedRef = useRef(true);
  // When the previous run released its montage canvas / OCR worker, so that a quick re-run
  // can wait out the remaining cooldown instead of every run locking the UI afterwards.
  const heavyResourceReleaseTimesRef = useRef<HeavyResourceReleaseTimes>(NO_HEAVY_RESOURCE_RELEASES);
  // Settles when the browser finishes an encode that a cancelled run stopped waiting for.
  const abandonedMontageEncodeRef = useRef<Promise<void> | null>(null);

  const trackAbandonedMontageEncode = (encodeFinished: Promise<void>) => {
    abandonedMontageEncodeRef.current = encodeFinished;
    void encodeFinished.then(() => {
      if (abandonedMontageEncodeRef.current === encodeFinished) {
        abandonedMontageEncodeRef.current = null;
      }
      // The montage snapshot is only freed now, so run the montage cooldown from here.
      heavyResourceReleaseTimesRef.current = recordLateMontageRelease(
        heavyResourceReleaseTimesRef.current,
        performance.now()
      );
    });
  };

  const isDefaultSettings = areSettingsDefault(settings);

  const canCancelProcessing = isProcessing;

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
    message: TranslatableMessage | readonly TranslatableMessage[],
    target: { accordions?: readonly SettingsAccordionId[]; fields?: readonly SettingFieldKey[] } = {}
  ) => {
    if (!isMountedRef.current) return;
    expandAccordions(target.accordions ?? []);
    setProcessError({
      lines: 'key' in message ? [message] : message,
      fields: new Set(target.fields ?? []),
    });
  };

  const resolveLargeCanvasConfirm = (confirmed: boolean) => {
    const resolve = largeCanvasConfirmResolverRef.current;
    largeCanvasConfirmResolverRef.current = null;
    if (isMountedRef.current) {
      setLargeCanvasConfirm({ open: false, message: null });
    }
    resolve?.(confirmed);
  };

  const requestLargeCanvasConfirm = (message: TranslatableMessage): Promise<boolean> => {
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
    if (fileSelectionNotice) {
      fileSelectionNoticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [fileSelectionNotice]);

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

  const previewSourceImage = orderedImages[0] ?? null;
  const activePreviewCropKey = settings.cropAuto
    ? 'auto'
    : `manual:${settings.cropX},${settings.cropY},${settings.cropWidth},${settings.cropHeight}`;
  const needsRatioPreview =
    Boolean(previewSourceImage) &&
    ((expandedAccordions.mask && settings.maskEnabled && settings.maskMode === 'ratio') ||
      (expandedAccordions.selfMask && settings.selfMaskEnabled && settings.selfMaskMode === 'ratio'));

  useEffect(() => {
    const url = ratioPreview?.url;
    return () => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [ratioPreview]);

  useEffect(() => {
    if (!needsRatioPreview || !previewSourceImage) {
      ratioPreviewRequestRef.current = null;
      return;
    }
    const previousRequest = ratioPreviewRequestRef.current;
    ratioPreviewRequestRef.current = { file: previewSourceImage, cropKey: activePreviewCropKey };
    if (
      ratioPreviewKeyRef.current?.file === previewSourceImage &&
      ratioPreviewKeyRef.current?.cropKey === activePreviewCropKey
    ) {
      return;
    }
    let cancelled = false;

    const startBuild = () => void buildCroppedRatioPreview({
      file: previewSourceImage,
      cropAuto: settings.cropAuto,
      cropX: settings.cropX,
      cropY: settings.cropY,
      cropWidth: settings.cropWidth,
      cropHeight: settings.cropHeight,
      shouldCancel: () => cancelled || !isMountedRef.current,
    }).then((built) => {
      if (cancelled || !isMountedRef.current) {
        if (built?.status === 'ok') {
          URL.revokeObjectURL(built.url);
        }
        return;
      }
      if (!built) {
        return;
      }
      if (built.status === 'ok') {
        // Only a successful build is remembered, so a failed one (e.g. a decode that ran out of
        // memory) is retried the next time the preview opens. Every setRatioPreview keeps this
        // key in step with the stored snapshot.
        ratioPreviewKeyRef.current = {
          file: previewSourceImage,
          cropKey: activePreviewCropKey,
        };
        setRatioPreview({
          status: 'ok',
          url: built.url,
          autoCropFallback: built.autoCropFallback,
          sourceFile: previewSourceImage,
          cropKey: activePreviewCropKey,
        });
      } else {
        // The error replaces any earlier successful preview, so forget its key too; otherwise
        // returning to that image would skip the rebuild and stay on "loading".
        ratioPreviewKeyRef.current = null;
        setRatioPreview({
          status: 'error',
          url: '',
          autoCropFallback: false,
          sourceFile: previewSourceImage,
          cropKey: activePreviewCropKey,
        });
      }
    });

    // Typing in the crop fields commits every keystroke; wait for a pause before decoding the
    // full-size image again. Opening the preview or switching images builds right away.
    const delayMs = resolveRatioPreviewBuildDelayMs(previousRequest, {
      file: previewSourceImage,
      cropKey: activePreviewCropKey,
    });
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (delayMs > 0) {
      timerId = setTimeout(startBuild, delayMs);
    } else {
      startBuild();
    }

    return () => {
      cancelled = true;
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    };
  }, [
    needsRatioPreview,
    previewSourceImage,
    activePreviewCropKey,
    settings.cropAuto,
    settings.cropX,
    settings.cropY,
    settings.cropWidth,
    settings.cropHeight,
  ]);

  const activeLocale = i18n.resolvedLanguage || i18n.language || undefined;
  const formatFileTimestamp = useMemo(
    () => createFileTimestampFormatter(activeLocale),
    [activeLocale]
  );

  const addImageFiles = (incoming: File[]) => {
    if (isProcessing || incoming.length === 0) return;
    const merged = mergeInputImageFiles(images, incoming);
    if (merged.addedCount > 0) {
      setImages(merged.files);
    }
    if (merged.addedCount > 0 || images.length === 0) {
      setProcessError(null);
    }
    setFileSelectionNotice(resolveFileSelectionNotice(merged));
  };

  /** Opens the native file picker via the hidden input; used by the upload button (mouse and keyboard). */
  const openFilePicker = () => {
    if (isProcessing) {
      return;
    }
    fileInputRef.current?.click();
  };

  /**
   * Lets a click anywhere in the empty-state drop zone open the file picker.
   * Clicks on the upload button (or bubbling from the hidden input) are skipped so the picker opens only once.
   */
  const handleDropZoneClick = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button, input')) {
      return;
    }
    openFilePicker();
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
    ratioPreviewKeyRef.current = null;
    setImages([]);
    setProcessedResult(null);
    setShareError(null);
    setFileSelectionNotice(null);
    setProcessError(null);
    setFileListExpanded(true);
    setPreviewOpen(false);
    setRequestedPreviewFile(null);
    setRenderedPreview(null);
    setRatioPreview(null);
  };

  const removeImageFile = (targetFile: File) => {
    const nextImages = images.filter((file) => file !== targetFile);
    if (
      nextImages.length === 0 ||
      ratioPreview?.sourceFile === targetFile ||
      ratioPreviewKeyRef.current?.file === targetFile
    ) {
      // Drop a ratio preview built from the removed image right away, so its File and blob URL
      // are released and reopening the mask section never flashes the removed image.
      ratioPreviewKeyRef.current = null;
      setRatioPreview(null);
    }
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
    // Reopened during the close animation: keep the newly opened preview. (MUI already skips
    // onExited in that case; this keeps it safe without relying on that.)
    if (previewOpen) return;
    previewRequestIdRef.current += 1;
    requestedPreviewFileRef.current = null;
    setRequestedPreviewFile(null);
    setRenderedPreview(null);
  };

  const handleRemovePreviewImage = () => {
    const targetFile = resolveRemovablePreviewTarget({
      orderedFiles: orderedImages,
      renderedFile: renderedPreview?.file ?? null,
      requestedFile: requestedPreviewFileRef.current,
    });
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

  const handleSliderChange = (name: 'quality') => (_event: Event, value: number | number[]) => {
    if (isProcessing || typeof value !== 'number' || settings[name] === value) {
      return;
    }
    setSettings((prev) => (prev[name] === value ? prev : { ...prev, [name]: value }));
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
    // This run outlives the render it started from, and `t` stays fixed to that render's
    // language. Messages kept in state therefore hold keys (msg) and are translated at render
    // time; strings needed right away use i18n.t, which follows the current language.
    // processAbortRef is set synchronously below, so it also blocks a second call made before
    // React re-renders with isProcessing (e.g. two calls in the same task).
    if (isProcessing || processAbortRef.current) return;
    if (images.length === 0) {
      reportProcessError(msg('alert_select_images_first'));
      return;
    }

    const validation = validateSettingsBeforeProcess(settings);
    if (!validation.valid) {
      reportProcessError(msg(validation.alertKey), {
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
    setShareError(null);
    setFileSelectionNotice(null);
    setProcessingProgress({ phase: 'preparing' });

    // When the previous run ended moments ago, first wait out its cooldown so mobile browsers
    // can hand back the previous canvas / OCR worker memory before this run allocates its own.
    // The previous result stays available meanwhile, so cancelling here keeps it.
    // A run cancelled mid-encode leaves the browser encoding its own full-size copy of that
    // montage. Wait for it to finish (then the montage cooldown below runs from that moment)
    // before this run allocates anything large, so the two never overlap in memory.
    // There is no time limit: a slow phone encode can run past any fixed limit, and the spec
    // always calls toBlob back. The wait shows its own status and can be cancelled.
    const abandonedEncode = abandonedMontageEncodeRef.current;
    if (abandonedEncode) {
      setProcessingProgress({ phase: 'waiting_encode', slow: false });
      // If toBlob never calls back, only a reload recovers, so say so after a long wait.
      const slowNoticeTimerId = setTimeout(() => {
        if (!signal.aborted && isMountedRef.current) {
          setProcessingProgress({ phase: 'waiting_encode', slow: true });
        }
      }, SLOW_ENCODE_WAIT_NOTICE_MS);
      await waitForSettleWithAbort(abandonedEncode, signal);
      clearTimeout(slowNoticeTimerId);
      if (!signal.aborted) {
        setProcessingProgress({ phase: 'preparing' });
      }
    }

    const rerunCooldownMs = getRerunCooldownRemainingMs(
      heavyResourceReleaseTimesRef.current,
      performance.now()
    );
    if (rerunCooldownMs > 0) {
      // Only await when there is something to wait for, so a normal run keeps clearing the
      // result and starting the 200ms timer in the same tick as the click.
      await waitWithAbort(rerunCooldownMs, signal);
    }
    if (!signal.aborted) {
      setProcessedResult(null);
    }
    // Let the UI update (e.g., show progress) and the previous result go before blocking the
    // main thread. Coming after the cooldown, this keeps back-to-back runs as far apart as the
    // old post-run lock did (cooldown + 200ms).
    await waitWithAbort(PROCESS_START_SETTLE_MS, signal);

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
          // Reuses masks already found for this first image and crop; only uncached sides run
          // OCR, and a full cache hit starts no worker (so no OCR cooldown either).
          return detectOcrMasksWithCache({
            cacheHolder: ocrMaskCacheRef,
            sourceKey: getFileKey(orderedImages[0]),
            cropRect,
            needsEnemyOcr,
            needsSelfOcr,
            detect: (sides) =>
              runOcrMaskDetection<Tesseract.Worker, HTMLCanvasElement, ImageBitmap>({
                sourceImage: sourceBitmap,
                cropRect,
                ...sides,
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
              }),
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
            reportProcessError(msg('alert_failed_to_get_temp_canvas_context_for_auto_crop'), uiTarget);
            break;
          case 'auto_crop_not_found':
            reportProcessError(msg('alert_failed_to_detect_crop_area'), uiTarget);
            break;
          case 'crop_outside_image':
            reportProcessError(
              msg('alert_crop_outside_image', {
                width: plan.alert.width,
                height: plan.alert.height,
              }),
              uiTarget
            );
            break;
          case 'invalid_mask_area':
            reportProcessError(msg('alert_invalid_mask_area'), uiTarget);
            break;
          case 'mask_outside_crop':
            reportProcessError(msg('alert_mask_outside_crop'), uiTarget);
            break;
          case 'mask_outside_image':
            reportProcessError(
              msg('alert_mask_outside_image', {
                width: plan.alert.width,
                height: plan.alert.height,
              }),
              uiTarget
            );
            break;
          case 'ocr_aborted':
            break;
          case 'ocr_error':
            console.error(plan.alert.error);
            reportProcessError(msg('alert_ocr_error'), uiTarget);
            break;
          case 'ocr_not_found':
            reportProcessError(
              [
                ...(plan.alert.enemyMissing ? [msg('alert_could_not_find_right_lv')] : []),
                ...(plan.alert.selfMissing ? [msg('alert_could_not_find_left_lv')] : []),
              ],
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
            msg('alert_webp_canvas_size', {
              width: sizeEval.width.toLocaleString(),
              height: sizeEval.height.toLocaleString(),
              maxWebpDimension: MAX_WEBP_DIMENSION.toLocaleString(),
            }),
            sizeUiTarget
          );
        } else {
          reportProcessError(
            msg('alert_invalid_canvas_size', { width: sizeEval.width, height: sizeEval.height }),
            sizeUiTarget
          );
        }
        return;
      }
      if (sizeEval.status === 'confirm_required') {
        // Release before blocking on user confirmation or allocating an oversized montage.
        releaseFirstImageBitmap();
        setProcessingProgress({ phase: 'confirming' });
        const confirmMessage = msg('confirm_large_canvas_size', {
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
        throw new Error(i18n.t('alert_canvas_not_ready'));
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
        if (renderResult.status === 'aborted' && renderResult.abandonedEncode) {
          trackAbandonedMontageEncode(renderResult.abandonedEncode);
        }
        return;
      }
      if (renderResult.status === 'context_failed') {
        throw new Error(i18n.t('alert_failed_to_get_context'));
      }
      if (renderResult.status === 'dimension_mismatch') {
        console.warn(
          `Encoded output dimension mismatch: expected ${sizeEval.width}x${sizeEval.height}, got ${renderResult.actualWidth}x${renderResult.actualHeight}`
        );
        reportProcessError(
          msg('alert_output_dimension_mismatch', {
            expectedWidth: sizeEval.width.toLocaleString(),
            expectedHeight: sizeEval.height.toLocaleString(),
            actualWidth: renderResult.actualWidth.toLocaleString(),
            actualHeight: renderResult.actualHeight.toLocaleString(),
          })
        );
        return;
      }
      if (renderResult.status === 'allocation_failed' || renderResult.status === 'encode_failed') {
        reportProcessError(msg('alert_image_generation_failed'));
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
        reportProcessError(msg('alert_image_decode_failed', { fileName: error.fileName }));
        return;
      }
      if (error instanceof ImageResolutionMismatchError) {
        console.warn(
          `Image resolution mismatch for "${error.fileName}": expected ${error.expectedWidth}x${error.expectedHeight}, got ${error.actualWidth}x${error.actualHeight}`
        );
        reportProcessError(
          msg('alert_image_resolution_mismatch', {
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
      alert(`${i18n.t('alert_processing_failed')}: ${errorMessage}`);

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
      await releaseOcrResources(ocrAbortRef, ocrSessionRef);
      // No wait here: the UI unlocks right away, and only a re-run started within the
      // cooldown waits for the remainder (see the start of processImages).
      heavyResourceReleaseTimesRef.current = updateHeavyResourceReleaseTimes(
        heavyResourceReleaseTimesRef.current,
        {
          ocrSessionStarted,
          montageCanvasUsed,
          reloadTriggered,
          now: performance.now(),
        }
      );
      if (isMountedRef.current) {
        setProcessingProgress(null);
        setIsCancelling(false);
        setIsProcessing(false);
      }
    }
  };

  const processingStatusText = (() => {
    if (!processingProgress) return '';
    if (isCancelling) {
      return t('status_cancelling');
    }
    switch (processingProgress.phase) {
      case 'waiting_encode':
        return t('status_waiting_cancelled_encode');
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

  const showSlowEncodeWaitNotice =
    !isCancelling &&
    processingProgress?.phase === 'waiting_encode' &&
    processingProgress.slow;

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
      isSharingRef.current ||
      typeof navigator === 'undefined' ||
      typeof navigator.share !== 'function'
    ) {
      return;
    }
    isSharingRef.current = true;
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
          setShareError(msg('alert_share_failed'));
        }
      }
    } finally {
      isSharingRef.current = false;
      if (isMountedRef.current) {
        setIsSharing(false);
      }
    }
  };

  // The file being navigated to. Title, counter and the prev/next buttons follow it, just like
  // handleStepPreview does, so they agree while its image is still loading.
  const activePreviewFile = requestedPreviewFile ?? renderedPreview?.file ?? null;
  // True until the image for activePreviewFile has loaded (or failed); the last image stays dimmed.
  const isPreviewLoading =
    activePreviewFile !== null && renderedPreview?.file !== activePreviewFile;
  const previewDimensions =
    renderedPreview && renderedPreview.file === activePreviewFile
      ? renderedPreview.dimensions
      : null;
  const previewLoadError =
    Boolean(renderedPreview && renderedPreview.file === activePreviewFile && renderedPreview.error);
  // Whether the dialog body shows an error or an image (a failed preview has no image URL).
  const hasPreviewBodyContent =
    previewLoadError || Boolean(renderedPreview && renderedPreview.url !== '');
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
  const canRemovePreviewImage =
    !isProcessing &&
    resolveRemovablePreviewTarget({
      orderedFiles: orderedImages,
      renderedFile: renderedPreview?.file ?? null,
      requestedFile: requestedPreviewFile,
    }) !== null;

  const maskAccordionPreview = resolveMaskAccordionPreviewState({
    hasImages: orderedImages.length > 0,
    previewSourceImage,
    activeCropKey: activePreviewCropKey,
    cachedPreview: ratioPreview,
  });

  return (
    <Container maxWidth="lg" sx={{ mt: { xs: 2, sm: 4 }, pb: { xs: 6, md: 20 }, minHeight: '100vh' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: { xs: 2, sm: 3 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 1.75 }, minWidth: 0 }}>
          <Box
            component="img"
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            aria-hidden="true"
            width={48}
            height={48}
            sx={{
              display: 'block',
              flexShrink: 0,
              width: { xs: 36, sm: 48 },
              height: { xs: 36, sm: 48 },
              filter: 'drop-shadow(0 4px 10px rgba(11, 94, 215, 0.28))',
            }}
          />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1, rowGap: 0.25 }}>
              <Typography
                variant="h4"
                component="h1"
                sx={{ fontSize: { xs: '1.25rem', sm: '1.625rem', md: '1.875rem' }, lineHeight: 1.2 }}
              >
                {t('title')}
              </Typography>
              <Box
                component="span"
                sx={{
                  flexShrink: 0,
                  px: 0.75,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 999,
                  color: 'text.secondary',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  lineHeight: 1.6,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                v{packageJson.version}
              </Box>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              {t('subtitle')}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.75, sm: 1 }, flexShrink: 0 }}>
          <LanguageButton />
          <ThemeModeButton />
        </Box>
      </Box>
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 5, lg: 4 }} sx={{ order: { xs: 2, md: 1 } }}>
          <Accordion expanded={expandedAccordions.settings} onChange={handleAccordionChange('settings')}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <SectionSummary
                icon={<TuneIcon />}
                title={t('settings')}
                meta={
                  <StatusPill>
                    {t('settings_summary', {
                      columnsLabel: t('columns'),
                      columns: settings.colCount,
                      format:
                        settings.outputFormat === 'png'
                          ? formatOutputFormatLabel('png')
                          : `${formatOutputFormatLabel(settings.outputFormat)} ${settings.quality}%`,
                    })}
                  </StatusPill>
                }
              />
            </AccordionSummary>
            <AccordionDetails>
              {/* Outlined field labels float above their box; extra top space keeps them clear of the header. */}
              <Grid container spacing={2} sx={{ pt: 2 }}>
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
              <SectionSummary
                icon={<CropIcon />}
                title={t('cropping')}
                meta={
                  <StatusPill active={settings.cropAuto}>
                    {settings.cropAuto ? t('auto_mode') : `${settings.cropWidth} × ${settings.cropHeight}`}
                  </StatusPill>
                }
              />
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
            icon={<MaskIcon />}
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
            ratioPreview={maskAccordionPreview}
            disabled={isProcessing}
            errorFields={processError?.fields}
            onSettingChange={handleSettingChange}
            onNumericCommit={handleNumericSettingCommit}
            onColorCommit={handleColorSettingCommit}
            onRatioSliderChange={(axis) => handleRatioSliderChange('maskRatioRect', axis)}
            onPresetChange={handlePresetChange('maskRatioRect')}
          />

          <MaskAccordion
            icon={<SelfMaskIcon />}
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
            ratioPreview={maskAccordionPreview}
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
            // `clip` instead of Card's default `hidden` so the drop message below can stay sticky in view.
            sx={{ position: 'relative', overflow: 'clip' }}
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
                  bgcolor: (muiTheme) => muiTheme.alpha((muiTheme.vars ?? muiTheme).palette.background.paper, 0.92),
                  pointerEvents: 'none',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 1,
                    color: 'primary.main',
                    // Centered in the card normally; on a card taller than the screen it stays within the
                    // middle band of the viewport instead of sitting off-screen.
                    position: 'sticky',
                    top: '30vh',
                    bottom: '30vh',
                  }}
                >
                  <AddPhotoOutlinedIcon sx={{ fontSize: 40 }} aria-hidden="true" />
                  <Typography variant="h6" color="primary" align="center">
                    {t('drop_images_here')}
                  </Typography>
                </Box>
              </Box>
            )}
            <CardContent>
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  columnGap: 1.5,
                  rowGap: 0.75,
                  mb: 2,
                }}
              >
                <Typography variant="h5" component="h2">{t('upload_and_process')}</Typography>
                <Box
                  sx={(muiTheme) => ({
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1,
                    py: 0.375,
                    borderRadius: 999,
                    color: (muiTheme.vars ?? muiTheme).palette.success.dark,
                    bgcolor: tint(muiTheme, 'success', 0.1),
                    ...muiTheme.applyStyles('dark', {
                      color: (muiTheme.vars ?? muiTheme).palette.success.light,
                      bgcolor: tint(muiTheme, 'success', 0.14),
                    }),
                  })}
                >
                  <LockOutlinedIcon sx={{ fontSize: 14, flexShrink: 0 }} aria-hidden="true" />
                  <Typography variant="caption" component="span" sx={{ fontWeight: 600, lineHeight: 1.4 }}>
                    {t('local_processing_notice')}
                  </Typography>
                </Box>
              </Box>
              <Box
                onClick={images.length === 0 ? handleDropZoneClick : undefined}
                sx={
                  images.length === 0
                    ? (muiTheme) => ({
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        textAlign: 'center',
                        px: 2,
                        py: { xs: 3, sm: 4 },
                        border: '2px dashed',
                        borderColor: tint(muiTheme, 'primary', 0.35),
                        borderRadius: '12px',
                        bgcolor: tint(muiTheme, 'primary', 0.04),
                        cursor: 'pointer',
                        transition: muiTheme.transitions.create(['border-color', 'background-color'], {
                          duration: muiTheme.transitions.duration.shorter,
                        }),
                        '&:hover': {
                          borderColor: tint(muiTheme, 'primary', 0.6),
                          bgcolor: tint(muiTheme, 'primary', 0.07),
                        },
                      })
                    : undefined
                }
              >
                {images.length === 0 && (
                  <>
                    <Box
                      aria-hidden="true"
                      sx={(muiTheme) => ({
                        width: 56,
                        height: 56,
                        mb: 1.5,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '50%',
                        color: 'primary.main',
                        bgcolor: tint(muiTheme, 'primary', 0.12),
                      })}
                    >
                      <AddPhotoOutlinedIcon sx={{ fontSize: 28 }} />
                    </Box>
                    <Typography variant="body1" sx={{ fontWeight: 600, mb: 2, textWrap: 'balance', wordBreak: 'auto-phrase' }}>
                      {t('upload_intro')}
                    </Typography>
                  </>
                )}
                <Button
                  variant={buttonVariants.upload}
                  fullWidth
                  size="large"
                  startIcon={<AddPhotoIcon />}
                  disabled={isProcessing}
                  onClick={openFilePicker}
                  sx={images.length === 0 ? { width: { sm: 'auto' }, minWidth: { sm: 260 }, px: { sm: 4 } } : undefined}
                >
                  {images.length > 0 ? t('add_images') : t('upload_images')}
                </Button>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: { xs: 'none', sm: 'block' },
                    mt: images.length === 0 ? 1.25 : 0.75,
                    textAlign: 'center',
                  }}
                >
                  {t('drop_zone_hint')}
                </Typography>
              </Box>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                accept="image/png, image/jpeg"
                multiple
                disabled={isProcessing}
                onChange={handleFileChange}
              />
              {fileSelectionNotice && (
                <Alert
                  ref={fileSelectionNoticeRef}
                  severity={fileSelectionNotice.severity}
                  onClose={() => setFileSelectionNotice(null)}
                  closeText={t('close')}
                  sx={{ mt: 1.5 }}
                >
                  {'params' in fileSelectionNotice
                    ? t(fileSelectionNotice.messageKey, fileSelectionNotice.params)
                    : t(fileSelectionNotice.messageKey)}
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
                                // ButtonBase removes the native focus ring; show which row has keyboard focus.
                                '&.Mui-focusVisible': {
                                  bgcolor: 'action.hover',
                                  outline: (muiTheme) => `2px solid ${(muiTheme.vars ?? muiTheme).palette.primary.main}`,
                                  outlineOffset: -2,
                                },
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
                    isProcessing ? (
                      <CircularProgress size={20} color="inherit" />
                    ) : (
                      <PlayArrow />
                    )
                  }
                  sx={{ flex: 1 }}
                >
                  {isProcessing ? t('processing') : t('process_images')}
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
                  closeText={t('close')}
                  sx={{ mt: 2, whiteSpace: 'pre-line' }}
                >
                  {processError.lines.map((line) => t(line.key, line.params)).join('\n')}
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
                {isProcessing && processingStatusText && (
                  <LinearProgress
                    variant={drawingProgress ? 'determinate' : 'indeterminate'}
                    value={
                      drawingProgress
                        ? (drawingProgress.current / drawingProgress.total) * 100
                        : undefined
                    }
                    aria-label={processingStatusText}
                    sx={{ mt: 0.75 }}
                  />
                )}
              </Box>
              {showSlowEncodeWaitNotice && (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  {t('alert_cancelled_encode_slow')}
                  <Box sx={{ mt: 1 }}>
                    <Button
                      variant="outlined"
                      color="inherit"
                      size="small"
                      onClick={() => window.location.reload()}
                      sx={{ whiteSpace: 'nowrap' }}
                    >
                      {t('reload_page')}
                    </Button>
                  </Box>
                </Alert>
              )}
              {processedResult && (
                <Box sx={{ mt: 3, pt: 2.5, borderTop: 1, borderColor: 'divider', overflowAnchor: 'none' }} ref={resultRef}>
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
                      closeText={t('close')}
                      sx={{ mt: 1.5 }}
                    >
                      {t(shareError.key, shareError.params)}
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
            {largeCanvasConfirm.message &&
              t(largeCanvasConfirm.message.key, largeCanvasConfirm.message.params)}
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
          aria-busy={isPreviewLoading || undefined}
          sx={{
            position: 'relative',
            px: { xs: 1.5, sm: 2.5 },
            py: { xs: 1.5, sm: 2 },
            height: { xs: 'auto', sm: '62vh' },
            // On phones the body is as tall as its image or error. With neither (first open, or
            // stepping on from a failed image) keep room for the loading spinner.
            minHeight: { xs: hasPreviewBodyContent ? 0 : 160, sm: 320 },
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
                  opacity: isPreviewLoading ? 0.4 : 1,
                  transition: 'opacity 120ms',
                }}
              />
            )
          )}
          {isPreviewLoading && (
            <CircularProgress
              size={32}
              aria-hidden="true"
              sx={{ position: 'absolute', top: '50%', left: '50%', mt: -2, ml: -2 }}
            />
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
            disabled={!canRemovePreviewImage}
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
