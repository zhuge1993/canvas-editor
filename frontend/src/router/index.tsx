import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthPage from '@/pages/Auth'
import EditorPage from '@/pages/Editor'
import HomePage from '@/pages/Home'
import AdminPage from '@/pages/Admin'
import ManagementPage from '@/pages/Management'
import NotificationsPage from '@/pages/Management/NotificationsPage'
import ProjectPage from '@/pages/Management/ProjectPage'
import ProjectInvitePage from '@/pages/Management/ProjectInvitePage'
import WorkspaceShell from '@/components/workspace/WorkspaceShell'
import VoiceWorkspace from '@/components/voice/VoiceWorkspace'

export default function AppRouter() {
  return <BrowserRouter><VoiceWorkspace /><Routes>
    <Route path="/auth" element={<AuthPage />} />
    <Route path="/register" element={<AuthPage />} />
    <Route path="/project-invite/:token" element={<ProjectInvitePage />} />
    <Route element={<WorkspaceShell />}>
      <Route path="/" element={<HomePage />} />
      <Route path="/canvases" element={<HomePage />} />
      <Route path="/projects" element={<ManagementPage />} />
      <Route path="/projects/:projectId" element={<ProjectPage />} />
      <Route path="/notifications" element={<NotificationsPage />} />
    </Route>
    <Route path="/editor" element={<EditorPage />} />
    <Route path="/editor/:docId" element={<EditorPage />} />
    <Route path="/share/:shareToken" element={<EditorPage />} />
    <Route path="/admin" element={<AdminPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>
}
