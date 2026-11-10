// Capa HTTP de la app: cabeceras obligatorias, formato de error y refresh coordinado.

export const API_BASE = import.meta.env.VITE_API_BASE_URL
export const WS_BASE = import.meta.env.VITE_WS_BASE_URL
export const BUILD_SHA = __BUILD_SHA__

/** Cuerpo de error de Lumon. Se decide con `error`, nunca con `message`. */
export interface ApiErrorBody {
  error: string
  message: string
  details: Record<string, unknown> | null
  requestId?: string
}

export class ApiError extends Error {
  status: number
  code: string
  details: Record<string, unknown> | null
  headers: Headers | null
  constructor(status: number, body: ApiErrorBody, headers: Headers | null) {
    super(body.message || body.error)
    this.status = status
    this.code = body.error
    this.details = body.details
    this.headers = headers
  }
}

/** Error de red (sin respuesta del servidor). */
export class NetworkError extends Error {}

// ---------------- Tokens ----------------
// Access token: SOLO en memoria (variable del módulo).
// Refresh token: en localStorage (permitido por el enunciado). Es de un solo uso.
const RT_KEY = 'lumon.rt'
let accessToken: string | null = null

export function getAccessToken() {
  return accessToken
}
export function setAccessToken(t: string | null) {
  accessToken = t
}
export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(RT_KEY)
  } catch {
    return null
  }
}
export function setRefreshToken(t: string | null) {
  try {
    if (t) localStorage.setItem(RT_KEY, t)
    else localStorage.removeItem(RT_KEY)
  } catch {
    /* sin storage: la sesión no se restaura al recargar */
  }
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: number; email: string; displayName: string }
}

// Aviso entre pestañas (logout, sesión revocada, tokens nuevos)
export type TabMessage =
  | { type: 'logout'; reason?: string }
  | { type: 'tokens'; accessToken: string }
export const authChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('lumon-auth') : null

// Callback que el AuthContext registra para reaccionar a una sesión revocada
let onSessionLost: (reason: string) => void = () => {}
export function setOnSessionLost(fn: (reason: string) => void) {
  onSessionLost = fn
}

function baseHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra)
  h.set('X-Lumon-Build', BUILD_SHA)
  return h
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = { error: `HTTP_${res.status}`, message: res.statusText, details: null }
  try {
    const json: unknown = await res.json()
    if (json && typeof json === 'object' && 'error' in json) body = json as ApiErrorBody
  } catch {
    /* cuerpo vacío o no JSON */
  }
  return new ApiError(res.status, body, res.headers)
}

// ---------------- Refresh coordinado ----------------
// 1) Dentro de la pestaña: una sola promesa compartida (si 5 requests reciben TOKEN_EXPIRED, hay 1 refresh).
// 2) Entre pestañas: Web Locks. Dentro del lock se lee el refresh token MÁS RECIENTE de localStorage,
//    así ninguna pestaña presenta un refresh token ya usado (evita REFRESH_REUSED).
let refreshPromise: Promise<string> | null = null

async function doRefresh(): Promise<string> {
  const run = async (): Promise<string> => {
    const rt = getRefreshToken()
    if (!rt) throw new ApiError(401, { error: 'NO_SESSION', message: 'Sin sesión', details: null }, null)
    let res: Response
    try {
      res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: baseHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ refreshToken: rt }),
      })
    } catch {
      throw new NetworkError('Sin conexión con Lumon')
    }
    if (!res.ok) throw await parseError(res)
    const pair = (await res.json()) as TokenPair
    setRefreshToken(pair.refreshToken)
    setAccessToken(pair.accessToken)
    return pair.accessToken
  }
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('lumon-refresh', run)
  }
  return run()
}

export function refreshSession(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

export interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  auth?: boolean
  /** false: no reintentar automáticamente (los bloques manejan su propio 429/503) */
  retry?: boolean
}

export interface ApiResponse<T> {
  data: T
  headers: Headers
  status: number
}

/** fetch con cabeceras de Lumon, refresh coordinado y reintento único tras TOKEN_EXPIRED. */
export async function apiRaw<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const send = async (token: string | null): Promise<Response> => {
    const h = baseHeaders(opts.headers)
    if (opts.body !== undefined) h.set('Content-Type', 'application/json')
    if (opts.auth !== false && token) h.set('Authorization', `Bearer ${token}`)
    try {
      return await fetch(`${API_BASE}${path}`, {
        method: opts.method ?? 'GET',
        headers: h,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      throw new NetworkError('Sin conexión con Lumon')
    }
  }

  // Lecturas (GET): ante corte de red, 503 o 429 se reintenta con espera creciente / Retry-After.
  const isGet = (opts.method ?? 'GET') === 'GET' && opts.retry !== false
  let res: Response
  for (let attempt = 0; ; attempt++) {
    try {
      res = await send(accessToken)
    } catch (e) {
      if (isGet && e instanceof NetworkError && attempt < 4) {
        await sleep(400 * 2 ** attempt, opts.signal)
        continue
      }
      throw e
    }
    if (isGet && (res.status === 503 || res.status === 429) && attempt < 4) {
      const ra = Number(res.headers.get('Retry-After') ?? '')
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt, opts.signal)
      continue
    }
    break
  }
  if (res.status === 401 && opts.auth !== false) {
    const err = await parseError(res)
    if (err.code !== 'TOKEN_EXPIRED') {
      if (err.code === 'SESSION_REVOKED' || err.code === 'TOKEN_INVALID') onSessionLost(err.code)
      throw err
    }
    // Solo TOKEN_EXPIRED justifica un refresh. Se reintenta UNA sola vez.
    let newToken: string
    try {
      newToken = await refreshSession()
    } catch (e) {
      if (e instanceof ApiError) onSessionLost(e.code)
      throw e
    }
    res = await send(newToken)
  }
  if (!res.ok) throw await parseError(res)
  const text = await res.text()
  const data = (text ? JSON.parse(text) : null) as T
  return { data, headers: res.headers, status: res.status }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await apiRaw<T>(path, opts)).data
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}

/** Mensaje legible para mostrar en pantalla. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.message} (${e.code})`
  if (e instanceof NetworkError) return 'Sin conexión con Lumon. Revisa tu red e intenta de nuevo.'
  if (e instanceof Error) return e.message
  return 'Error desconocido'
}
