import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { API_BASE, BUILD_SHA } from '../lib/http'

/** Si /meta/health no responde: "Conectando con Lumon…" con reintento automático (espera creciente) y manual. */
export function HealthGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [nextIn, setNextIn] = useState(0)
  const timer = useRef<number | undefined>(undefined)

  const check = useCallback(async () => {
    window.clearTimeout(timer.current)
    try {
      const ctrl = new AbortController()
      const t = window.setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(`${API_BASE}/meta/health`, { headers: { 'X-Lumon-Build': BUILD_SHA }, signal: ctrl.signal })
      window.clearTimeout(t)
      if (!res.ok) throw new Error(String(res.status))
      setOk(true)
    } catch {
      setOk(false)
      setAttempt((a) => {
        const delay = Math.min(30000, 1000 * 2 ** a) // 1s, 2s, 4s… hasta 30s
        setNextIn(Math.round(delay / 1000))
        timer.current = window.setTimeout(() => void check(), delay)
        return a + 1
      })
    }
  }, [])

  useEffect(() => {
    void check()
    return () => window.clearTimeout(timer.current)
  }, [check])

  if (ok) return <>{children}</>
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div role="status" aria-live="polite" className="text-center space-y-3">
        <h1 className="text-xl font-semibold">Conectando con Lumon…</h1>
        {ok === false && (
          <>
            <p className="text-slate-300">Intento {attempt}. Próximo reintento en ~{nextIn} s.</p>
            <button
              className="px-4 py-2 rounded bg-sky-700 hover:bg-sky-600"
              onClick={() => {
                setAttempt(0)
                void check()
              }}
            >
              Reintentar ahora
            </button>
          </>
        )}
      </div>
    </main>
  )
}
