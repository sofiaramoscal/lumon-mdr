import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api, API_BASE, ApiError, BUILD_SHA, errorText } from '../lib/http'

/** /estado: build desplegado, salud de la API, integraciones, clearance y revisión automática. */
export default function EstadoPage() {
  const { me, can, reloadMe } = useAuth()
  const [health, setHealth] = useState<'ok' | 'down' | 'checking'>('checking')
  const [integrations, setIntegrations] = useState<unknown>(null)
  const [clearance, setClearance] = useState<unknown>(null)
  const [checkResult, setCheckResult] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    fetch(`${API_BASE}/meta/health`, { headers: { 'X-Lumon-Build': BUILD_SHA } })
      .then((r) => setHealth(r.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'))
    const [i, c] = await Promise.allSettled([api<unknown>('/integrations/status'), api<unknown>('/clearance')])
    if (i.status === 'fulfilled') setIntegrations(i.value)
    else setErr(errorText(i.reason))
    if (c.status === 'fulfilled') setClearance(c.value)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function run(label: string, fn: () => Promise<unknown>, after?: (v: unknown) => void) {
    setBusy(label)
    setErr(null)
    try {
      const v = await fn()
      after?.(v)
      await load()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="p-4 max-w-3xl mx-auto w-full space-y-6">
      <h1 className="text-2xl font-bold">Estado</h1>
      <section className="grid sm:grid-cols-2 gap-3">
        <Info label="Build desplegado" value={BUILD_SHA} />
        <Info label="API" value={health === 'ok' ? 'Responde' : health === 'down' ? 'No responde' : 'Verificando…'} />
        <Info label="Cuadrilla" value={`${me?.team.code ?? '—'} · ${me?.team.name ?? ''}`} />
        <Info label="Clearance (Piso de Pruebas)" value={me?.clearance.granted ? 'Abierto' : 'Cerrado'} />
      </section>

      {err && <p role="alert" className="p-3 rounded bg-red-950 border border-red-800">{err}</p>}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Revisión automática</h2>
        <button
          disabled={busy !== null}
          onClick={() => void run('check', () => api('/clearance/check', { method: 'POST' }), (v) => { setCheckResult(v); void reloadMe() })}
          className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
        >
          {busy === 'check' ? 'Revisando…' : 'Abrir el Piso de Pruebas'}
        </button>
        {checkResult !== null && <Json value={checkResult} />}
        <h3 className="font-semibold mt-3">Clearance y rondas</h3>
        <Json value={clearance} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Integraciones</h2>
        <Json value={integrations} />
        {can('team:manage') && <RosterForm />}
        {can('team:manage') && <DeployVerify run={run} busy={busy} />}
        {can('team:manage') && <Chaos run={run} busy={busy} />}
      </section>
    </main>
  )
}

type Runner = (label: string, fn: () => Promise<unknown>, after?: (v: unknown) => void) => Promise<void>

function DeployVerify({ run, busy }: { run: Runner; busy: string | null }) {
  const [origin, setOrigin] = useState(window.location.origin)
  const [challenge, setChallenge] = useState<unknown>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run('challenge', () => api('/integrations/deploy/challenge', { method: 'POST', body: { origin } }), setChallenge)
  }
  return (
    <div className="p-3 rounded border border-slate-700 space-y-2">
      <h3 className="font-semibold">Verificar dominio</h3>
      <form onSubmit={submit} className="flex flex-wrap gap-2 items-end">
        <div>
          <label htmlFor="origin" className="block text-sm">Origen</label>
          <input id="origin" value={origin} onChange={(e) => setOrigin(e.target.value)} className="px-2 py-1 rounded bg-slate-800 border border-slate-600 w-72" />
        </div>
        <button disabled={busy !== null} className="px-3 py-1.5 rounded bg-slate-700">1. Pedir token</button>
        <button type="button" disabled={busy !== null} onClick={() => void run('verify', () => api('/integrations/deploy/verify', { method: 'POST', body: { origin } }), setChallenge)} className="px-3 py-1.5 rounded bg-slate-700">
          3. Verificar
        </button>
      </form>
      <p className="text-sm text-slate-300">Paso 2: pegar el token en public/.well-known/lumon-verification.txt, commit y deploy.</p>
      {challenge !== null && <Json value={challenge} />}
    </div>
  )
}

function Chaos({ run, busy }: { run: Runner; busy: string | null }) {
  const [level, setLevel] = useState<number | null>(null)
  return (
    <div className="p-3 rounded border border-slate-700 flex flex-wrap gap-2 items-center">
      <span className="font-semibold">Modo caos:</span>
      {[0, 1, 2].map((l) => (
        <button
          key={l}
          disabled={busy !== null}
          aria-pressed={level === l}
          onClick={() => void run('chaos', () => api('/workspace/chaos', { method: 'PUT', body: { level: l } }), () => setLevel(l))}
          className={`px-3 py-1 rounded ${level === l ? 'bg-emerald-700' : 'bg-slate-700'}`}
        >
          {l}
        </button>
      ))}
      <span role="status" className="text-sm text-slate-300">
        {busy === 'chaos' ? 'Aplicando…' : level !== null ? `Caos activado en nivel ${level}` : ''}
      </span>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded bg-slate-900 border border-slate-800">
      <p className="text-sm text-slate-300">{label}</p>
      <p className="font-mono">{value}</p>
    </div>
  )
}

function Json({ value }: { value: unknown }) {
  // Se muestra como texto (nunca se interpreta HTML de los datos)
  return <pre className="text-xs bg-slate-900 p-3 rounded overflow-auto max-h-80 whitespace-pre-wrap">{value === null ? '—' : JSON.stringify(value, null, 2)}</pre>
}

interface RosterMember { name: string; code: string }
interface Roster { members: RosterMember[]; complete: boolean; locked: boolean }

/** Inscripción de los tres integrantes (PUT /team/roster). */
function RosterForm() {
  const [members, setMembers] = useState<RosterMember[]>([
    { name: '', code: '' },
    { name: '', code: '' },
    { name: '', code: '' },
  ])
  const [roster, setRoster] = useState<Roster | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<Roster>('/team/roster')
      .then((r) => {
        setRoster(r)
        if (r.members.length) {
          const filled = [...r.members]
          while (filled.length < 3) filled.push({ name: '', code: '' })
          setMembers(filled.slice(0, 3))
        }
      })
      .catch(() => {})
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    setFieldErrors({})
    try {
      const r = await api<Roster>('/team/roster', { method: 'PUT', body: { members } })
      setRoster(r)
      setMsg('Roster guardado ✓')
    } catch (err) {
      setMsg(errorText(err))
      if (err instanceof ApiError && err.details && typeof err.details.fields === 'object' && err.details.fields) {
        setFieldErrors(err.details.fields as Record<string, string>)
      }
    } finally {
      setSaving(false)
    }
  }

  const set = (i: number, k: keyof RosterMember, v: string) =>
    setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, [k]: v } : m)))

  return (
    <form onSubmit={save} className="p-3 rounded border border-slate-700 space-y-2">
      <h3 className="font-semibold">Roster (los tres integrantes)</h3>
      {roster && (
        <p className="text-sm text-slate-300">
          {roster.complete ? 'Roster completo' : 'Roster incompleto'}
          {roster.locked ? ' · bloqueado (ya entró a un sorteo)' : ''}
        </p>
      )}
      {members.map((m, i) => (
        <div key={i} className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor={`rn${i}`}>Nombre del integrante {i + 1}</label>
          <input id={`rn${i}`} placeholder="Nombre y apellido" value={m.name} disabled={roster?.locked} onChange={(e) => set(i, 'name', e.target.value)} className="px-2 py-1 rounded bg-slate-800 border border-slate-600 flex-1 min-w-40" />
          <label className="sr-only" htmlFor={`rc${i}`}>Código UTEC del integrante {i + 1}</label>
          <input id={`rc${i}`} placeholder="Código UTEC" value={m.code} disabled={roster?.locked} onChange={(e) => set(i, 'code', e.target.value)} className="px-2 py-1 rounded bg-slate-800 border border-slate-600 w-36" />
        </div>
      ))}
      {Object.entries(fieldErrors).map(([k, v]) => (
        <p key={k} className="text-sm text-red-300">{k}: {v}</p>
      ))}
      <button disabled={saving || roster?.locked} className="px-3 py-1.5 rounded bg-emerald-700 disabled:opacity-50">
        {saving ? 'Guardando…' : 'Guardar roster'}
      </button>
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </form>
  )
}
