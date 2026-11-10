/**
 * Browser → Next.js → gateway. The browser only ever talks to this app; the gateway is reached
 * server-side and isn't exposed publicly. Plain function so it can be unit-tested.
 */

/** Hop-by-hop headers (RFC 9110 §7.6.1) and ones fetch() sets itself. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // fetch() throws on it; curl sends `expect: 100-continue` for bodies over 1 MB
  'expect',
]);

/** fetch() already decoded the body, so these no longer describe it. Cookies are re-added below. */
const DROP_RESPONSE = new Set([...HOP_BY_HOP, 'content-encoding', 'set-cookie']);

export interface ProxyConfig {
  gatewayUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

export async function proxyToGateway(req: Request, path: string[], cfg: ProxyConfig): Promise<Response> {
  const url = new URL(req.url);
  const target = `${cfg.gatewayUrl.replace(/\/$/, '')}/api/${path.map(encodeURIComponent).join('/')}${url.search}`;

  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) headers.set(name, value);
  });

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await (cfg.fetchImpl ?? fetch)(target, {
      method: req.method,
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(cfg.timeoutMs),
      ...(hasBody ? { body: await req.arrayBuffer() } : {}),
    });
  } catch (err) {
    return (err as Error).name === 'TimeoutError'
      ? errorResponse(504, 'UPSTREAM_ERROR', 'The server took too long to respond')
      : errorResponse(502, 'SERVICE_UNAVAILABLE', 'The server is unavailable');
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name)) out.set(name, value);
  });
  // each Set-Cookie must stay a separate header (access, refresh and session cookies)
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}
