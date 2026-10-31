import { DurableObject } from 'cloudflare:workers';
import { Hub as HubLogic, type Env as HubEnv, type Store } from './hub';

interface Env extends HubEnv {
  HUB: DurableObjectNamespace<Hub>;
  /** The packer and phone viewer pages (absent when the Worker is deployed without a build). */
  ASSETS?: Fetcher;
}

/** The single Durable Object that owns every vault record; requests are processed one at a time. */
export class Hub extends DurableObject<Env> {
  private logic: HubLogic;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.logic = new HubLogic(ctx.storage as unknown as Store, env);
  }

  async fetch(request: Request): Promise<Response> {
    return this.logic.handle(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // A cloud link (/v/<vault id>) is the phone/online viewer page; it reads the id from the address.
    if (/^\/v\/[a-z0-9]{1,64}\/?$/.test(url.pathname) && env.ASSETS) return viewerPage(env.ASSETS, url);
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('隨身密閱伺服器運作中。請在「打包＋管理」頁面貼上這個網址。', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
      });
    }
    // Pass the caller's address to the Durable Object (it cannot see request.cf itself).
    const headers = new Headers(request.headers);
    headers.set('x-vv-ip', request.headers.get('cf-connecting-ip') ?? '');
    headers.set('x-vv-country', String((request as { cf?: { country?: string } }).cf?.country ?? ''));
    const stub = env.HUB.get(env.HUB.idFromName('hub'));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

/** Serves open.html under the link's own address (static asset hosting may redirect /open.html to /open). */
async function viewerPage(assets: Fetcher, url: URL): Promise<Response> {
  let res = await assets.fetch(new URL('/open.html', url).toString());
  for (let i = 0; i < 2 && res.status >= 300 && res.status < 400 && res.headers.get('location'); i++) {
    res = await assets.fetch(new URL(res.headers.get('location')!, url).toString());
  }
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(res.body, { status: res.status, headers });
}
