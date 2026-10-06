/** Page numbers to show: first, last, and a window around the current page, with gaps as null. */
export function pageWindow(page: number, pages: number, around = 1): (number | null)[] {
  const keep = new Set([0, pages - 1])
  for (let p = page - around; p <= page + around; p++) if (p >= 0 && p < pages) keep.add(p)
  // Near the edges, widen the window so the row keeps the same length.
  if (page <= around + 1) for (let p = 0; p <= around * 2 + 1 && p < pages; p++) keep.add(p)
  if (page >= pages - around - 2) for (let p = pages - around * 2 - 2; p < pages; p++) if (p >= 0) keep.add(p)
  const sorted = [...keep].sort((a, b) => a - b)
  const out: (number | null)[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(p - sorted[i - 1] === 2 ? p - 1 : null)
    out.push(p)
  })
  return out
}
