/**
 * Stub da Talentum API v2 (spec 040) — em memória, com as REGRAS REAIS medidas na v2 de produção:
 *   - `POST /projects` rejeita `name` > 50 caracteres (400);
 *   - `PATCH /projects/:id/prescreening` EXIGE `type` (400);
 *   - projeto nasce `DRAFT`; `POST /projects/:id/init` o leva a `IN_PROGRESS` (só então o link vive);
 *   - o item de `GET /projects` NÃO traz `publicId` (só `_id,name,status,type,myRole`), 12 por página;
 *   - 404 em projeto inexistente; 403 em projeto `VIEWER` para escrita;
 *   - `candidates` (12/página, `{candidates,total}`): traz telefone e NÃO traz e-mail; `ready-for-interview`
 *     (só status `qualified`) traz e-mail. Candidato semeado SEMPRE sintético (nunca dado real).
 *
 * Um núcleo (`TalentumV2Stub.handle`) e dois adaptadores: `asFetch()` (unit, sem rede) e
 * `serve(port)` (e2e: o container da API aponta `TALENTUM_API_BASE_URL` para a porta do host).
 * `calls` guarda só `{ method, path }` — NUNCA corpo (título/descrição de vaga, PII).
 */

import http from 'http';
import { randomUUID } from 'crypto';

export interface StubCall {
  method: string;
  path: string;
}

export interface StubProject {
  _id: string;
  name: string;
  status: 'DRAFT' | 'IN_PROGRESS' | 'PAUSED';
  type: 'FULL' | 'ATS' | 'PHONE_CALL';
  myRole: 'OWNER' | 'VIEWER';
  publicId: string;
  slug: string;
  title: string;
  description: string;
  questions: Array<Record<string, unknown>>;
  /** `true` → `GET /prescreening` responde 400 (projeto sem prescreening ativo). */
  prescreening400?: boolean;
  candidates?: StubCandidate[];
}

export interface StubCandidate {
  profileId: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  /** Só aparece em `ready-for-interview`. */
  email?: string;
  status?: 'qualified' | 'in_doubt' | 'in_progress';
}

export interface StubReply {
  status: number;
  body?: unknown;
  text?: string;
}

const PAGE_SIZE = 12;

