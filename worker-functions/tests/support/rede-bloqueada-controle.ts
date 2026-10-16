/**
 * Corpo ÚNICO do teste-controle de rede (spec 050, R-16), registrado por um arquivo de teste em CADA runner jest do backend:
 *   - tests/unit/__tests__/rede-bloqueada.controle.test.ts            (npm test — _backend-quality.yml)
 *   - tests/e2e/rede-bloqueada.controle.test.ts                      (npm run test:e2e — backend-e2e.yml)
 *   - tests/e2e-real-auth/rede-bloqueada.controle.real.test.ts       (npm run test:e2e:real-auth — backend-e2e.yml)
 *
 * O teste-controle do bloqueio de rede. Sem ele, "nenhuma chamada saiu" seria um zero sem medição:
 *  (a) tenta alcançar `mcp.tactiq.io` por CADA camada e EXIGE a falha pelo bloqueio (código + mensagem da guarda,
 *      não "falhou porque o DNS estava fora");
 *  (b) controle do controle: um servidor em `localhost`, subido aqui, É alcançado pelas mesmas camadas.
 * O nome `rede-bloqueada.controle` é fixo: o CI conta as linhas deste nome no log (um por job de teste).
 * A guarda mora em `scripts/rede-bloqueada-em-teste.cjs` e entra pelo `setupFiles` de cada jest.config.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guarda = require('../../../scripts/rede-bloqueada-em-teste.cjs') as {
  sondar: (camada: string, host: string, port?: number) => Promise<{ conectou: boolean; bloqueada: boolean; erro?: { code?: string; message: string } }>;
};

const CAMADAS = ['net', 'tls', 'http', 'https', 'http2', 'fetch'] as const;

export function registrarControleDeRede(): void {
  describe('rede-bloqueada.controle', () => {
    describe('(a) terceiro é bloqueado pela guarda, em cada camada', () => {
      it.each(CAMADAS)('%s -> mcp.tactiq.io falha com "rede bloqueada em teste"', async (camada) => {
        const r = await guarda.sondar(camada, 'mcp.tactiq.io', 443);
        expect(r.conectou).toBe(false);
        expect(r.bloqueada).toBe(true);
        expect(r.erro?.message).toContain('rede bloqueada em teste: mcp.tactiq.io');
      });

      it('os outros terceiros da spec também (api.twilio.com, oauth2.googleapis.com)', async () => {
        for (const host of ['api.twilio.com', 'oauth2.googleapis.com']) {
          const r = await guarda.sondar('fetch', host, 443);
          expect(r.bloqueada).toBe(true);
          expect(r.erro?.message).toContain(`rede bloqueada em teste: ${host}`);
        }
      });
    });

    describe('(b) controle do controle: localhost continua alcançável', () => {
      let server: http.Server;
      let port: number;

      beforeAll(async () => {
        server = http.createServer((_req, res) => res.end('ok'));
        await new Promise<void>((resolve) => server.listen(0, resolve));
        port = (server.address() as AddressInfo).port;
      });
      afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });

      it.each(['net', 'http', 'fetch'] as const)('%s -> 127.0.0.1 conecta', async (camada) => {
        const r = await guarda.sondar(camada, '127.0.0.1', port);
        expect(r).toEqual({ conectou: true, bloqueada: false });
      });

      it('fetch -> localhost devolve o corpo do servidor local', async () => {
        const res = await fetch(`http://localhost:${port}/`);
        expect(await res.text()).toBe('ok');
      });
    });
  });
}
