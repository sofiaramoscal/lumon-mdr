import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'

// SHA corto del commit, inyectado en tiempo de build (X-Lumon-Build).
// En Vercel viene en VERCEL_GIT_COMMIT_SHA; en Netlify en COMMIT_REF; en Cloudflare en CF_PAGES_COMMIT_SHA.
function buildSha(mode: string): string {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.COMMIT_REF ?? process.env.CF_PAGES_COMMIT_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  if (mode === 'development') return 'dev'
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha(mode)),
  },
}))
