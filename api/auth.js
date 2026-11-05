// Repasse do login (Neon Auth) pelo próprio domínio do app.
// O Safari/iPhone bloqueia cookies de outro domínio; passando por /api/auth,
// o cookie de sessão fica no domínio do app e o login funciona em qualquer navegador.
export const config = { runtime: 'edge' };

const NEON_AUTH = 'https://ep-sweet-mouse-b6y8t2xa.neonauth.c-2.sa-east-1.aws.neon.tech/neondb/auth';

// cabeçalhos que não devem seguir para o Neon (identificam o servidor intermediário)
const NAO_REPASSAR = new Set(['host', 'connection', 'content-length', 'forwarded', 'x-real-ip', 'accept-encoding']);
const naoRepassar = h => NAO_REPASSAR.has(h) || h.startsWith('x-forwarded-') || h.startsWith('x-vercel-') || h.startsWith('cf-');

export default async function handler(request) {
  const url = new URL(request.url);
  const caminho = url.searchParams.get('path') || '';
  url.searchParams.delete('path');
  if (!/^[A-Za-z0-9/_.-]*$/.test(caminho) || caminho.includes('..')) {
    return new Response('Caminho inválido', { status: 400 });
  }
  const destino = `${NEON_AUTH}/${caminho}${url.search}`;

  const headers = new Headers();
  for (const [k, v] of request.headers) if (!naoRepassar(k.toLowerCase())) headers.set(k, v);

  const temCorpo = !['GET', 'HEAD'].includes(request.method);
  const resp = await fetch(destino, {
    method: request.method,
    headers,
    body: temCorpo ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  });

  const saida = new Headers();
  for (const [k, v] of resp.headers) {
    const kl = k.toLowerCase();
    if (kl === 'set-cookie' || kl === 'content-encoding' || kl === 'content-length' || kl === 'transfer-encoding') continue;
    saida.set(k, v);
  }
  const cookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of cookies) saida.append('set-cookie', c);
  saida.set('cache-control', 'no-store');

  return new Response(resp.body, { status: resp.status, headers: saida });
}