function pageOf<T>(all: T[], query: URLSearchParams): T[] {
  const page = Number(query.get('page') ?? '1');
  return all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

export class TalentumV2Stub {
  readonly projects = new Map<string, StubProject>();
  readonly calls: StubCall[] = [];
  private seq = 0;

  /** Semeia um projeto já existente (ex.: criado "por outra conta"). */
  seed(p: Partial<StubProject> & { _id: string; name: string }): StubProject {
    const full: StubProject = {
      status: 'IN_PROGRESS',
      type: 'FULL',
      myRole: 'OWNER',
      publicId: randomUUID(),
      slug: `slug-${p._id}`,
      title: p.name,
      description: '',
      questions: [],
      ...p,
    };
    this.projects.set(full._id, full);
    return full;
  }

  count(method: string, pathPrefix: string): number {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
  }

  handle(method: string, rawUrl: string, body?: Record<string, any>): StubReply {
    const [path, qs = ''] = rawUrl.split('?');
    this.calls.push({ method, path });
    const query = new URLSearchParams(qs);

    if (method === 'POST' && path === '/auth/login') return { status: 200, body: { ok: true } };

    if (method === 'POST' && path === '/projects') {
      const name = String(body?.name ?? '');
      if (name.length > 50) {
        return { status: 400, text: '{"message":["name must be shorter than or equal to 50 characters"]}' };
      }
      this.seq += 1;
      const id = `stub-proj-${this.seq}`;
      this.seed({ _id: id, name, status: 'DRAFT', type: 'FULL', myRole: 'OWNER' });
      return { status: 201, body: { projectId: id } };
    }

    if (method === 'GET' && path === '/projects') {
      const page = Number(query.get('page') ?? '1');
      const owned = query.get('onlyOwnedByUser') === 'true';
      const all = [...this.projects.values()].filter((p) => !owned || p.myRole === 'OWNER');
      const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      return {
        status: 200,
        body: {
          count: all.length,
          projects: slice.map((p) => ({ _id: p._id, name: p.name, status: p.status, type: p.type, myRole: p.myRole })),
        },
      };
    }

    const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return { status: 404, text: 'stub: rota não coberta' };
    const proj = this.projects.get(m[1]);
    const sub = m[2] ?? '';
    if (!proj) return { status: 404, text: '{"message":"Project not found"}' };

    if (method === 'GET' && sub === '') {
      return { status: 200, body: { project: { _id: proj._id, name: proj.name, status: proj.status, type: proj.type, myRole: proj.myRole } } };
    }
    if (method === 'GET' && sub === '/prescreening') {
      if (proj.prescreening400) return { status: 400, text: '{"message":"Prescreening is not active"}' };
      return {
        status: 200,
        body: {
          projectId: proj._id,
          title: proj.title,
          publicId: proj.publicId,
          slug: proj.slug,
          active: proj.status === 'IN_PROGRESS',
          timestamp: '2026-10-02T10:00:00.000Z',
          jobDescription: { text: proj.description, truncated: false },
          questions: proj.questions,
        },
      };
    }

    if (method === 'GET' && sub === '/prescreening/candidates') {
      const all = proj.candidates ?? [];
      return { status: 200, body: { candidates: pageOf(all, query).map(({ email: _omit, status, ...c }) => ({ ...c, status: { value: status ?? 'in_progress' } })), total: all.length } };
    }
    if (method === 'GET' && sub === '/ready-for-interview') {
      const ready = (proj.candidates ?? []).filter((c) => c.status === 'qualified');
      return { status: 200, body: { candidates: pageOf(ready, query).map(({ status: _omit, ...c }) => c), total: ready.length } };
    }

    // Escritas: conta VIEWER nunca escreve.
    if (proj.myRole === 'VIEWER') return { status: 403, text: '{"message":"You are not allowed to access this project"}' };

    if (method === 'DELETE' && sub === '') {
      this.projects.delete(proj._id);
      return { status: 204 };
    }
    if (method === 'PATCH' && sub === '/prescreening') {
      if (!body?.type) return { status: 400, text: '{"message":["type must be one of the following values: WHATSAPP, SMS, WEB"]}' };
      proj.title = String(body.title ?? proj.title);
      proj.questions = ((body.questions as Array<Record<string, unknown>>) ?? []).map((q, i) => ({
        questionId: (q.questionId as string) ?? `q-${proj._id}-${i + 1}`,
        ...q,
      }));
      return { status: 204 };
    }
    if (method === 'PUT' && sub === '/prescreening/job-description') {
      proj.description = String(body?.text ?? '');
      return { status: 200, body: { text: proj.description, truncated: false } };
    }
    if (method === 'POST' && sub === '/complete-submodule') return { status: 204 };
    if (method === 'POST' && sub === '/init') {
      proj.status = 'IN_PROGRESS';
      return { status: 200, body: {} };
    }
    return { status: 404, text: 'stub: rota não coberta' };
  }

  /** Adaptador unit: substitui `global.fetch` (sem rede). */
  asFetch(): typeof fetch {
    return (async (input: unknown, init?: { method?: string; body?: string }) => {
      const u = new URL(String(input));
      const r = this.handle(init?.method ?? 'GET', u.pathname + u.search, init?.body ? JSON.parse(init.body) : undefined);
      const isLogin = u.pathname === '/auth/login';
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
        text: async () => r.text ?? JSON.stringify(r.body ?? ''),
        headers: { getSetCookie: () => (isLogin ? ['tl_auth=stub-auth; Path=/', 'tl_refresh=stub-refresh; Path=/'] : []) },
      };
    }) as unknown as typeof fetch;
  }

  /** Adaptador e2e: servidor HTTP real (a API em container acessa por host.docker.internal). */
  serve(port: number): Promise<{ close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const r = this.handle(req.method ?? 'GET', req.url ?? '/', raw ? JSON.parse(raw) : undefined);
        const headers: Record<string, string | string[]> = { 'Content-Type': 'application/json' };
        if ((req.url ?? '').startsWith('/auth/login')) headers['Set-Cookie'] = ['tl_auth=stub-auth', 'tl_refresh=stub-refresh'];
        res.writeHead(r.status, headers);
        res.end(r.status === 204 ? undefined : (r.text ?? JSON.stringify(r.body ?? {})));
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
