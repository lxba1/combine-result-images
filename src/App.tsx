import './App.css'
import ImageProcessor from './ImageProcessor'
import React from 'react'
import { CssBaseline } from '@mui/material'

function App() {

  return (
    <React.Suspense fallback="Loading...">
      <CssBaseline />
      <ImageProcessor />
    </React.Suspense>
  )
}

export default App
