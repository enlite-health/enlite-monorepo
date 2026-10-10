/**
 * rede-bloqueada.controle — spec 050, R-16 (vitest do frontend).
 *
 * (a) tenta alcançar `mcp.tactiq.io` por cada camada e EXIGE a falha pela guarda (não pelo DNS do acaso);
 * (b) controle do controle: um servidor em `localhost`, subido aqui, É alcançado.
 * O nome `rede-bloqueada.controle` é fixo: o CI conta as linhas deste nome no log. A guarda entra pelo
 * `setupFiles` (src/test/setup.ts); o corpo da sonda vive em scripts/rede-bloqueada-em-teste.cjs.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Sonda {
  conectou: boolean;
  bloqueada: boolean;
  erro?: { code?: string; message: string };
}
const guarda = createRequire(import.meta.url)('../../../scripts/rede-bloqueada-em-teste.cjs') as {
  sondar: (camada: string, host: string, port?: number) => Promise<Sonda>;
};

const CAMADAS = ['net', 'tls', 'http', 'https', 'http2', 'fetch'] as const;

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
    let server: Server;
    let port: number;

    beforeAll(async () => {
      server = createServer((_req, res) => res.end('ok'));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it.each(['net', 'http', 'fetch'] as const)('%s -> 127.0.0.1 conecta', async (camada) => {
      expect(await guarda.sondar(camada, '127.0.0.1', port)).toEqual({ conectou: true, bloqueada: false });
    });

    it('fetch -> localhost devolve o corpo do servidor local', async () => {
      const res = await fetch(`http://localhost:${port}/`);
      expect(await res.text()).toBe('ok');
    });
  });
});
