import http from 'http';
import { AddressInfo } from 'net';

/**
 * periskopeStubServer — servidor HTTP local que responde `GET /v1/chats` no
 * FORMATO REAL da API do Periskope.
 *
 * Por que existe: o e2e roda contra a NOSSA API e o NOSSO Postgres de verdade,
 * mas não pode chamar a API do Periskope de produção — é serviço externo vivo,
 * e o repo tem incidente registrado de teste que tocou canal real. Aqui só há
 * leitura, mas a regra é dura: teste não fala com o Periskope.
 *
 * O envelope e os nomes de campo abaixo foram capturados da API de produção em
 * 08/08/2026 (774 grupos): `{ from, to, count, chats: [...] }`, e cada chat tem
 * `chat_id`, `chat_name`, `chat_type`, `member_count`, `org_id` (entre outros).
 * Os VALORES aqui são sintéticos — nome de grupo carrega nome de paciente.
 */

export interface StubChat {
  chat_id: string;
  chat_name: string | null;
  chat_type: 'group' | 'user';
  member_count: number | null;
}

export interface PeriskopeStub {
  /** Base URL a passar em PERISKOPE_BASE_URL (já com /v1). */
  baseUrl: (host: string) => string;
  port: number;
  /** Requisições recebidas — prova de que a nossa API filtrou por grupo. */
  requests: Array<{ path: string; auth: string | undefined; phone: string | undefined }>;
  close: () => Promise<void>;
}

export async function startPeriskopeStub(chats: StubChat[], port: number): Promise<PeriskopeStub> {
  const requests: PeriskopeStub['requests'] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    requests.push({
      path: req.url ?? '',
      auth: req.headers.authorization,
      phone: req.headers['x-phone'] as string | undefined,
    });

    if (req.method !== 'GET' || url.pathname !== '/v1/chats') {
      // Qualquer outra coisa (incluindo POST /message/send) é erro explícito:
      // este stub existe para provar que só LEMOS.
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub aceita apenas GET /v1/chats' }));
      return;
    }

    const wantGroups = url.searchParams.get('chat_type') === 'group';
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const filtered = (wantGroups ? chats.filter(c => c.chat_type === 'group') : chats).slice(0, limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        from: 1,
        to: filtered.length,
        count: filtered.length,
        chats: filtered.map(c => ({ ...c, org_id: '2a624dfe-0000-0000-0000-000000000000' })),
      }),
    );
  });

  await new Promise<void>(resolve => server.listen(port, '0.0.0.0', resolve));
  const bound = (server.address() as AddressInfo).port;

  return {
    port: bound,
    baseUrl: (host: string) => `http://${host}:${bound}/v1`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
