import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource-variable/inter'
import './styles/base.css'
import './styles/shell.css'
import './styles/library.css'

async function start(): Promise<void> {
  // Outside Electron (plain browser during UI work) there is no bridge: use fake data.
  if (!window.gamekins && import.meta.env.DEV) (await import('./lib/devMock')).installDevMock()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void start()
