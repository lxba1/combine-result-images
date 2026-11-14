import './App.css'
import ImageProcessor from './ImageProcessor'
import React from 'react'
import { CssBaseline } from '@mui/material'
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
      <React.Suspense fallback="Loading...">
        <ImageProcessor />
      </React.Suspense>
    </ThemeProvider>
  )
}

export default App
