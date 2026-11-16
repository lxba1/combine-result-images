import './App.css'
import ImageProcessor from './ImageProcessor'
import React from 'react'
import { Box, CircularProgress, CssBaseline } from '@mui/material'
import { ThemeProvider, createTheme } from '@mui/material/styles'

const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: 'data',
  },
  colorSchemes: {
    light: true,
    dark: true,
  },
})

function App() {

  return (
    <ThemeProvider theme={theme} defaultMode="system" disableTransitionOnChange>
      <CssBaseline enableColorScheme />
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
