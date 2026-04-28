import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

// Intentionally NOT in <StrictMode> — double-invoking useEffect interferes with
// the useChat session-load lifecycle (each mount disconnects the previous WS
// and can race with in-flight session-load RPCs, leaving initStatus stuck at
// 'connecting'). The upstream roj-platform demo also runs outside StrictMode.
createRoot(document.getElementById('root')!).render(<App />)
