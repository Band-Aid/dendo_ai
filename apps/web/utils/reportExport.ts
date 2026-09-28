import { escapeHtml } from './safeMarkdown'
import reportCss from '../assets/css/report.css?raw'

/** Export the reader surface with inline SVG charts: no app, scripts, remote assets or server required. */
export function downloadReportHtml(element: HTMLElement, title: string) {
  const clone = element.cloneNode(true) as HTMLElement
  clone.classList.remove('report-editing')
  clone.querySelectorAll('[data-export-remove]').forEach(el => el.remove())
  clone.querySelectorAll('.report-block').forEach(el => { el.removeAttribute('tabindex'); el.removeAttribute('aria-label') })
  clone.querySelectorAll('.report-block-selected').forEach(el => el.classList.remove('report-block-selected'))
  const styles = `${reportCss}\nbody{margin:0;padding:32px;background:#f4f1eb;color:#242521;font-family:system-ui,sans-serif}*{box-sizing:border-box}.metric-cards{display:flex;flex-wrap:wrap;gap:24px;padding:18px 0}.metric-card{display:flex;flex:1;flex-direction:column;gap:8px}.metric-value{font-size:44px;line-height:1.1;letter-spacing:-.04em}.metric-label,.metric-method,.metric-target{font-size:12px;color:#79766e}.chart-empty{padding:32px;color:#79766e}.report-document svg{max-width:100%;height:auto}@media print{body{padding:0}}`
  const html = `<!doctype html><html lang="${document.documentElement.lang || 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${clone.outerHTML}</body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `${title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 100) || 'report'}.html`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
