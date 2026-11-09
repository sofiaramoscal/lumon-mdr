import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api, errorText } from '../lib/http'
import { progressPercent, toPage, type FileSummary, type Page } from '../lib/types'
import { useDebounce } from '../lib/useDebounce'

const STATUSES = ['', 'PENDING', 'IN_PROGRESS', 'COMPLETED']
const SORTS = ['name,asc', 'name,desc', 'createdAt,desc', 'createdAt,asc', 'progress,desc', 'progress,asc']
const SIZES = [10, 20, 50]

/** Lee y valida la URL: una URL inválida cae a valores por defecto, nunca rompe la vista. */
function readParams(sp: URLSearchParams) {
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1)
  const sizeRaw = Number.parseInt(sp.get('size') ?? '10', 10)
  const size = SIZES.includes(sizeRaw) ? sizeRaw : 10
  const status = STATUSES.includes(sp.get('status') ?? '') ? (sp.get('status') ?? '') : ''
  const sort = SORTS.includes(sp.get('sort') ?? '') ? (sp.get('sort') ?? SORTS[0]) : SORTS[0]
  const q = (sp.get('q') ?? '').slice(0, 100)
  return { page, size, status, sort, q }
}

export default function FilesPage() {
  const { can } = useAuth()
  const [sp, setSp] = useSearchParams()
  const params = readParams(sp)
  const [qInput, setQInput] = useState(params.q)
  const debouncedQ = useDebounce(qInput, 400) // búsqueda sin una request por tecla
  const [data, setData] = useState<Page<FileSummary> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const reqId = useRef(0)

  // Si la URL cambia por atrás/adelante, el input se sincroniza
  useEffect(() => setQInput(params.q), [params.q])

  // Cuando termina el debounce, la búsqueda pasa a la URL (y vuelve a la página 1)
  useEffect(() => {
    if (debouncedQ === params.q) return
    update({ q: debouncedQ, page: '1' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ])

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') next.delete(k)
      else next.set(k, v)
    }
    setSp(next)
  }

  const key = `${params.page}|${params.size}|${params.status}|${params.sort}|${params.q}|${reload}`
  useEffect(() => {
    const id = ++reqId.current
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ page: String(params.page - 1), size: String(params.size), sort: params.sort })
    if (params.status) qs.set('status', params.status)
    if (params.q) qs.set('q', params.q)
    api<unknown>(`/files?${qs}`, { signal: ctrl.signal })
      .then((raw) => {
        if (id !== reqId.current) return // una respuesta vieja nunca pisa a una nueva
        setData(toPage<FileSummary>(raw))
      })
      .catch((e: unknown) => {
        if (id !== reqId.current || (e instanceof DOMException && e.name === 'AbortError')) return
        setError(errorText(e))
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const totalPages = Math.max(1, data?.totalPages ?? 1)

  return (
    <main className="p-4 max-w-5xl mx-auto w-full">
      <h1 className="text-2xl font-bold mb-4">Archivos de datos</h1>
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <div>
          <label htmlFor="q" className="block text-sm">Buscar</label>
          <input id="q" value={qInput} onChange={(e) => setQInput(e.target.value)} className="px-3 py-1.5 rounded bg-slate-800 border border-slate-600" />
        </div>
        <div>
          <label htmlFor="status" className="block text-sm">Estado</label>
          <select id="status" value={params.status} onChange={(e) => update({ status: e.target.value, page: '1' })} className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600">
            {STATUSES.map((s) => <option key={s} value={s}>{s || 'Todos'}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="sort" className="block text-sm">Orden</label>
          <select id="sort" value={params.sort} onChange={(e) => update({ sort: e.target.value })} className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600">
            {SORTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="size" className="block text-sm">Por página</label>
          <select id="size" value={params.size} onChange={(e) => update({ size: e.target.value, page: '1' })} className="px-2 py-1.5 rounded bg-slate-800 border border-slate-600">
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div role="alert" className="mb-4 p-3 rounded bg-red-950 border border-red-800">
          {error} <button className="underline ml-2" onClick={() => setReload((n) => n + 1)}>Reintentar</button>
        </div>
      )}

      <div aria-busy={loading} className={loading ? 'opacity-60' : ''}>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-700">
              <th className="py-2">Nombre</th><th>Estado</th><th>Tamaño</th><th>Progreso</th><th><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((f) => {
              const pct = progressPercent(f.progress)
              return (
                <tr key={f.id} className="border-b border-slate-800">
                  <td className="py-2">{f.name}</td>
                  <td>{f.status}</td>
                  <td>{f.rows} × {f.cols}</td>
                  <td>{pct === null ? '—' : `${pct} %`}</td>
                  <td>
                    {can('files:read') && (
                      <Link to={`/files/${f.id}/refine`} className="underline text-sky-300">Abrir</Link>
                    )}
                  </td>
                </tr>
              )
            })}
            {data && data.items.length === 0 && !loading && (
              <tr><td colSpan={5} className="py-6 text-center text-slate-300">No hay archivos con esos filtros.</td></tr>
            )}
          </tbody>
        </table>
        {loading && !data && <p className="py-6 text-center">Cargando…</p>}
      </div>

      <nav aria-label="Paginación" className="flex items-center gap-3 mt-4">
        <button disabled={params.page <= 1} onClick={() => update({ page: String(params.page - 1) })} className="px-3 py-1 rounded bg-slate-700 disabled:opacity-40">Anterior</button>
        <span>Página {params.page} de {totalPages}</span>
        <button disabled={params.page >= totalPages} onClick={() => update({ page: String(params.page + 1) })} className="px-3 py-1 rounded bg-slate-700 disabled:opacity-40">Siguiente</button>
      </nav>
    </main>
  )
}
