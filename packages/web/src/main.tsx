import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ClientProviders } from './routes/client-providers'
import './routes/globals.css'

const ChatPage = lazy(() => import('./routes/chat/page'))
const CronPage = lazy(() => import('./routes/cron/page'))
const KanbanPage = lazy(() => import('./routes/kanban/page'))
const LogsPage = lazy(() => import('./routes/logs/page'))
const OrgPage = lazy(() => import('./routes/org/page'))
const SettingsPage = lazy(() => import('./routes/settings/page'))
const SkillsPage = lazy(() => import('./routes/skills/page'))

function App() {
  return (
    <BrowserRouter>
      <ClientProviders>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/chat" element={<Navigate to="/" replace />} />
            <Route path="/cron" element={<CronPage />} />
            <Route path="/kanban" element={<KanbanPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/org" element={<OrgPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
          </Routes>
        </Suspense>
      </ClientProviders>
    </BrowserRouter>
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(<App />)
