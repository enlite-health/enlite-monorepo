/**
 * Stub do Short.io (semaforo-da-vaga F4) — em memória, só para o e2e. Nenhum teste toca o Short.io real:
 * o container da API aponta `SHORT_IO_BASE_URL` para a porta do host (`docker-compose.test.yml`, 9915).
 *
 * Regras que ele imita do Short.io real (as que a API usa):
 *   - `POST /links` com `Authorization` + `{ domain, originalURL, title }` → `{ shortURL, id }`;
 *   - `DELETE /links/:id` → 200, idempotente (404 vira sucesso no cliente).
 * `calls` guarda só `{ method, path, domain?, originalURL? }`: nunca a chave (`Authorization`). A `originalURL` é a URL pública
 * da vaga (caso + número, sem dado de paciente), útil para provar QUAL vaga pediu link.
 */
import http from 'http';

export interface ShortIoStubCall {
  method: string;
  path: string;
  originalURL?: string;
  domain?: string;
}

export class ShortIoStub {
  readonly calls: ShortIoStubCall[] = [];
  private seq = 0;

  /** Quantas chamadas `method path*` chegaram. */
  count(method: string, pathPrefix: string): number {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
  }

  /** Os `POST /links` cuja `originalURL` contém `trecho` (ex.: `caso884500-7`). */
  createdFor(trecho: string): ShortIoStubCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.path === '/links' && (c.originalURL ?? '').includes(trecho));
  }

  handle(method: string, path: string, body?: Record<string, unknown>): { status: number; body?: unknown } {
    this.calls.push({
      method,
      path,
      ...(body?.originalURL ? { originalURL: String(body.originalURL) } : {}),
      ...(body?.domain ? { domain: String(body.domain) } : {}),
    });
    if (method === 'POST' && path === '/links') {
      this.seq += 1;
      const domain = String(body?.domain ?? 'stub.local');
      return { status: 200, body: { shortURL: `https://${domain}/stub${this.seq}`, id: `stub-link-${this.seq}` } };
    }
    if (method === 'DELETE' && path.startsWith('/links/')) return { status: 200, body: { success: true } };
    return { status: 404, body: { error: 'not found' } };
  }

  serve(port: number): Promise<{ close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const r = this.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], raw ? JSON.parse(raw) : undefined);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body ?? {}));
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () =>
        resolve({ close: () => new Promise<void>((done) => server.close(() => done())) }),
      );
    });
  }
}
