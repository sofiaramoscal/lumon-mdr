import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FullScreenMessage, RequireAuth, RequirePerm } from './components/Guards'
import { HealthGate } from './components/HealthGate'
import { Layout } from './components/Layout'
import { LoginPage, NotFoundPage, RegisterPage } from './pages/AuthPages'

// Code splitting: la grilla y las páginas privadas no están en el bundle inicial de /login
const FilesPage = lazy(() => import('./pages/FilesPage'))
const RefinePage = lazy(() => import('./refine/RefinePage'))
const EstadoPage = lazy(() => import('./pages/EstadoPage'))

export default function App() {
  return (
    <ErrorBoundary>
      <HealthGate>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<FullScreenMessage>Cargando…</FullScreenMessage>}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route element={<RequireAuth><Layout /></RequireAuth>}>
                  <Route path="/" element={<Navigate to="/files" replace />} />
                  <Route path="/files" element={<RequirePerm perm="files:read"><FilesPage /></RequirePerm>} />
                  <Route path="/files/:id/refine" element={<RequirePerm perm="files:read"><RefinePage /></RequirePerm>} />
                  <Route path="/estado" element={<EstadoPage />} />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </HealthGate>
    </ErrorBoundary>
  )
}
