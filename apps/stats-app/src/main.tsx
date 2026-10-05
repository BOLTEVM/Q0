import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyVerifiedLocalDeployments } from 'quai-service/bootstrap'
import './index.css'

// Contract addresses decide where swaps, stakes and deposits are sent, so anything remembered from a deployment
// made in this browser is checked against the chain BEFORE the app (and the registries that read those
// addresses at load) is imported. A failed check only drops that address; it never blocks the app.
async function start() {
  try {
    await applyVerifiedLocalDeployments()
  } catch {
    /* an unreachable node must not stop the app from starting */
  }
  const { default: App } = await import('./App.tsx')
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

start()
