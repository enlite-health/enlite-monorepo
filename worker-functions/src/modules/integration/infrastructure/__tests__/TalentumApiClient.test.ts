/**
 * TalentumApiClient.test.ts — cliente da Talentum API v2 (spec 040).
 *
 * Nenhum teste toca a rede: `fetch` é mockado. Login (RSA-OAEP) é exercitado de ponta a ponta
 * contra o mock; o host/Origin v2 é o critério SC-001 (voltar a constante para a v1 derruba).
 */

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import {
  TalentumApiClient,
  DEFAULT_TALENTUM_BASE_URL,
  TALENTUM_ORIGIN,
  buildPublicPrescreeningUrl,
  toV2ProjectName,
  TALENTUM_PROJECT_NAME_MAX,
} from '../TalentumApiClient';
import type { TalentumQuestionWithId } from '../../domain/ITalentumApiClient';

// ── Helpers ──────────────────────────────────────────────────────

const V2_HOST = 'https://api.v2.talentum.chat';
const V2_ORIGIN = 'https://www.v2.talentum.chat';

function res(status: number, body?: unknown, textBody = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(textBody),
    headers: { getSetCookie: () => [] as string[] },
  };
}

function loginRes() {
  return {
    ...res(200, {}),
    headers: {
      getSetCookie: () => [
        'tl_auth=mock-auth-token; Path=/; HttpOnly',
        'tl_refresh=mock-refresh-token; Path=/; HttpOnly',
      ],
    },
  };
}

/** [url, init] da chamada N (0 = login). */
function call(n: number): [string, RequestInit] {
  return mockFetch.mock.calls[n] as [string, RequestInit];
}
function url(n: number): string {
  return call(n)[0];
}
function method(n: number): string | undefined {
  return call(n)[1].method;
}
function body(n: number): any {
  return JSON.parse(call(n)[1].body as string);
}

const QUESTION = {
  question: '¿Experiencia?',
  type: 'text' as const,
  responseType: ['text', 'audio'] as ('text' | 'audio')[],
  desiredResponse: 'más de 1 año',
  weight: 5,
  required: true,
  analyzed: true,
  earlyStoppage: false,
};

