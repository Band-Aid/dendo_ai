import { Marked } from 'marked'
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
const markdown = new Marked({
  breaks: true,
  renderer: {
    html({ text }) { return escapeHtml(text) },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      // Only absolute web and mail links survive publication and HTML export.
      if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020]/.test(href)) return label
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    },
    image({ text }) { return escapeHtml(text) }
  }
})
export function safeMarkdown(text: string): string { return markdown.parse(text || '', { async: false }) as string }
