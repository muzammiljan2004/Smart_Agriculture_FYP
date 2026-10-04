/** CSV export, for the Reports screen and the exportable statistics tables.
 *
 * Twelve lines and a Blob rather than a dependency. The one thing worth getting
 * right is quoting -- a district name is safe but a subsidy `reason` contains
 * commas and parentheses, and an unquoted one silently shifts every later column
 * by a field.
 */

const cell = (v) => {
  if (v == null) return ''
  const s = String(v)
  // A leading =, +, - or @ is interpreted as a formula by Excel and Sheets, so a
  // value from the database could execute on open. Prefixing a tab neutralises
  // it and is stripped on display.
  const safe = /^[=+\-@]/.test(s) ? '\t' + s : s
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe
}

/** `rows` is a list of flat objects; the header comes from the first one. */
export function toCsv(rows) {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')
}

export function downloadCsv(filename, rows) {
  const csv = toCsv(rows)
  if (!csv) return false
  // The BOM is what makes Excel on Windows read this as UTF-8 rather than the
  // system codepage, which otherwise mangles the Urdu and the degree signs.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return true
}