const PRESCREENING_V2 = {
  _id: 'ps-1',
  projectId: 'proj-1',
  title: 'EN 1#1',
  timestamp: '2026-10-02T10:00:00.000Z',
  publicId: 'pub-uuid-1',
  slug: 'en-1-1',
  active: true,
  jobDescription: { text: 'descripción del puesto', truncated: false },
  questions: [
    {
      questionId: 'q-1',
      question: '¿Experiencia?',
      type: 'text',
      responseType: ['text', 'audio'],
      required: true,
      analyzed: true,
      earlyStoppage: false,
      idealResponse: 'más de 1 año',
      acceptableResponse: '',
      redFlags: '',
      validation: '',
      weight: 5,
      options: [],
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────

describe('TalentumApiClient (API v2)', () => {
  let client: TalentumApiClient;
  const ENV_KEY = 'TALENTUM_API_BASE_URL';
  const originalEnv = process.env[ENV_KEY];

  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env[ENV_KEY];
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    client = new TalentumApiClient('test@talentum.chat', 'test-password');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  // ── SC-001: host v2 por padrão ─────────────────────────────────

  describe('host e Origin v2 (SC-001)', () => {
    it('as constantes apontam para a v2', () => {
      expect(DEFAULT_TALENTUM_BASE_URL).toBe(V2_HOST);
      expect(TALENTUM_ORIGIN).toBe(V2_ORIGIN);
    });

    it('sem a env, o login vai ao host v2 com Origin v2', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings();

      expect(url(0)).toBe(`${V2_HOST}/auth/login`);
      expect((call(0)[1].headers as Record<string, string>).Origin).toBe(V2_ORIGIN);
      expect((call(1)[1].headers as Record<string, string>).Origin).toBe(V2_ORIGIN);
    });

    it('a senha vai cifrada (base64 RSA-OAEP, nunca em texto puro)', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings();

      const sent = body(0);
      expect(sent.email).toBe('test@talentum.chat');
      expect(sent.password).not.toBe('test-password');
      expect(Buffer.from(sent.password, 'base64')).toHaveLength(256);
    });

    it('com a env setada, login e request vão ao host do stub', async () => {
      process.env[ENV_KEY] = 'http://stub.local:9914';
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings();

      expect(url(0)).toBe('http://stub.local:9914/auth/login');
      expect(url(1)).toBe('http://stub.local:9914/projects');
    });

    it('env vazia ou só com espaços cai no default v2', async () => {
      process.env[ENV_KEY] = '   ';
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings();

      expect(url(0)).toBe(`${V2_HOST}/auth/login`);
    });
  });

  // ── link web ────────────────────────────────────────────────────

  describe('buildPublicPrescreeningUrl', () => {
    it('deriva o link web do publicId', () => {
      expect(buildPublicPrescreeningUrl('abc')).toBe(`${V2_ORIGIN}/public/pre-screening/abc/chat`);
    });
  });

  // ── createPrescreening ──────────────────────────────────────────

  describe('createPrescreening', () => {
    function mockHappyCreate() {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(201, { projectId: 'proj-1' })); // POST /projects
      mockFetch.mockResolvedValueOnce(res(204)); // PATCH prescreening
      mockFetch.mockResolvedValueOnce(res(200, { text: 'descripción', truncated: false })); // PUT job-description
      mockFetch.mockResolvedValueOnce(res(204)); // POST complete-submodule
      mockFetch.mockResolvedValueOnce(res(200)); // POST init
      mockFetch.mockResolvedValueOnce(res(200, PRESCREENING_V2)); // GET prescreening
    }

    it('faz POST /projects → PATCH → PUT job-description → complete-submodule → init → GET prescreening, nessa ordem', async () => {
      mockHappyCreate();

      const result = await client.createPrescreening({
        title: 'EN 1#1',
        description: 'descripción',
        questions: [QUESTION],
        faq: [{ question: 'q', answer: 'a' }],
      });

      expect(result).toEqual({ projectId: 'proj-1', publicId: 'pub-uuid-1' });
      expect(mockFetch).toHaveBeenCalledTimes(7);
      expect([method(1), url(1)]).toEqual(['POST', `${V2_HOST}/projects`]);
      expect([method(2), url(2)]).toEqual(['PATCH', `${V2_HOST}/projects/proj-1/prescreening`]);
      expect([method(3), url(3)]).toEqual(['PUT', `${V2_HOST}/projects/proj-1/prescreening/job-description`]);
      expect([method(4), url(4)]).toEqual(['POST', `${V2_HOST}/projects/proj-1/complete-submodule`]);
      expect(body(4)).toEqual({ submodule: 'PRESCREENING' });
      // `init` é o que tira o projeto de DRAFT → IN_PROGRESS; sem ele o link público fica "Enlace no válido"
      expect([method(5), url(5)]).toEqual(['POST', `${V2_HOST}/projects/proj-1/init`]);
      expect([method(6), url(6)]).toEqual(['GET', `${V2_HOST}/projects/proj-1/prescreening`]);
    });

    it('POST /projects manda projeto FULL só de prescreening com o título', async () => {
      mockHappyCreate();
      await client.createPrescreening({ title: 'EN 1#1', description: 'd', questions: [QUESTION] });

      expect(body(1)).toEqual({
        name: 'EN 1#1',
        type: 'FULL',
        campaigns: 'MANUAL',
        prescreening: true,
      });
    });

    it('name > 50 caracteres: o POST /projects e o título do PATCH vão cortados em 50 (a v2 devolve 400 acima disso)', async () => {
      mockHappyCreate();
      const longTitle = 'EN 123#4 - Acompañante terapéutico para paciente con TEA nivel 2 en Recoleta';
      expect(longTitle.length).toBeGreaterThan(50);

      await client.createPrescreening({ title: longTitle, description: 'd', questions: [QUESTION] });

      expect(body(1).name.length).toBeLessThanOrEqual(TALENTUM_PROJECT_NAME_MAX);
      expect(body(1).name).toBe(longTitle.slice(0, 50).trimEnd());
      expect(body(2).title).toBe(body(1).name);
    });

    it('toV2ProjectName: título curto passa intacto; corte determinístico sem espaço na ponta', () => {
      expect(toV2ProjectName('EN 1#1')).toBe('EN 1#1');
      expect(toV2ProjectName('x'.repeat(50))).toBe('x'.repeat(50));
      expect(toV2ProjectName('x'.repeat(49) + ' yyy')).toBe('x'.repeat(49));
      expect(toV2ProjectName('x'.repeat(80))).toHaveLength(50);
    });

    it('PATCH manda tipo WEB, perguntas mapeadas (desiredResponse→idealResponse, vazios) e webForm', async () => {
      mockHappyCreate();
      await client.createPrescreening({
        title: 'EN 1#1',
        description: 'd',
        questions: [QUESTION],
        askForCv: true,
        cvRequired: true,
      });

      const patch = body(2);
      expect(patch).toMatchObject({
        title: 'EN 1#1',
        type: 'WEB',
        showJobDescription: true,
        askForCv: true,
        cvRequired: true,
        askCuit: false,
        language: 'spanish',
        webForm: { askEmail: true, askPhone: true },
      });
      expect(patch.questions).toEqual([
        {
          question: '¿Experiencia?',
          type: 'text',
          responseType: ['text', 'audio'],
          idealResponse: 'más de 1 año',
          acceptableResponse: '',
          redFlags: '',
          validation: '',
          weight: 5,
          required: true,
          analyzed: true,
          earlyStoppage: false,
        },
      ]);
      expect(patch.questions[0]).not.toHaveProperty('desiredResponse');
    });

    it('askForCv/cvRequired default false', async () => {
      mockHappyCreate();
      await client.createPrescreening({ title: 't', description: 'd', questions: [] });

      expect(body(2)).toMatchObject({ askForCv: false, cvRequired: false });
    });

    it('PUT job-description manda {text} e a FAQ NÃO é enviada em nenhuma chamada (decisão g)', async () => {
      mockHappyCreate();
      await client.createPrescreening({
        title: 't',
        description: 'descripción',
        questions: [QUESTION],
        faq: [{ question: 'pergunta-faq-secreta', answer: 'resposta-faq-secreta' }],
      });

      expect(body(3)).toEqual({ text: 'descripción' });
      for (let i = 1; i <= 6; i++) {
        expect(JSON.stringify(call(i)[1].body ?? '')).not.toContain('faq-secreta');
      }
    });

    it('PATCH 400 → apaga o projeto recém-criado e relança o erro original', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(201, { projectId: 'proj-9' }));
      mockFetch.mockResolvedValueOnce(res(400, undefined, 'bad questions'));
      mockFetch.mockResolvedValueOnce(res(204)); // DELETE

      await expect(
        client.createPrescreening({ title: 't', description: 'd', questions: [QUESTION] }),
      ).rejects.toThrow('HTTP 400');

      expect([method(3), url(3)]).toEqual(['DELETE', `${V2_HOST}/projects/proj-9`]);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('PUT falha → também apaga o projeto', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(201, { projectId: 'proj-8' }));
      mockFetch.mockResolvedValueOnce(res(204));
      mockFetch.mockResolvedValueOnce(res(500, undefined, 'boom'));
      mockFetch.mockResolvedValueOnce(res(204)); // DELETE

      await expect(
        client.createPrescreening({ title: 't', description: 'd', questions: [] }),
      ).rejects.toThrow('HTTP 500');

      expect([method(4), url(4)]).toEqual(['DELETE', `${V2_HOST}/projects/proj-8`]);
    });

    it('se o DELETE do rollback também falha: relança o erro ORIGINAL e registra o id órfão', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(201, { projectId: 'proj-7' }));
      mockFetch.mockResolvedValueOnce(res(400, undefined, 'bad'));
      mockFetch.mockResolvedValueOnce(res(500, undefined, 'delete-boom'));

      await expect(
        client.createPrescreening({ title: 't', description: 'd', questions: [] }),
      ).rejects.toThrow('PATCH /projects/proj-7/prescreening — HTTP 400');

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('proj-7'));
    });

    it('init falha → apaga o projeto (nunca deixa DRAFT órfão) e relança', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(201, { projectId: 'proj-5' }));
      mockFetch.mockResolvedValueOnce(res(204));
      mockFetch.mockResolvedValueOnce(res(200, {}));
      mockFetch.mockResolvedValueOnce(res(204));
      mockFetch.mockResolvedValueOnce(res(400, undefined, 'cannot init'));
      mockFetch.mockResolvedValueOnce(res(204)); // DELETE

      await expect(
        client.createPrescreening({ title: 't', description: 'd', questions: [] }),
      ).rejects.toThrow('POST /projects/proj-5/init — HTTP 400');

      expect([method(6), url(6)]).toEqual(['DELETE', `${V2_HOST}/projects/proj-5`]);
    });

    it('rollback que falha com valor não-Error (rede caiu) também é registrado', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(201, { projectId: 'proj-6' }));
      mockFetch.mockResolvedValueOnce(res(400, undefined, 'bad'));
      mockFetch.mockRejectedValueOnce('net-down');

      await expect(
        client.createPrescreening({ title: 't', description: 'd', questions: [] }),
      ).rejects.toThrow('HTTP 400');

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('net-down'));
    });

    it('POST /projects falha → nada a apagar, erro propagado', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(403, undefined, 'nope'));

      await expect(
        client.createPrescreening({ title: 't', description: 'd', questions: [] }),
      ).rejects.toThrow('HTTP 403');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── getPrescreening ─────────────────────────────────────────────

  describe('getPrescreening', () => {
    it('compõe 2 GETs (projeto + prescreening) e deriva o link web do publicId', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(
        res(200, { project: { _id: 'proj-1', name: 'EN 1#1', status: 'IN_PROGRESS', type: 'FULL', myRole: 'OWNER' } }),
      );
      mockFetch.mockResolvedValueOnce(res(200, PRESCREENING_V2));

      const p = await client.getPrescreening('proj-1');

      expect([method(1), url(1)]).toEqual(['GET', `${V2_HOST}/projects/proj-1`]);
      expect([method(2), url(2)]).toEqual(['GET', `${V2_HOST}/projects/proj-1/prescreening`]);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(p).toMatchObject({
        projectId: 'proj-1',
        publicId: 'pub-uuid-1',
        title: 'EN 1#1',
        description: 'descripción del puesto',
        whatsappUrl: `${V2_ORIGIN}/public/pre-screening/pub-uuid-1/chat`,
        slug: 'en-1-1',
        active: true,
        timestamp: '2026-10-02T10:00:00.000Z',
        faq: [],
        status: 'IN_PROGRESS',
        type: 'FULL',
        myRole: 'OWNER',
      });
      expect(p.questions).toEqual([
        {
          questionId: 'q-1',
          question: '¿Experiencia?',
          type: 'text',
          responseType: ['text', 'audio'],
          desiredResponse: 'más de 1 año',
          weight: 5,
          required: true,
          analyzed: true,
          earlyStoppage: false,
        },
      ]);
    });

    it('sem jobDescription nem questions: description vazia e questions []', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { project: { _id: 'proj-2', name: 'x' } }));
      mockFetch.mockResolvedValueOnce(res(200, { publicId: 'pub-2', slug: 's', active: false, timestamp: 't' }));

      const p = await client.getPrescreening('proj-2');

      expect(p.description).toBe('');
      expect(p.questions).toEqual([]);
      expect(p.active).toBe(false);
    });

    it('404 → erro "projeto não existe na Talentum v2" (mantém HTTP 404 para os consumidores)', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(404, undefined, 'Project with provided properties does not exist'));

      const err = await client.getPrescreening('morto').catch((e: Error) => e);

      expect((err as Error).message).toContain('HTTP 404');
      expect((err as Error).message).toContain('projeto não existe na Talentum v2');
    });

    it('prescreening inativo (400) propaga o erro', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { project: { _id: 'p', name: 'x' } }));
      mockFetch.mockResolvedValueOnce(res(400, undefined, 'inactive'));

      await expect(client.getPrescreening('p')).rejects.toThrow('HTTP 400');
    });
  });

  // ── updatePrescreening ──────────────────────────────────────────

  describe('updatePrescreening', () => {
    const q: TalentumQuestionWithId = { ...QUESTION, questionId: 'q-1' };

    it('PATCH prescreening (título + perguntas com questionId) e PUT job-description', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(204));
      mockFetch.mockResolvedValueOnce(res(200, { text: 'nueva', truncated: false }));

      await client.updatePrescreening('proj-1', {
        title: 'EN 1#1',
        description: 'nueva',
        questions: [q],
        faq: [{ question: 'x', answer: 'y' }],
      });

      expect([method(1), url(1)]).toEqual(['PATCH', `${V2_HOST}/projects/proj-1/prescreening`]);
      expect([method(2), url(2)]).toEqual(['PUT', `${V2_HOST}/projects/proj-1/prescreening/job-description`]);
      expect(body(1).title).toBe('EN 1#1');
      expect(body(1).type).toBe('WEB'); // a v2 real rejeita o PATCH sem `type` (400)
      expect(body(1).questions[0]).toMatchObject({
        questionId: 'q-1',
        idealResponse: 'más de 1 año',
        acceptableResponse: '',
        redFlags: '',
        validation: '',
      });
      expect(body(2)).toEqual({ text: 'nueva' });
      expect(JSON.stringify(call(1)[1].body)).not.toContain('"faq"');
    });

    it('título > 50 caracteres também é cortado no PATCH de edição', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(204));
      mockFetch.mockResolvedValueOnce(res(200, { text: 'n', truncated: false }));

      await client.updatePrescreening('proj-1', { title: 'y'.repeat(70), description: 'n', questions: [q] });

      expect(body(1).title).toHaveLength(50);
    });

    it('pergunta sem questionId não envia a chave', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(204));
      mockFetch.mockResolvedValueOnce(res(200, {}));

      await client.updatePrescreening('proj-1', {
        title: 't',
        description: 'd',
        questions: [QUESTION as unknown as TalentumQuestionWithId],
      });

      expect(body(1).questions[0]).not.toHaveProperty('questionId');
    });

    it('403 (conta VIEWER) → erro distinguível com HTTP 403 e "sem permissão"', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(403, undefined, 'You are not allowed to access this project'));

      const err = await client
        .updatePrescreening('viewer', { title: 't', description: 'd', questions: [] })
        .catch((e: Error) => e);

      expect((err as Error).message).toContain('HTTP 403');
      expect((err as Error).message).toContain('sem permissão');
      expect(mockFetch).toHaveBeenCalledTimes(2); // PUT nunca é tentado
    });
  });

  // ── deletePrescreening ──────────────────────────────────────────

  describe('deletePrescreening', () => {
    it('DELETE /projects/:id e devolve void', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(204));

      await expect(client.deletePrescreening('proj-1')).resolves.toBeUndefined();
      expect([method(1), url(1)]).toEqual(['DELETE', `${V2_HOST}/projects/proj-1`]);
    });
  });

  // ── listagem ────────────────────────────────────────────────────

  describe('listPrescreenings / listAllPrescreenings', () => {
    const item = (id: string) => ({ _id: id, name: `n-${id}`, status: 'IN_PROGRESS', type: 'FULL', myRole: 'OWNER' });

    it('envia page e onlyOwnedByUser e mapeia o item da lista', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [item('a')], count: 5 }));

      const r = await client.listPrescreenings({ page: 2, onlyOwnedByUser: true });

      expect(url(1)).toBe(`${V2_HOST}/projects?page=2&onlyOwnedByUser=true`);
      expect(r.count).toBe(5);
      expect(r.projects[0]).toMatchObject({
        projectId: 'a',
        title: 'n-a',
        publicId: '',
        whatsappUrl: '',
        status: 'IN_PROGRESS',
        type: 'FULL',
        myRole: 'OWNER',
        questions: [],
        faq: [],
      });
    });

    it('sem opts, vai a /projects sem query', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings();

      expect(url(1)).toBe(`${V2_HOST}/projects`);
    });

    it('onlyOwnedByUser=false vai na query', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings({ onlyOwnedByUser: false });

      expect(url(1)).toContain('onlyOwnedByUser=false');
    });

    it('listAll pagina até alcançar `count` (sem pedir página extra)', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [item('1'), item('2')], count: 3 }));
      mockFetch.mockResolvedValueOnce(res(200, { projects: [item('3')], count: 3 }));

      const all = await client.listAllPrescreenings();

      expect(all.map((p) => p.projectId)).toEqual(['1', '2', '3']);
      expect(mockFetch).toHaveBeenCalledTimes(3); // login + 2 páginas
      expect(url(1)).toBe(`${V2_HOST}/projects?page=1&onlyOwnedByUser=false`);
      expect(url(2)).toBe(`${V2_HOST}/projects?page=2&onlyOwnedByUser=false`);
    });

    it('listAll para em página vazia mesmo que count prometa mais (sem loop infinito)', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [item('1')], count: 99 }));
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 99 }));

      const all = await client.listAllPrescreenings();

      expect(all).toHaveLength(1);
    });

    it('listAll com conta vazia devolve []', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      expect(await client.listAllPrescreenings()).toEqual([]);
    });
  });

  // ── candidatos ──────────────────────────────────────────────────

  describe('candidatos', () => {
    it('listCandidates → GET /projects/:id/prescreening/candidates?page=N', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { candidates: [{ profileId: 'pf-1' }], total: 7 }));

      const r = await client.listCandidates('proj-1', 3);

      expect(url(1)).toBe(`${V2_HOST}/projects/proj-1/prescreening/candidates?page=3`);
      expect(r).toEqual({ candidates: [{ profileId: 'pf-1' }], total: 7 });
    });

    it('listReadyForInterview → GET /projects/:id/ready-for-interview?page=N', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { candidates: [], total: 0 }));

      const r = await client.listReadyForInterview('proj-1', 2);

      expect(url(1)).toBe(`${V2_HOST}/projects/proj-1/ready-for-interview?page=2`);
      expect(r).toEqual({ candidates: [], total: 0 });
    });
  });

  // ── factories ───────────────────────────────────────────────────

  describe('static factories', () => {
    afterEach(() => {
      delete process.env.TALENTUM_API_EMAIL;
      delete process.env.TALENTUM_API_PASSWORD;
    });

    it('fromEnv lança se env vars ausentes', () => {
      expect(() => TalentumApiClient.fromEnv()).toThrow('TALENTUM_API_EMAIL and TALENTUM_API_PASSWORD must be set');
    });

    it('fromEnv cria instância com env vars', () => {
      process.env.TALENTUM_API_EMAIL = 'e@test.com';
      process.env.TALENTUM_API_PASSWORD = 'p123';
      expect(TalentumApiClient.fromEnv()).toBeInstanceOf(TalentumApiClient);
    });

    it('create usa fromEnv quando env vars presentes', async () => {
      process.env.TALENTUM_API_EMAIL = 'e@test.com';
      process.env.TALENTUM_API_PASSWORD = 'p123';
      expect(await TalentumApiClient.create()).toBeInstanceOf(TalentumApiClient);
    });

    describe('fromSecretManager', () => {
      const mockAccess = jest.fn();

      beforeEach(() => {
        mockAccess.mockReset();
        jest.resetModules();
        jest.doMock('@google-cloud/secret-manager', () => ({
          SecretManagerServiceClient: jest.fn().mockImplementation(() => ({ accessSecretVersion: mockAccess })),
        }));
      });
      afterEach(() => {
        jest.dontMock('@google-cloud/secret-manager');
        delete process.env.GCP_PROJECT_ID;
      });

      it('lê os dois segredos do projeto e cria o cliente; create cai aqui sem env', async () => {
        process.env.GCP_PROJECT_ID = 'meu-proj';
        mockAccess
          .mockResolvedValueOnce([{ payload: { data: { toString: () => 'sm@x.com' } } }])
          .mockResolvedValueOnce([{ payload: { data: { toString: () => 'sm-pass' } } }]);
        const { TalentumApiClient: Fresh } = require('../TalentumApiClient');

        expect(await Fresh.create()).toBeInstanceOf(Fresh);
        expect(mockAccess).toHaveBeenNthCalledWith(1, { name: 'projects/meu-proj/secrets/talentum-api-email/versions/latest' });
        expect(mockAccess).toHaveBeenNthCalledWith(2, { name: 'projects/meu-proj/secrets/talentum-api-password/versions/latest' });
      });

      it('projeto default enlite-prd', async () => {
        mockAccess
          .mockResolvedValueOnce([{ payload: { data: { toString: () => 'a' } } }])
          .mockResolvedValueOnce([{ payload: { data: { toString: () => 'b' } } }]);
        const { TalentumApiClient: Fresh } = require('../TalentumApiClient');

        await Fresh.fromSecretManager();

        expect(mockAccess).toHaveBeenNthCalledWith(1, { name: 'projects/enlite-prd/secrets/talentum-api-email/versions/latest' });
      });

      it('segredo vazio → erro', async () => {
        mockAccess.mockResolvedValueOnce([{ payload: {} }]).mockResolvedValueOnce([{ payload: {} }]);
        const { TalentumApiClient: Fresh } = require('../TalentumApiClient');

        await expect(Fresh.fromSecretManager()).rejects.toThrow('secrets returned empty values');
      });
    });
  });

  // ── auth ────────────────────────────────────────────────────────

  describe('auth', () => {
    it('reaproveita a sessão: 2 requests = 1 login', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));

      await client.listPrescreenings();
      await client.listPrescreenings();

      expect(mockFetch.mock.calls.filter((c) => String(c[0]).endsWith('/auth/login'))).toHaveLength(1);
      expect((call(1)[1].headers as Record<string, string>).Cookie).toBe(
        'tl_auth=mock-auth-token; tl_refresh=mock-refresh-token',
      );
    });

    it('sessão expirada refaz o login', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1_000);
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));
      await client.listPrescreenings();

      nowSpy.mockReturnValue(1_000 + 10_000 * 1000 + 1);
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(200, { projects: [], count: 0 }));
      await client.listPrescreenings();

      expect(mockFetch.mock.calls.filter((c) => String(c[0]).endsWith('/auth/login'))).toHaveLength(2);
    });

    it('lança erro se login falha', async () => {
      mockFetch.mockResolvedValueOnce(res(401, undefined, 'Unauthorized'));
      await expect(client.listPrescreenings()).rejects.toThrow('login failed');
    });

    it('lança erro se cookies ausentes no login', async () => {
      mockFetch.mockResolvedValueOnce(res(200, {}));
      await expect(client.listPrescreenings()).rejects.toThrow('tl_auth/tl_refresh cookies were not found');
    });

    it('login sem getSetCookie (runtime antigo) também falha com a mesma mensagem', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(''), headers: {} });
      await expect(client.listPrescreenings()).rejects.toThrow('cookies were not found');
    });

    it('propaga erro HTTP genérico em requests', async () => {
      mockFetch.mockResolvedValueOnce(loginRes());
      mockFetch.mockResolvedValueOnce(res(500, undefined, 'Internal Server Error'));
      await expect(client.listPrescreenings()).rejects.toThrow('HTTP 500');
    });
  });
});
