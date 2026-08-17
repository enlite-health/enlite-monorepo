import type { Server } from 'http';
import type { AddressInfo } from 'net';

/**
 * O 403 DE RUNTIME do deny-when-undeclared (task 3.4) — a metade que o
 * inventário não prova.
 *
 * `permission-route-inventory` afirma que nenhuma rota administrativa ficou sem
 * declaração; este afirma o que acontece com uma que fique. A spec
 * `permission-enforcement` pede os dois: "o teste de rotas falha listando a
 * rota, **e em runtime a rota responde 403**".
 *
 * Sobe o WIRING REAL (`createPermissionsBoundary` monta o guard, e
 * `runPermissionsBootTasks` publica o índice a partir da varredura do router de
 * verdade), com o banco do stack e2e — nada de mock. A rota `/api/admin/rota-
 * nao-declarada` existe só neste arquivo: é o "desenvolvedor esqueceu de
 * declarar" reproduzido.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('deny-when-undeclared em runtime (wiring real, banco real)', () => {
  let server: Server;
  let baseUrl: string;
  const envAnterior: Record<string, string | undefined> = {};

  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  beforeAll(async () => {
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('DATABASE_URL', DATABASE_URL);

    const express = (await import('express')).default;
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { createPermissionsBoundary, runPermissionsBootTasks } = await import(
      '../../src/bootstrap/wirePermissionsModule'
    );

    const app = express();
    const db = DatabaseConnection.getInstance();
    // Passo 1 do wiring: cria o módulo e monta o guard ANTES das rotas.
    const boundary = createPermissionsBoundary({
      app,
      pool: db.getPool(),
      systemPool: db.getSystemPool(),
    });

    // Uma rota administrativa que ninguém declarou — o esquecimento reproduzido.
    app.post('/api/admin/rota-nao-declarada', (_req, res) => res.json({ chegou: true }));
    // E uma isenta da D116, que tem que continuar passando.
    app.get('/api/admin/auth/profile', (_req, res) => res.json({ chegou: true }));
    // E uma fora do domínio governado.
    app.get('/api/workers/me', (_req, res) => res.json({ chegou: true }));

    // Passo 3: varre o router pronto e publica o índice que o guard consulta.
    // ⚠️ Este ambiente NÃO tem o marcador de migração de dados; o boot segue
    // assim mesmo porque quem gateia é o `PERMISSION_ENGINE_ENABLED` do
    // processo real — aqui interessa o índice publicado.
    await runPermissionsBootTasks(app, boundary).catch(() => undefined);

    const servidor = app.listen(0);
    await new Promise<void>((resolve) => servidor.once('listening', () => resolve()));
    server = servidor;
    baseUrl = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  async function chamar(metodo: string, caminho: string) {
    const res = await fetch(`${baseUrl}${caminho}`, { method: metodo });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  it('rota administrativa sem declaração responde 403 e NÃO chega no handler', async () => {
    const res = await chamar('POST', '/api/admin/rota-nao-declarada');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'undeclared_route' });
    expect(res.body.chegou).toBeUndefined();
  });

  it('caixa diferente no caminho também é negada (o Express despacha igual)', async () => {
    const res = await chamar('POST', '/API/ADMIN/rota-nao-declarada');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'undeclared_route' });
  });

  it('rota isenta da D116 continua passando', async () => {
    expect(await chamar('GET', '/api/admin/auth/profile')).toMatchObject({ status: 200 });
  });

  it('rota fora do domínio governado nem é olhada', async () => {
    expect(await chamar('GET', '/api/workers/me')).toMatchObject({ status: 200 });
  });
});
