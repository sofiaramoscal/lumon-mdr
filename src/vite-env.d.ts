/// <reference types="vite/client" />
declare const __BUILD_SHA__: string

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_WS_BASE_URL: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
