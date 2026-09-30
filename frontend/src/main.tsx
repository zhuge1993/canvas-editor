import { createRoot } from 'react-dom/client'
import App from './App'
import { installGlobalErrorLogging } from './utils/logger'
import { useEditorStore } from './store/useEditorStore'
import './index.css'


installGlobalErrorLogging()

// 主题：从 localStorage 恢复并应用到 <html data-theme>
function applyTheme() {
  const theme = useEditorStore.getState().theme
  document.documentElement.dataset.theme = theme
}
applyTheme()
useEditorStore.subscribe((state) => {
  if (state.theme !== document.documentElement.dataset.theme) {
    document.documentElement.dataset.theme = state.theme
  }
})

createRoot(document.getElementById('root')!).render(<App />)