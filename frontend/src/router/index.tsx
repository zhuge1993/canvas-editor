import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthPage from '@/pages/Auth'
import EditorPage from '@/pages/Editor'
import HomePage from '@/pages/Home'
import AdminPage from '@/pages/Admin'

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/register" element={<AuthPage />} />
        <Route path="/" element={<HomePage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/editor/:docId" element={<EditorPage />} />
        <Route path="/share/:shareToken" element={<EditorPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}