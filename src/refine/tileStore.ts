import { ApiError, apiRaw, sleep } from '../lib/http'
import type { DecodedTile, Rules, Tile } from '../lib/types'

/** base64 → bytes (un byte de tremor por celda). */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface Cell { r: number; c: number }
export interface CellInfo { digit: number; tremor: number; bin: string }

interface InFlight { ctrl: AbortController; promise: Promise<DecodedTile>; pins: number }

/**
 * Caché de bloques de la grilla.
 * - Nunca hay dos requests en vuelo para el mismo bloque (mapa inflight).
 * - Respeta 429 + Retry-After (pausa global) y reintenta 503 con espera creciente.
 * - Cancela los bloques que salieron de la vista (salvo los "fijados" por la búsqueda de un grupo).
 */
export class TileStore {
  private tiles = new Map<string, DecodedTile>()
  private inflight = new Map<string, InFlight>()
  private pausedUntil = 0
  private listeners = new Set<() => void>()
  version = 0
  fileId: number
  tileSize: number
  rows: number
  cols: number

  constructor(fileId: number, tileSize: number, rows: number, cols: number) {
    this.fileId = fileId
    this.tileSize = tileSize
    this.rows = rows
    this.cols = cols
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }

  key(tr: number, tc: number) {
    return `${tr}:${tc}`
  }
  get tileRows() {
    return Math.ceil(this.rows / this.tileSize)
  }
  get tileCols() {
    return Math.ceil(this.cols / this.tileSize)
  }
  has(tr: number, tc: number) {
    return this.tiles.has(this.key(tr, tc))
  }
  isLoading(tr: number, tc: number) {
    return this.inflight.has(this.key(tr, tc))
  }
  get paused() {
    return Date.now() < this.pausedUntil
  }

  cell(r: number, c: number): CellInfo | undefined {
    const t = this.tiles.get(this.key(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
    if (!t) return undefined
    const i = (r - t.originRow) * t.cols + (c - t.originCol)
    return { digit: t.values.charCodeAt(i) - 48, tremor: t.tremor[i] ?? 0, bin: t.bins[i] ?? '.' }
  }

  /** Marca celdas refinadas sin volver a pedir la grilla. */
  markRefined(cells: Cell[], binChar: string) {
    for (const { r, c } of cells) {
      const t = this.tiles.get(this.key(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize)))
      if (!t) continue
      t.bins[(r - t.originRow) * t.cols + (c - t.originCol)] = binChar
    }
    this.emit()
  }

  /** Descarta y vuelve a pedir los bloques que tocan esas celdas (ante 409). */
  invalidate(cells: Cell[]) {
    const keys = new Set(cells.map(({ r, c }) => this.key(Math.floor(r / this.tileSize), Math.floor(c / this.tileSize))))
    for (const k of keys) this.tiles.delete(k)
    this.emit()
    for (const k of keys) {
      const [tr, tc] = k.split(':').map(Number)
      void this.ensure(tr, tc).catch(() => {})
    }
  }

  /** Pide un bloque si hace falta. `pin` evita que se cancele al salir de la vista. */
  ensure(tr: number, tc: number, pin = false): Promise<DecodedTile> {
    const k = this.key(tr, tc)
    const cached = this.tiles.get(k)
    if (cached) return Promise.resolve(cached)
    const existing = this.inflight.get(k)
    if (existing) {
      if (pin) existing.pins++
      return existing.promise
    }
    const ctrl = new AbortController()
    const entry: InFlight = { ctrl, pins: pin ? 1 : 0, promise: Promise.resolve(null as unknown as DecodedTile) }
    entry.promise = this.load(tr, tc, ctrl.signal).finally(() => {
      if (this.inflight.get(k) === entry) this.inflight.delete(k)
    })
    this.inflight.set(k, entry)
    this.emit()
    return entry.promise
  }

  private async load(tr: number, tc: number, signal: AbortSignal): Promise<DecodedTile> {
    let attempt = 0
    for (;;) {
      // 429: no pedir nada hasta que pase Retry-After
      const wait = this.pausedUntil - Date.now()
      if (wait > 0) await sleep(wait, signal)
      try {
        const { data } = await apiRaw<Tile>(`/files/${this.fileId}/tiles/${tr}/${tc}`, { signal })
        const decoded: DecodedTile = {
          originRow: data.originRow,
          originCol: data.originCol,
          rows: data.rows,
          cols: data.cols,
          values: data.values,
          tremor: decodeBase64(data.tremor),
          bins: data.bins.split(''),
          version: data.version,
        }
        this.tiles.set(this.key(tr, tc), decoded)
        this.emit()
        return decoded
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          const ra = Number(e.headers?.get('Retry-After') ?? '1')
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + (Number.isFinite(ra) ? ra : 1) * 1000)
          this.emit()
          continue
        }
        if (e instanceof ApiError && e.status === 503 && attempt < 6) {
          const ra = Number(e.headers?.get('Retry-After') ?? '')
          const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 300 * 2 ** attempt)
          attempt++
          await sleep(backoff + Math.random() * 200, signal)
          continue
        }
        throw e
      }
    }
  }

  /** Cancela los bloques en vuelo que ya no se ven (y no están fijados). */
  cancelOutside(visible: Set<string>) {
    for (const [k, f] of this.inflight) {
      if (!visible.has(k) && f.pins === 0) {
        f.ctrl.abort()
        this.inflight.delete(k)
      }
    }
  }

  /**
   * Grupo completo (componente conexo máximo de celdas que dan miedo y sin refinar),
   * aunque cruce varios bloques: pide los que falten.
   */
  async findGroup(start: Cell, rules: Rules, limit = 4000): Promise<Cell[]> {
    const seen = new Set<string>()
    const out: Cell[] = []
    const queue: Cell[] = [start]
    const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const dirs8 = [...dirs4, [1, 1], [1, -1], [-1, 1], [-1, -1]]
    const dirs = rules.connectivity === 8 ? dirs8 : dirs4
    seen.add(`${start.r}:${start.c}`)
    while (queue.length && out.length < limit) {
      const cur = queue.shift() as Cell
      const tr = Math.floor(cur.r / this.tileSize)
      const tc = Math.floor(cur.c / this.tileSize)
      if (!this.has(tr, tc)) await this.ensure(tr, tc, true)
      const info = this.cell(cur.r, cur.c)
      if (!info || info.tremor < rules.tremorThreshold || info.bin !== '.') continue
      out.push(cur)
      for (const [dr, dc] of dirs) {
        const r = cur.r + dr
        const c = cur.c + dc
        if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue
        const k = `${r}:${c}`
        if (seen.has(k)) continue
        seen.add(k)
        queue.push({ r, c })
      }
    }
    return out
  }
}

/** Caja que corresponde a un grupo según las reglas del archivo. */
export function binFor(cells: Cell[], store: TileStore, rules: Rules): { bin: string | null; noise: boolean } {
  const n = cells.length
  if (n < rules.minGroupSize || n > rules.maxGroupSize) return { bin: null, noise: true }
  let sum = 0
  let max = 0
  for (const { r, c } of cells) {
    const d = store.cell(r, c)?.digit ?? 0
    sum += d
    if (d > max) max = d
  }
  const idx = rules.binning.strategy === 'MAX_DIGIT_MOD' ? max % 4 : sum % 4
  return { bin: rules.binning.order[idx] ?? null, noise: false }
}
