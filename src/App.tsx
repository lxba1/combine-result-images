import './App.css'
import ImageProcessor from './ImageProcessor'
import React from 'react'
import { Box, CircularProgress, CssBaseline } from '@mui/material'
import { ThemeProvider } from '@mui/material/styles'
import { appTheme, useThemeColorMetaSync } from './theme'

/** Mirrors the active color scheme into the browser toolbar color; renders nothing. */
function ThemeColorMetaSync() {
  useThemeColorMetaSync()
  return null
}

function App() {

  return (
    <ThemeProvider theme={appTheme} defaultMode="system" disableTransitionOnChange>
      <CssBaseline enableColorScheme />
      <ThemeColorMetaSync />
      <React.Suspense
        fallback={
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              minHeight: '100vh',
            }}
          >
            <CircularProgress aria-label="Loading" />
          </Box>
        }
      >
        <ImageProcessor />
      </React.Suspense>
    </ThemeProvider>
  )
}

export default App
