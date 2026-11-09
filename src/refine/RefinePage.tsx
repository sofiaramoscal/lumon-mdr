import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react"
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api, apiRaw, ApiError, errorText, NetworkError, sleep } from '../lib/http'
import { BINS, progressPercent, type FileDetail, type Rules } from '../lib/types'
import { binFor, TileStore, type Cell } from './tileStore'

const CELL = 26 // px por celda
const MAX_CELLS = 2500 // nunca más de 2 500 celdas en el DOM
const OVERSCAN = 2

interface Selection {
  cells: Cell[]
  keys: Set<string>
  bin: string | null
  noise: boolean
  idemKey: string // una key por INTENCIÓN del usuario (se reutiliza en reintentos)
}

export default function RefinePage() {
  const { id } = useParams()
  const fileId = Number(id)
  const [file, setFile] = useState<FileDetail | null>(null)
  const [rules, setRules] = useState<Rules | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!Number.isInteger(fileId) || fileId <= 0) {
      setError('El identificador del archivo no es válido.')
      return
    }
    const ctrl = new AbortController()
    setError(null)
    Promise.all([
      api<FileDetail>(`/files/${fileId}`, { signal: ctrl.signal }),
      api<Rules>(`/files/${fileId}/rules`, { signal: ctrl.signal }),
    ])
      .then(([f, r]) => {
        setFile(f)
        setRules(r)
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(errorText(e))
      })
    return () => ctrl.abort()
  }, [fileId, reload])

  if (error)
    return (
      <main className="p-6" role="alert">
        <p className="mb-3">{error}</p>
        <button className="px-3 py-1 rounded bg-slate-700 mr-3" onClick={() => setReload((n) => n + 1)}>Reintentar</button>
        <Link to="/files" className="underline text-sky-300">Volver a archivos</Link>
      </main>
    )
  if (!file || !rules) return <main className="p-6" role="status">Cargando archivo…</main>
  return <RefineGrid key={file.id} file={file} rules={rules} />
}

