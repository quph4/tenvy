import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

async function boot() {
  // `?demo` in development: made-up content for screenshots (src/demo).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
    const demo = await import('./demo/mock')
    demo.installDemo()
    setTimeout(demo.applyScene, 0)
  }
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

boot()
