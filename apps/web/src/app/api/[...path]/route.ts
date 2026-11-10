import { proxyToGateway } from './proxy';

/** Same-origin `/api/*` for the browser, proxied to the gateway (see ./proxy.ts). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxyToGateway(req, path, { gatewayUrl: GATEWAY_URL, timeoutMs: 15_000 });
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
