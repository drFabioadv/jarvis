import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { BACKEND } from './config'
import { NuvemPortao } from './ui/NuvemPortao'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
// No JARVIS 3.0 (build --mode cloud), a porta de entrada do proprietário vem antes.
createRoot(document.getElementById('root')!).render(
  BACKEND === 'cloud' ? (
    <NuvemPortao>
      <App />
    </NuvemPortao>
  ) : (
    <App />
  ),
)
