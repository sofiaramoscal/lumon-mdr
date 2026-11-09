// Tipos de la API (según el README; ajustar con Swagger).
export type BinCode = 'WO' | 'FC' | 'DR' | 'MA'
export const BINS: BinCode[] = ['WO', 'FC', 'DR', 'MA']
export const BIN_CHAR: Record<string, BinCode> = { W: 'WO', F: 'FC', D: 'DR', M: 'MA' }

export interface Page<T> {
  items: T[]
  page: number
  size: number
  totalPages: number
  totalItems: number
}

export interface BinProgress { refined: number; total: number }

export interface FileSummary {
  id: number
  name: string
  status: string
  rows: number
  cols: number
  progress?: number | Record<string, unknown>
}

export interface FileDetail extends FileSummary {
  tileSize: number
  mistakes?: number
}

export interface Rules {
  tremorThreshold: number
  connectivity: 4 | 8
  minGroupSize: number
  maxGroupSize: number
  binning: { strategy: 'DIGIT_SUM_MOD' | 'MAX_DIGIT_MOD'; order: BinCode[] }
}

export interface Tile {
  tileRow: number
  tileCol: number
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: string
  tremor: string
  bins: string
  version: number
}

/** Tile ya decodificado: tremor como bytes, bins mutable. */
export interface DecodedTile {
  originRow: number
  originCol: number
  rows: number
  cols: number
  values: string
  tremor: Uint8Array
  bins: string[]
  version: number
}

/** Normaliza una respuesta paginada (acepta items/content/data). */
export function toPage<T>(raw: unknown): Page<T> {
  const r = (raw ?? {}) as Record<string, unknown>
  const items = (r.items ?? r.content ?? r.data ?? r.results ?? []) as T[]
  const meta = (r.page && typeof r.page === 'object' ? r.page : r) as Record<string, unknown>
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof meta[k] === 'number') return meta[k] as number
    for (const k of keys) if (typeof r[k] === 'number') return r[k] as number
    return 0
  }
  return {
    items,
    page: num('page', 'number', 'pageNumber'),
    size: num('size', 'pageSize', 'limit'),
    totalPages: num('totalPages', 'pages'),
    totalItems: num('totalItems', 'totalElements', 'total', 'count'),
  }
}

/** Progreso en % a partir de lo que mande el backend. */
export function progressPercent(p: unknown): number | null {
  if (typeof p === 'number') return p <= 1 ? Math.round(p * 100) : Math.round(p)
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>
    for (const k of ['percent', 'percentage', 'pct']) if (typeof o[k] === 'number') return Math.round(o[k] as number)
    if (typeof o.refined === 'number' && typeof o.total === 'number' && o.total > 0)
      return Math.round(((o.refined as number) / (o.total as number)) * 100)
  }
  return null
}
