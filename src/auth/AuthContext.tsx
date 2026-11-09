import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  api,
  ApiError,
  authChannel,
  getRefreshToken,
  refreshSession,
  setAccessToken,
  setOnSessionLost,
  setRefreshToken,
  type TabMessage,
  type TokenPair,
} from '../lib/http'

export interface Me {
  id?: number
  email?: string
  displayName?: string
  user?: { id: number; email: string; displayName: string }
  team: { code: string; name: string }
  role: { code: string; name: string }
  permissions: string[]
  clearance: { granted: boolean; grantedAt: string | null }
}

type Status = 'checking' | 'authenticated' | 'anonymous'

interface AuthValue {
  status: Status
  me: Me | null
  notice: string | null
  can: (perm: string) => boolean
  login: (email: string, password: string) => Promise<void>
  register: (body: Record<string, string>) => Promise<void>
  logout: () => Promise<void>
  reloadMe: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

const REVOKED_TEXT: Record<string, string> = {
  REFRESH_REUSED: 'Tu sesión se cerró por seguridad: se detectó un refresh token reutilizado. Inicia sesión de nuevo.',
  SESSION_REVOKED: 'Tu sesión fue revocada. Inicia sesión de nuevo.',
  TOKEN_INVALID: 'Tu sesión ya no es válida. Inicia sesión de nuevo.',
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const clearLocal = useCallback((reason?: string) => {
    setAccessToken(null)
    setRefreshToken(null)
    setMe(null)
    setStatus('anonymous')
    setNotice(reason ? (REVOKED_TEXT[reason] ?? null) : null)
  }, [])

  const reloadMe = useCallback(async () => {
    const data = await api<Me>('/auth/me')
    setMe(data)
  }, [])

  // Sesión perdida (REFRESH_REUSED, SESSION_REVOKED...): esta pestaña y todas las demás vuelven al login.
  useEffect(() => {
    setOnSessionLost((reason) => {
      if (reason === 'NO_SESSION') return clearLocal()
      clearLocal(reason)
      authChannel?.postMessage({ type: 'logout', reason } satisfies TabMessage)
    })
  }, [clearLocal])

  // Mensajes de otras pestañas
  useEffect(() => {
    const ch = authChannel
    if (!ch) return
    const onMsg = (ev: MessageEvent<TabMessage>) => {
      if (ev.data.type === 'logout') {
        setAccessToken(null)
        setMe(null)
        setStatus('anonymous')
        setNotice(ev.data.reason ? (REVOKED_TEXT[ev.data.reason] ?? null) : null)
      }
    }
    ch.addEventListener('message', onMsg)
    // Respaldo: si el refresh token desaparece de localStorage (logout en otra pestaña)
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'lumon.rt' && e.newValue === null) {
        setAccessToken(null)
        setMe(null)
        setStatus('anonymous')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      ch.removeEventListener('message', onMsg)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // Restaurar sesión al recargar: con el refresh token pedimos un access token nuevo y luego /auth/me.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!getRefreshToken()) {
        setStatus('anonymous')
        return
      }
      try {
        await refreshSession()
        const data = await api<Me>('/auth/me')
        if (cancelled) return
        setMe(data)
        setStatus('authenticated')
      } catch (e) {
        if (cancelled) return
        if (e instanceof ApiError) clearLocal(e.code)
        else clearLocal()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [clearLocal])

  const afterTokens = useCallback(async (pair: TokenPair) => {
    setAccessToken(pair.accessToken)
    setRefreshToken(pair.refreshToken)
    const data = await api<Me>('/auth/me')
    setMe(data)
    setNotice(null)
    setStatus('authenticated')
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const pair = await api<TokenPair>('/auth/login', { method: 'POST', body: { email, password }, auth: false })
      await afterTokens(pair)
    },
    [afterTokens],
  )

  const register = useCallback(
    async (body: Record<string, string>) => {
      const pair = await api<TokenPair>('/auth/register', { method: 'POST', body, auth: false })
      await afterTokens(pair)
    },
    [afterTokens],
  )

  const logout = useCallback(async () => {
    const rt = getRefreshToken()
    try {
      // El logout revoca la sesión en el servidor
      await api('/auth/logout', { method: 'POST', body: { refreshToken: rt } })
    } catch {
      /* aunque falle, cerramos localmente */
    }
    clearLocal()
    authChannel?.postMessage({ type: 'logout' } satisfies TabMessage)
  }, [clearLocal])

  const can = useCallback((perm: string) => !!me?.permissions.includes(perm), [me])

  const value = useMemo(
    () => ({ status, me, notice, can, login, register, logout, reloadMe }),
    [status, me, notice, can, login, register, logout, reloadMe],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth fuera de AuthProvider')
  return ctx
}
