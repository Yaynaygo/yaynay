// Same-origin guard for our /api endpoints. Browsers always send Origin on POST, so a missing or
// foreign Origin means the request did not come from our page.

export function originError(request: Request, allowedOrigins?: string): string | null {
  const origin = request.headers.get('Origin')
  const allowed = new Set([
    new URL(request.url).origin,
    ...(allowedOrigins ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ])
  if (!origin || !allowed.has(origin)) return 'origin not allowed'
  const site = request.headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin') return 'cross-site request refused'
  return null
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}
