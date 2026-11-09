import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props { children: ReactNode; resetKey?: string }
interface State { error: Error | null }

/** Un error de render en una ruta no deja la app en blanco. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info)
  }
  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (this.state.error) {
      return (
        <main role="alert" className="p-8 max-w-xl mx-auto">
          <h1 className="text-2xl font-bold mb-2">Algo salió mal en esta pantalla</h1>
          <p className="text-slate-300 mb-4">{this.state.error.message}</p>
          <div className="flex gap-3">
            <button className="px-4 py-2 rounded bg-sky-700" onClick={() => this.setState({ error: null })}>Reintentar</button>
            <a className="px-4 py-2 rounded bg-slate-700" href="/files">Volver al inicio</a>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
