import { useEffect } from 'react';
import { createTheme, useColorScheme } from '@mui/material/styles';

/**
 * Page background per color scheme. Also used as the mobile browser toolbar color;
 * keep the static `theme-color` tags in index.html in sync with these values.
 */
export const PAGE_BACKGROUND = {
  light: '#F3F5F9',
  dark: '#0D1117',
} as const;

/**
 * System font stack tuned for mixed Japanese / Latin UI text.
 * Uses locally installed fonts only so no font files are fetched from external servers.
 */
const FONT_FAMILY = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  '"Hiragino Sans"',
  '"Hiragino Kaku Gothic ProN"',
  '"Noto Sans JP"',
  '"Yu Gothic UI"',
  'Meiryo',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  'sans-serif',
].join(',');

/** Corner radius for top-level surfaces (cards, accordions). Inputs and buttons use `shape.borderRadius`. */
export const SURFACE_RADIUS = 14;

/** App-wide MUI theme: brand blue taken from the favicon, flat bordered surfaces, light/dark schemes. */
export const appTheme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'data',
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#0B5ED7', light: '#4C8DF0', dark: '#0848A8', contrastText: '#FFFFFF' },
        background: { default: PAGE_BACKGROUND.light, paper: '#FFFFFF' },
        text: { primary: '#111827', secondary: '#4B5563' },
        divider: 'rgba(17, 24, 39, 0.11)',
      },
    },
    dark: {
      palette: {
        primary: { main: '#5AA9FF', light: '#8CC4FF', dark: '#2F80E0', contrastText: '#03152B' },
        background: { default: PAGE_BACKGROUND.dark, paper: '#161B22' },
        text: { primary: '#E6EAF0', secondary: '#9AA4B2' },
        divider: 'rgba(230, 234, 240, 0.12)',
      },
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily: FONT_FAMILY,
    h4: { fontWeight: 700, letterSpacing: '-0.01em' },
    h5: { fontWeight: 700, fontSize: '1.25rem', lineHeight: 1.4, fontFeatureSettings: '"palt"' },
    h6: { fontWeight: 700, fontSize: '1.0625rem', lineHeight: 1.45, fontFeatureSettings: '"palt"' },
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: '0.01em' },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: (theme) => ({
        body: {
          backgroundImage: `radial-gradient(ellipse 90% 360px at 50% -120px, ${theme.alpha(
            (theme.vars ?? theme).palette.primary.main,
            0.11,
          )}, transparent)`,
          backgroundRepeat: 'no-repeat',
        },
      }),
    },
    MuiPaper: {
      styleOverrides: {
        // Drop the dark-mode elevation overlay so surfaces use the exact palette colors.
        root: { backgroundImage: 'none' },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: SURFACE_RADIUS,
          border: `1px solid ${(theme.vars ?? theme).palette.divider}`,
          boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05), 0 4px 16px -6px rgba(16, 24, 40, 0.08)',
          ...theme.applyStyles('dark', { boxShadow: 'none' }),
        }),
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: ({ theme }) => ({
          padding: theme.spacing(2),
          [theme.breakpoints.up('sm')]: { padding: theme.spacing(3) },
          '&:last-child': {
            paddingBottom: theme.spacing(2),
            [theme.breakpoints.up('sm')]: { paddingBottom: theme.spacing(3) },
          },
        }),
      },
    },
    MuiAccordion: {
      // No gutters: expanding a section no longer shifts the surrounding layout.
      defaultProps: { elevation: 0, disableGutters: true },
      styleOverrides: {
        root: ({ theme }) => ({
          border: `1px solid ${(theme.vars ?? theme).palette.divider}`,
          boxShadow: '0 1px 2px rgba(16, 24, 40, 0.04)',
          ...theme.applyStyles('dark', { boxShadow: 'none' }),
          '&::before': { display: 'none' },
        }),
        rounded: {
          borderRadius: SURFACE_RADIUS,
          '&:first-of-type, &:last-of-type': { borderRadius: SURFACE_RADIUS },
        },
      },
    },
    MuiAccordionSummary: {
      styleOverrides: {
        root: ({ theme }) => {
          /** Neutral header tint: light-scheme opacity, dark-scheme opacity (dark needs a bit more to show). */
          const headerTint = (light: number, dark: number) => ({
            backgroundColor: theme.alpha((theme.vars ?? theme).palette.text.primary, light),
            ...theme.applyStyles('dark', {
              backgroundColor: theme.alpha((theme.vars ?? theme).palette.text.primary, dark),
            }),
          });
          return {
            minHeight: 56,
            paddingLeft: theme.spacing(2),
            paddingRight: theme.spacing(2),
            // Match the accordion's inner corners so hover / keyboard-focus backgrounds don't poke out.
            borderRadius: SURFACE_RADIUS - 1,
            '&.Mui-expanded': { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
            // The open section's header is lightly tinted to separate it from its content.
            // Collapsed headers stay plain so closed sections keep the light card look.
            '&.Mui-expanded:not(.Mui-focusVisible)': headerTint(0.045, 0.06),
            // Keyboard focus: keep MUI's focus background and add the same inset outline as the file list rows.
            '&.Mui-focusVisible': {
              outline: `2px solid ${(theme.vars ?? theme).palette.primary.main}`,
              outlineOffset: -2,
            },
            // Hover feedback only on devices with a real hover, so it doesn't stick after a tap.
            // Skipped while focus-visible so it never masks the keyboard focus background.
            '@media (hover: hover)': {
              '&:hover:not(.Mui-disabled):not(.Mui-focusVisible)': {
                backgroundColor: (theme.vars ?? theme).palette.action.hover,
              },
              // An open header is already tinted, so its hover goes one step darker.
              '&.Mui-expanded:hover:not(.Mui-disabled):not(.Mui-focusVisible)': headerTint(0.08, 0.1),
            },
          };
        },
        content: {
          margin: '10px 0',
          minWidth: 0,
        },
      },
    },
    MuiAccordionDetails: {
      styleOverrides: {
        root: ({ theme }) => ({
          padding: theme.spacing(0.5, 2, 2.5),
        }),
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 10 },
        sizeLarge: { minHeight: 48, fontSize: '0.975rem' },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { borderRadius: 8 },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10 },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { height: 6, borderRadius: 999 },
        bar: { borderRadius: 999 },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 16,
          border: `1px solid ${(theme.vars ?? theme).palette.divider}`,
        }),
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: ({ theme }) => ({
          borderRadius: 10,
          border: `1px solid ${(theme.vars ?? theme).palette.divider}`,
        }),
      },
    },
  },
});

/**
 * Keeps `<meta name="theme-color">` (the mobile browser toolbar color) in line with the active color scheme,
 * including a manual light/dark choice that differs from the OS setting. Must run inside the ThemeProvider.
 * The static tags in index.html cover the first paint before this runs.
 */
export const useThemeColorMetaSync = (): void => {
  const { mode, systemMode } = useColorScheme();
  const activeScheme = mode === 'system' ? systemMode : mode;

  useEffect(() => {
    if (activeScheme !== 'light' && activeScheme !== 'dark') {
      return;
    }
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = PAGE_BACKGROUND[activeScheme];
    });
  }, [activeScheme]);
};