function RefineGrid({ file, rules }: { file: FileDetail; rules: Rules }) {
  const { can } = useAuth()
  const canRefine = can('files:refine')
  const store = useMemo(() => new TileStore(file.id, file.tileSize, file.rows, file.cols), [file])
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version,
  )

  const [sp, setSp] = useSearchParams()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, left: 0, h: 600, w: 900 })
  const [focus, setFocus] = useState<Cell>(() => ({
    r: clamp(Number(sp.get('r') ?? 0) || 0, 0, file.rows - 1),
    c: clamp(Number(sp.get('c') ?? 0) || 0, 0, file.cols - 1),
  }))
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [progress, setProgress] = useState<unknown>(file.progress ?? null)
  const [completed, setCompleted] = useState(file.status === 'COMPLETED' || progressPercent(file.progress) === 100)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [overBin, setOverBin] = useState<string | null>(null)

  // Posición inicial desde la URL (?r=&c=)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = focus.r * CELL
    el.scrollLeft = focus.c * CELL
    setView({ top: el.scrollTop, left: el.scrollLeft, h: el.clientHeight, w: el.clientWidth })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scroll → viewport (con rAF) y URL con replace (el scroll no llena el historial)
  const raf = useRef(0)
  const urlTimer = useRef<number | undefined>(undefined)
  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      setView({ top: el.scrollTop, left: el.scrollLeft, h: el.clientHeight, w: el.clientWidth })
      window.clearTimeout(urlTimer.current)
      urlTimer.current = window.setTimeout(() => {
        const r = Math.floor(el.scrollTop / CELL)
        const c = Math.floor(el.scrollLeft / CELL)
        setSp(
          (prev) => {
            const next = new URLSearchParams(prev)
            next.set('r', String(r))
            next.set('c', String(c))
            return next
          },
          { replace: true },
        )
      }, 250)
    })
  }, [setSp])

  useEffect(() => {
    const onResize = () => onScroll()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(urlTimer.current)
    }
  }, [onScroll])

  // Rango visible de filas/columnas, limitado a MAX_CELLS
  let r0 = Math.max(0, Math.floor(view.top / CELL) - OVERSCAN)
  let r1 = Math.min(file.rows - 1, Math.ceil((view.top + view.h) / CELL) + OVERSCAN)
  let c0 = Math.max(0, Math.floor(view.left / CELL) - OVERSCAN)
  let c1 = Math.min(file.cols - 1, Math.ceil((view.left + view.w) / CELL) + OVERSCAN)
  while ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_CELLS - 1) {
    if (r1 - r0 > c1 - c0) { r1--; if (r1 - r0 > 0) r0++ } else { c1--; if (c1 - c0 > 0) c0++ }
  }

  // Bloques visibles: se piden solo cuando hacen falta; se cancelan los que salen de la vista
  const ts = file.tileSize
  const tr0 = Math.floor(r0 / ts), tr1 = Math.floor(r1 / ts)
  const tc0 = Math.floor(c0 / ts), tc1 = Math.floor(c1 / ts)
  useEffect(() => {
    const visible = new Set<string>()
    for (let tr = tr0; tr <= tr1; tr++)
      for (let tc = tc0; tc <= tc1; tc++) {
        visible.add(store.key(tr, tc))
        void store.ensure(tr, tc).catch(() => {})
      }
    store.cancelOutside(visible)
  }, [store, tr0, tr1, tc0, tc1])

  // Seleccionar el grupo completo de una celda que da miedo
  const selectAt = useCallback(
    async (cell: Cell) => {
      const info = store.cell(cell.r, cell.c)
      if (!info || info.tremor < rules.tremorThreshold) {
        setSelection(null)
        return
      }
      if (info.bin !== '.') {
        setMsg({ kind: 'error', text: 'Esa celda ya está refinada.' })
        return
      }
      setSelecting(true)
      setMsg(null)
      try {
        const cells = await store.findGroup(cell, rules)
        const { bin, noise } = binFor(cells, store, rules)
        setSelection({ cells, keys: new Set(cells.map((x) => `${x.r}:${x.c}`)), bin, noise, idemKey: crypto.randomUUID() })
      } catch (e) {
        setMsg({ kind: 'error', text: `No se pudo cargar el grupo: ${errorText(e)}` })
      } finally {
        setSelecting(false)
      }
    },
    [store, rules],
  )

  // Refinar: idempotente. Doble clic / doble Enter bloqueados; reintentos de red con la MISMA key.
  const refine = useCallback(
    async (bin: string) => {
      if (!selection || submittingRef.current || !canRefine) return
      if (selection.noise) {
        setMsg({ kind: 'error', text: 'Ese grupo es ruido (fuera del tamaño permitido): no se puede refinar.' })
        return
      }
      submittingRef.current = true
      setSubmitting(true)
      setMsg(null)
      const body = { bin, cells: selection.cells }
      let attempt = 0
      try {
        for (;;) {
          try {
            const res = await apiRaw<Record<string, unknown>>(`/files/${file.id}/refinements`, {
              method: 'POST',
              body,
              headers: { 'Idempotency-Key': selection.idemKey },
            })
            store.markRefined(selection.cells, bin[0])
            const p = res.data.progress ?? res.data.file ?? res.data
            setProgress(p)
            const pct = progressPercent(p)
            if (pct === 100 || res.data.status === 'COMPLETED') setCompleted(true)
            setMsg({ kind: 'ok', text: `Grupo de ${selection.cells.length} celdas llevado a ${bin}.` })
            setSelection(null)
            return
          } catch (e) {
            const retryable =
              e instanceof NetworkError ||
              (e instanceof ApiError && (e.status === 503 || e.status === 429 || e.status >= 502))
            if (retryable && attempt < 5) {
              const ra = e instanceof ApiError ? Number(e.headers?.get('Retry-After') ?? '') : NaN
              await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt)
              attempt++
              continue // misma Idempotency-Key: el backend no refina dos veces
            }
            throw e
          }
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          const reason = typeof e.details?.reason === 'string' ? e.details.reason : e.code
          const text =
            e.code === 'WRONG_BIN'
              ? `Caja incorrecta para este grupo (${bin}). Revisa las reglas: la caja sugerida es ${selection.bin ?? '—'}.`
              : `El grupo no se puede refinar: ${reason}. Vuelve a seleccionarlo completo.`
          setMsg({ kind: 'error', text })
          setSelection(null)
        } else if (e instanceof ApiError && e.status === 409) {
          setMsg({
            kind: 'error',
            text:
              e.code === 'GROUP_CLAIMED'
                ? `Otro refinador tiene reservado este grupo. Elige otro grupo.`
                : 'Alguna celda ya estaba refinada. Actualicé esos bloques: elige otro grupo.',
          })
          store.invalidate(selection.cells)
          setSelection(null)
        } else {
          setMsg({ kind: 'error', text: `${errorText(e)}. Puedes intentar de nuevo.` })
        }
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    },
    [selection, canRefine, file.id, store],
  )

  // ---- Arrastre con Pointer Events ----
  const onDragStart = (e: RPointerEvent<HTMLElement>) => {
    if (!selection || !canRefine) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x: e.clientX, y: e.clientY })
  }
  const binAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)
    const target = el?.closest('[data-bin]')
    return target?.getAttribute('data-bin') ?? null
  }
  const onDragMove = (e: RPointerEvent<HTMLElement>) => {
    if (!drag) return
    setDrag({ x: e.clientX, y: e.clientY })
    setOverBin(binAt(e.clientX, e.clientY))
  }
  const onDragEnd = (e: RPointerEvent<HTMLElement>) => {
    if (!drag) return
    const b = binAt(e.clientX, e.clientY)
    setDrag(null)
    setOverBin(null)
    if (b) void refine(b)
  }

  // ---- Teclado en la grilla (patrón ARIA grid) ----
  const pageRows = Math.max(1, Math.floor(view.h / CELL) - 1)
  const moveFocus = (r: number, c: number) => {
    const nr = clamp(r, 0, file.rows - 1)
    const nc = clamp(c, 0, file.cols - 1)
    setFocus({ r: nr, c: nc })
    const el = scrollRef.current
    if (!el) return
    // Mantiene la celda con foco dentro de la vista (y por tanto en el DOM)
    if (nr * CELL < el.scrollTop) el.scrollTop = nr * CELL
    else if ((nr + 1) * CELL > el.scrollTop + el.clientHeight) el.scrollTop = (nr + 1) * CELL - el.clientHeight
    if (nc * CELL < el.scrollLeft) el.scrollLeft = nc * CELL
    else if ((nc + 1) * CELL > el.scrollLeft + el.clientWidth) el.scrollLeft = (nc + 1) * CELL - el.clientWidth
  }
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const { r, c } = focus
    let handled = true
    switch (e.key) {
      case 'ArrowUp': moveFocus(r - 1, c); break
      case 'ArrowDown': moveFocus(r + 1, c); break
      case 'ArrowLeft': moveFocus(r, c - 1); break
      case 'ArrowRight': moveFocus(r, c + 1); break
      case 'PageUp': moveFocus(r - pageRows, c); break
      case 'PageDown': moveFocus(r + pageRows, c); break
      case 'Home': e.ctrlKey ? moveFocus(0, 0) : moveFocus(r, 0); break
      case 'End': e.ctrlKey ? moveFocus(file.rows - 1, file.cols - 1) : moveFocus(r, file.cols - 1); break
      case 'Enter':
      case ' ':
        void selectAt(focus)
        break
      case 'Escape': setSelection(null); break
      case '1': case '2': case '3': case '4':
        if (selection) void refine(BINS[Number(e.key) - 1])
        break
      default: handled = false
    }
    if (handled) e.preventDefault()
  }

  // Tras moverse, el foco DOM va a la celda activa
  const gridRef = useRef<HTMLDivElement>(null)
  const gridHasFocus = useRef(false)
  useEffect(() => {
    if (!gridHasFocus.current) return
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${focus.r}:${focus.c}"]`)
    el?.focus({ preventScroll: true })
  }, [focus, view])

  if (completed) {
    return (
      <main className="p-8 max-w-xl mx-auto text-center">
        <h1 className="text-3xl font-bold mb-3">Archivo completado</h1>
        <p className="text-slate-300 mb-6">{file.name} está refinado al 100 %. El trabajo es misterioso e importante.</p>
        <Link to="/files" className="px-4 py-2 rounded bg-sky-700">Volver a los archivos</Link>
      </main>
    )
  }

  // ---- Render virtualizado ----
  const rowsEls = []
  const rowList: number[] = []
  for (let r = r0; r <= r1; r++) rowList.push(r)
  if (focus.r < r0 || focus.r > r1) rowList.push(focus.r) // la celda con foco siempre está en el DOM
  for (const r of rowList) {
    const cells = []
    const colList: number[] = []
    for (let c = c0; c <= c1; c++) colList.push(c)
    if (r === focus.r && (focus.c < c0 || focus.c > c1)) colList.push(focus.c)
    for (const c of colList) {
      if (r !== focus.r && (c < c0 || c > c1)) continue
      const info = store.cell(r, c)
      if (!info) continue // placeholder del bloque se dibuja aparte
      const k = `${r}:${c}`
      const scary = info.tremor >= rules.tremorThreshold && info.bin === '.'
      const isFocus = r === focus.r && c === focus.c
      const selected = selection?.keys.has(k)
      const amp = scary ? (1 + (info.tremor - rules.tremorThreshold) / 15).toFixed(2) : '0'
      cells.push(
        <div
          key={k}
          role="gridcell"
          aria-colindex={c + 1}
          aria-selected={selected ? true : undefined}
          aria-label={`Fila ${r + 1}, columna ${c + 1}, dígito ${info.digit}${scary ? ', da miedo' : ''}${info.bin !== '.' ? `, en caja ${info.bin}` : ''}`}
          data-cell={k}
          tabIndex={isFocus ? 0 : -1}
          onClick={() => {
            setFocus({ r, c })
            void selectAt({ r, c })
          }}
          className={`absolute grid place-items-center text-sm select-none cursor-default ${
            selected ? 'bg-sky-700 rounded' : info.bin !== '.' ? 'text-slate-600' : 'text-slate-300'
          } ${isFocus ? 'outline-2 outline-sky-300 z-10' : ''}`}
          style={{ top: r * CELL, left: c * CELL, width: CELL, height: CELL }}
        >
          <span
            className={scary ? 'scary' : undefined}
            style={scary ? ({ '--amp': amp, '--dur': `${Math.max(120, 600 - info.tremor * 4)}ms` } as CSSProperties) : undefined}
          >
            {info.bin !== '.' ? info.bin : info.digit}
          </span>
        </div>,
      )
    }
    rowsEls.push(
      <div key={r} role="row" aria-rowindex={r + 1}>
        {cells}
      </div>,
    )
  }

  // Placeholders de bloques sin cargar: mismo tamaño, el layout no salta
  const placeholders = []
  for (let tr = tr0; tr <= tr1; tr++)
    for (let tc = tc0; tc <= tc1; tc++) {
      if (store.has(tr, tc)) continue
      const h = Math.min(ts, file.rows - tr * ts) * CELL
      const w = Math.min(ts, file.cols - tc * ts) * CELL
      placeholders.push(
        <div
          key={`p${tr}:${tc}`}
          aria-hidden="true"
          className="absolute bg-slate-900 border border-slate-800 motion-safe:animate-pulse"
          style={{ top: tr * ts * CELL, left: tc * ts * CELL, width: w, height: h }}
        />,
      )
    }

  return (
    <main className="flex flex-col lg:flex-row gap-4 p-4 flex-1 min-h-0">
      <section className="flex-1 min-w-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="text-xl font-bold">{file.name}</h1>
          <span className="text-sm text-slate-300">{file.rows} × {file.cols} · umbral {rules.tremorThreshold} · conectividad {rules.connectivity}</span>
          {store.paused && <span role="status" className="text-amber-300 text-sm">Lumon pidió esperar (429)…</span>}
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative overflow-auto border border-slate-700 rounded bg-slate-950 h-[70vh]"
        >
          <div
            ref={gridRef}
            role="grid"
            aria-label={`Grilla del archivo ${file.name}. Flechas para moverte, Enter para seleccionar un grupo, 1 a 4 para llevarlo a una caja.`}
            aria-rowcount={file.rows}
            aria-colcount={file.cols}
            onKeyDown={onGridKey}
            onFocus={() => (gridHasFocus.current = true)}
            onBlur={() => (gridHasFocus.current = false)}
            className="relative font-mono"
            style={{ width: file.cols * CELL, height: file.rows * CELL }}
          >
            {placeholders}
            {rowsEls}
          </div>
        </div>
      </section>

      <aside className="w-full lg:w-72 space-y-4" aria-label="Cajas y selección">
        <div aria-live="polite" className="min-h-6">
          {selecting && <p>Buscando el grupo completo…</p>}
          {msg && <p className={msg.kind === 'error' ? 'text-red-300' : 'text-emerald-300'} role={msg.kind === 'error' ? 'alert' : undefined}>{msg.text}</p>}
        </div>

        {selection && (
          <div className="p-3 rounded bg-slate-900 border border-slate-700">
            <p className="font-semibold">Grupo: {selection.cells.length} celdas</p>
            <p className="text-sm">{selection.noise ? 'Es ruido: no se puede refinar.' : `Caja según las reglas: ${selection.bin}`}</p>
            {canRefine && !selection.noise && (
              <button
                type="button"
                onPointerDown={onDragStart}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={() => { setDrag(null); setOverBin(null) }}
                className="mt-2 w-full py-2 rounded bg-sky-800 cursor-grab touch-none"
              >
                Arrastra este grupo a una caja
              </button>
            )}
            <button className="mt-2 text-sm underline" onClick={() => setSelection(null)}>Cancelar selección</button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {BINS.map((b, i) => (
            <button
              key={b}
              data-bin={b}
              disabled={!selection || selection.noise || submitting || !canRefine}
              onClick={() => void refine(b)}
              aria-label={`Caja ${b} (tecla ${i + 1})`}
              className={`p-3 rounded border-2 text-left disabled:opacity-60 ${overBin === b ? 'border-sky-300 bg-sky-950' : 'border-slate-600 bg-slate-900'}`}
            >
              <span className="font-bold">{b}</span>
              <BinBar progress={progress} bin={b} />
            </button>
          ))}
        </div>
        {submitting && <p role="status">Refinando…</p>}
        {!canRefine && <p className="text-sm text-slate-300">Tu rol solo puede ver la grilla.</p>}
        <p className="text-xs text-slate-400">Teclado: flechas, PageUp/PageDown, Home/End, Enter selecciona, 1-4 refinan, Esc cancela.</p>
      </aside>

      {drag && (
        <div aria-hidden="true" className="fixed pointer-events-none z-50 px-2 py-1 rounded bg-sky-600 text-sm" style={{ left: drag.x + 8, top: drag.y + 8 }}>
          {selection?.cells.length} celdas
        </div>
      )}
    </main>
  )
}

/** Barra de progreso de una caja con lo que mande el servidor. */
function BinBar({ progress, bin }: { progress: unknown; bin: string }) {
  let pct: number | null = null
  let label = ''
  if (progress && typeof progress === 'object') {
    const o = progress as Record<string, unknown>
    const bins = (o.bins ?? o.byBin ?? o) as Record<string, unknown>
    const v = bins[bin]
    if (typeof v === 'number') {
      pct = v <= 1 ? v * 100 : v
      label = `${Math.round(pct)} %`
    } else if (v && typeof v === 'object') {
      const p = progressPercent(v)
      pct = p
      const vo = v as Record<string, unknown>
      label = typeof vo.refined === 'number' ? `${vo.refined}/${vo.total}` : `${p ?? 0} %`
    }
  }
  return (
    <span className="block mt-1">
      <span className="block h-2 rounded bg-slate-700 overflow-hidden" role="progressbar" aria-label={`Progreso ${bin}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
        <span className="block h-full bg-emerald-500" style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="text-xs text-slate-300">{label || '—'}</span>
    </span>
  )
}

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n))
}
