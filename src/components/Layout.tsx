import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ErrorBoundary } from './ErrorBoundary'

export function Layout() {
  const { me, logout, can } = useAuth()
  const location = useLocation()
  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1 rounded ${isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:text-white'}`
  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-slate-800 bg-slate-900">
        <span className="font-bold tracking-wide text-sky-300">LUMON · MDR</span>
        <nav aria-label="Principal" className="flex gap-1">
          {can('files:read') && <NavLink to="/files" className={link}>Archivos</NavLink>}
          <NavLink to="/estado" className={link}>Estado</NavLink>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-slate-300">
            {me?.team.code} · {me?.role.name}
          </span>
          <button className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600" onClick={() => void logout()}>
            Cerrar sesión
          </button>
        </div>
      </header>
      <ErrorBoundary resetKey={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </div>
  )
}
