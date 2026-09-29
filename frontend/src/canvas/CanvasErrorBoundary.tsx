/**
 * 画布渲染错误边界：捕获渲染异常时显示恢复界面，不再白屏。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class CanvasErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[CanvasErrorBoundary] caught:', error.message, errorInfo.componentStack?.slice(0, 200))
  }

  handleRecover = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-muted p-6">
          <div className="rounded-full bg-red-50 p-3">
            <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.072 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-sm font-semibold text-ink">画布渲染异常</h2>
          <p className="max-w-sm text-center text-xs text-ink-muted">
            画布渲染引擎遇到意外错误，画布内容不会丢失。点击下方按钮恢复。
          </p>
          <button className="btn-primary" onClick={this.handleRecover}>
            恢复画布
          </button>
          {this.state.error && (
            <details className="mt-2 max-w-md rounded border border-surface-border bg-surface-muted p-2">
              <summary className="cursor-pointer text-[11px] text-ink-muted">错误详情</summary>
              <pre className="mt-2 overflow-auto text-[10px] text-ink-muted">{this.state.error.message}</pre>
            </details>
          )}
        </div>
      )
    }
    return this.props.children
  }
}