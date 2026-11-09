import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

export function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="min-h-screen grid place-items-center p-6 text-center text-slate-300">
      {children}
    </div>
  )
}

/** Ruta privada: sin sesión → /login guardando la ruta exacta (con su query string). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()
  // Mientras se verifica la sesión NO se muestra el login.
  if (status === 'checking') return <FullScreenMessage>Verificando sesión…</FullScreenMessage>
  if (status === 'anonymous') {
    const from = location.pathname + location.search + location.hash
    return <Navigate to="/login" replace state={{ from }} />
  }
  return <>{children}</>
}

/** Ruta que exige un permiso: si no lo tiene, página "sin permiso". */
export function RequirePerm({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth()
  if (!can(perm)) return <Forbidden perm={perm} />
  return <>{children}</>
}

export function Forbidden({ perm }: { perm?: string }) {
  return (
    <main className="p-8 max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Sin permiso</h1>
      <p className="text-slate-300">
        Tu rol no tiene acceso a esta sección{perm ? ` (requiere ${perm})` : ''}.
      </p>
      <a href="/files" className="inline-block mt-4 underline text-sky-300">Volver a los archivos</a>
    </main>
  )
}
