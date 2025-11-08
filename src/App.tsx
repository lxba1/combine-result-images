import './App.css'
import ImageProcessor from './ImageProcessor'
import React from 'react'

function App() {

  return (
    <React.Suspense fallback="Loading...">
      <ImageProcessor />
    </React.Suspense>
  )
}

export default App
