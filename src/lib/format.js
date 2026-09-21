export function money(n, digits = 2) {
  const v = Number(n || 0)
  if (!Number.isFinite(v)) return "$0.00"
  if (v > 0 && v < 0.01 && digits <= 2) return "<$0.01"
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function compact(n) {
  const v = Number(n || 0)
  if (!Number.isFinite(v)) return "0"
  if (Math.abs(v) >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B"
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "K"
  return String(v)
}

export function num(n) {
  return Number(n || 0).toLocaleString("en-US")
}

export function pct(n, digits = 2) {
  if (n === null || n === undefined || n === "") return "\u2014"
  return Number(n).toFixed(digits) + "%"
}

export function ms(n) {
  if (n === null || n === undefined || n === "") return "\u2014"
  return Math.round(Number(n)) + "ms"
}

export function dateTime(value) {
  if (!value) return "\u2014"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "\u2014"
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function shortDate(value) {
  if (!value) return "\u2014"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "\u2014"
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" })
}

export function relative(value) {
  if (!value) return "never"
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return "never"
  const diff = Date.now() - then
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return shortDate(value)
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
