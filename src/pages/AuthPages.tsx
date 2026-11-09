import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ApiError, errorText } from '../lib/http'

function useFrom(): string {
  const location = useLocation()
  const state = location.state as { from?: string } | null
  return state?.from ?? '/files'
}

export function LoginPage() {
  const { login, status, notice } = useAuth()
  const navigate = useNavigate()
  const from = useFrom()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (status === 'authenticated') return <Navigate to={from} replace />

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await login(email, password)
      navigate(from, { replace: true }) // vuelve EXACTAMENTE a donde quería ir
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 bg-slate-900 p-6 rounded-lg border border-slate-800">
        <h1 className="text-2xl font-bold">Entrar al piso</h1>
        {notice && <p role="alert" className="text-amber-300 text-sm">{notice}</p>}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <Field label="Contraseña" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
        <button disabled={loading} className="w-full py-2 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50">
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        <p className="text-sm text-slate-300">
          ¿Cuadrilla nueva? <Link to="/register" className="underline text-sky-300">Registrar cuadrilla</Link>
        </p>
      </form>
    </main>
  )
}

type FieldErrors = Record<string, string>

/** Convierte los errores del servidor en errores por campo. */
function fieldErrorsFrom(err: unknown): { fields: FieldErrors; general: string | null } {
  if (!(err instanceof ApiError)) return { fields: {}, general: errorText(err) }
  const fields: FieldErrors = {}
  const d = err.details
  if (d) {
    const raw = (d.fields ?? d.errors ?? d) as unknown
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === 'object' && 'field' in item) {
          const it = item as { field: string; message?: string }
          fields[it.field] = it.message ?? 'Valor inválido'
        }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string') fields[k] = v
      }
    }
    if (typeof d.field === 'string') fields[d.field] = err.message
  }
  const code = err.code.toUpperCase()
  if (Object.keys(fields).length === 0) {
    if (code.includes('EMAIL')) fields.email = err.message
    else if (code.includes('TEAM') || code.includes('NAME')) fields.teamName = err.message
  }
  return { fields, general: Object.keys(fields).length ? null : errorText(err) }
}

export function RegisterPage() {
  const { register, status } = useAuth()
  const navigate = useNavigate()
  const [teamName, setTeamName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [general, setGeneral] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (status === 'authenticated' && !loading) return <Navigate to="/files" replace />

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setErrors({})
    setGeneral(null)
    try {
      await register({ teamName, email, password })
      navigate('/estado', { replace: true }) // entra directo con la sesión iniciada
    } catch (err) {
      const r = fieldErrorsFrom(err)
      setErrors(r.fields)
      setGeneral(r.general)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <form onSubmit={onSubmit} noValidate className="w-full max-w-sm space-y-4 bg-slate-900 p-6 rounded-lg border border-slate-800">
        <h1 className="text-2xl font-bold">Registrar cuadrilla</h1>
        <Field label="Nombre del equipo" value={teamName} onChange={setTeamName} error={errors.teamName ?? errors.name} />
        <Field label="Email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
        <Field label="Contraseña" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="new-password" />
        {general && <p role="alert" className="text-red-300 text-sm">{general}</p>}
        <button disabled={loading} className="w-full py-2 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-50">
          {loading ? 'Registrando…' : 'Registrar'}
        </button>
        <p className="text-sm text-slate-300">
          ¿Ya tienes cuenta? <Link to="/login" className="underline text-sky-300">Entrar</Link>
        </p>
      </form>
    </main>
  )
}

function Field(props: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  error?: string
  autoComplete?: string
}) {
  const id = `f-${props.label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <div>
      <label htmlFor={id} className="block text-sm mb-1">{props.label}</label>
      <input
        id={id}
        type={props.type ?? 'text'}
        value={props.value}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={!!props.error}
        aria-describedby={props.error ? `${id}-err` : undefined}
        className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 focus:outline-2 focus:outline-sky-400"
      />
      {props.error && <p id={`${id}-err`} className="text-red-300 text-sm mt-1">{props.error}</p>}
    </div>
  )
}

export function NotFoundPage() {
  return (
    <main className="min-h-screen grid place-items-center p-6 text-center">
      <div>
        <h1 className="text-4xl font-bold mb-2">404</h1>
        <p className="text-slate-300 mb-4">Esta sala no existe en el piso separado.</p>
        <Link to="/files" className="underline text-sky-300">Volver a los archivos</Link>
      </div>
    </main>
  )
}
