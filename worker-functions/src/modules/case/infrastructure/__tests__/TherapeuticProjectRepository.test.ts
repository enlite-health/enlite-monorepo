/**
 * TherapeuticProjectRepository — as versões do Projeto Terapêutico (migration 416, spec 017, D299).
 * Molde: `PatientContractedServiceRepository.test.ts` — mock só na FRONTEIRA (pool/client via
 * `@shared/database/DatabaseConnection`). `withActorContext` e o `TherapeuticCatalogRepository`
 * são os REAIS: o snapshot roda no MESMO client da transação, e é isso que se quer provar.
 *
 * O que este unit prova: a numeração decidida DENTRO da transação com o paciente travado
 * (`SELECT ... FOR UPDATE` na sequência de SQL), o snapshot montado no servidor (lex C19), a
 * conversão Date → ISO do driver, os dois erros nomeados (`SourceVersionNotFoundError`,
 * `ServiceNotOfPatientError` a partir do trigger `ptp_service_de_outro_paciente`) e a anulação
 * idempotente (lex C5). O SQL real é provado no e2e.
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }),
  },
}));

import {
  TherapeuticProjectRepository,
  ServiceNotOfPatientError,
  SourceVersionNotFoundError,
  PatientNotFoundForProjectError,
  type TherapeuticProjectVersionInput,
} from '../TherapeuticProjectRepository';
import { CatalogItemsUnknownError } from '../TherapeuticCatalogRepository';
import { DiagnosisUnknownError } from '../../application/pathologySegments';
import type { TerminologyPort } from '@modules/terminology/domain/TerminologyPort';

/**
 * Porta de terminologia FAKE (DIP): o "tipo de patologia" deriva do capítulo CID-11 de cada
 * diagnóstico, e este unit prova a derivação sem tocar `terminology.icd_entities` (o SQL real é
 * do e2e). `06` = capítulo de saúde mental do CID-11.
 */
const CAPITULO_06 = { code: '06', title: 'Trastornos mentales, del comportamiento y del neurodesarrollo' };
function terminologia(over: Partial<TerminologyPort> = {}): TerminologyPort {
  return {
    search: jest.fn(),
    // Entidade "existe" para qualquer URI, salvo quando o teste sobrescreve (o "não existe" é `null`, pela porta).
    getByUri: jest.fn(async (uri: string) => ({ uri })),
    ancestorsOf: jest.fn(async () => ({ chapter: CAPITULO_06 })),
    ...over,
  } as unknown as TerminologyPort;
}
const repo = (term: TerminologyPort = terminologia()) => new TherapeuticProjectRepository(undefined, term);

const PACIENTE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'v-1',
    patient_id: PACIENTE,
    major: 1,
    minor: 0,
    edited_from_version_id: null,
    contracted_service_id: 'svc-1',
    modality: 'IN_PERSON',
    contracted_service_code: 'CAREGIVER',
    diagnoses: [{ uri: 'u', code: '6A02', title: 'TEA' }],
    clinical_context: 'contexto',
    general_objective: 'objetivo',
    specific_objectives: [{ id: 'o-1', label: 'Objetivo A' }],
    activities: [{ id: 'a-1', label: 'Atividade A' }],
    pathology_types: [{ id: '06', label: CAPITULO_06.title }],
    start_date: '2026-01-01',
    end_date: '2026-06-30',
    annulled_at: null,
    annulled_by: null,
    annul_reason: null,
    country: 'AR',
    created_by: 'uid-autor',
    created_by_name: 'Ana Joulie',
    created_at: '2026-09-08T10:00:00.000Z',
    ...over,
  };
}

const CORPO: TherapeuticProjectVersionInput = {
  contractedServiceId: 'svc-1',
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'u', code: '6A02', title: 'TEA' }],
  clinicalContext: 'contexto',
  generalObjective: 'objetivo',
  specificObjectiveIds: ['o-1'],
  activityIds: ['a-1'],
  startDate: '2026-01-01',
  endDate: '2026-06-30',
  contactRefs: [],
  careTeamIds: [],
};

interface Cenario {
  /** As versões que o paciente já tem (o SELECT dentro da transação). */
  existentes?: ReturnType<typeof row>[];
  /** Ids ATIVOS de cada catálogo — o que o snapshot encontra. */
  catalogo?: Record<string, Array<{ id: string; label: string }>>;
  /** A linha relida depois do INSERT / do UPDATE de anulação. */
  criada?: ReturnType<typeof row>;
  /** Linhas devolvidas pelo UPDATE de anulação (vazio = versão inexistente ou já anulada). */
  anuladas?: Array<{ id: string }>;
  /** Erro para o client cuspir na query de negócio indicada. */
  erroEm?: { padrao: RegExp; erro: unknown };
  /** `false` = a trava `FOR UPDATE` não acha o paciente (inexistente ou invisível sob a RLS). */
  pacienteExiste?: boolean;
}

/**
 * Client de transação. Responde sozinho a BEGIN/COMMIT/ROLLBACK/set_config (como o
 * `poolMockSupport`) e registra a SEQUÊNCIA das queries de negócio — é nela que se lê o
 * `FOR UPDATE` antes da numeração.
 */
function cliente(cen: Cenario = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const catalogo = cen.catalogo ?? {
    therapeutic_specific_objectives: [{ id: 'o-1', label: 'Objetivo A' }],
    therapeutic_activities: [{ id: 'a-1', label: 'Atividade A' }],
  };
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$|set_config\s*\(/i.test(sql)) return { rows: [], rowCount: 0 };
    chamadas.push({ sql, params });
    if (cen.erroEm && cen.erroEm.padrao.test(sql)) throw cen.erroEm.erro;
    if (/FOR UPDATE/.test(sql)) return cen.pacienteExiste === false ? { rows: [], rowCount: 0 } : { rows: [{ id: PACIENTE }], rowCount: 1 };
    if (/WHERE v\.patient_id = \$1/.test(sql)) return { rows: cen.existentes ?? [], rowCount: (cen.existentes ?? []).length };
    const cat = Object.keys(catalogo).find((t) => new RegExp(`FROM ${t} `).test(sql));
    if (cat) {
      const pedidos = (params[0] as string[]) ?? [];
      const achados = catalogo[cat].filter((i) => pedidos.includes(i.id));
      return { rows: achados, rowCount: achados.length };
    }
    if (/^INSERT INTO patient_therapeutic_projects/.test(sql)) return { rows: [{ id: 'v-novo' }], rowCount: 1 };
    if (/^\s*UPDATE patient_therapeutic_projects/.test(sql)) return { rows: cen.anuladas ?? [], rowCount: (cen.anuladas ?? []).length };
    if (/WHERE v\.id = \$1/.test(sql)) return { rows: [cen.criada ?? row({ id: 'v-novo' })], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

/** O SQL de negócio na ordem em que rodou (o controle de transação já foi filtrado). */
const sqls = (chamadas: Array<{ sql: string }>): string[] => chamadas.map((c) => c.sql.replace(/\s+/g, ' ').trim());

describe('TherapeuticProjectRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listForPatient', () => {
    it('resolve o nome do autor por subselect e devolve MAIS RECENTE PRIMEIRO (Gabriel, 08/09)', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          row({ id: 'antiga', created_at: '2026-09-01T10:00:00.000Z' }),
          row({ id: 'nova', created_at: '2026-09-08T10:00:00.000Z' }),
        ],
      });
      const versoes = await repo().listForPatient(PACIENTE);
      expect(versoes.map((v) => v.id)).toEqual(['nova', 'antiga']);
      expect(mockPoolQuery.mock.calls[0][0]).toContain('(SELECT u.display_name FROM users u WHERE u.firebase_uid = v.created_by)');
      // O e-mail do staff NUNCA é fallback do nome (dado pessoal do colaborador, sem célula própria).
      expect(mockPoolQuery.mock.calls[0][0]).not.toContain('u.email');
      expect(mockPoolQuery.mock.calls[0][1]).toEqual([PACIENTE]);
    });

    it('a lista inclui as ANULADAS — a tela mostra o estado, não esconde (lex C5)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [row({ annulled_at: '2026-09-08T12:00:00.000Z', annulled_by: 'uid-2', annul_reason: 'erro de carga' })] });
      const [v] = await repo().listForPatient(PACIENTE);
      expect(v).toMatchObject({ annulledAt: '2026-09-08T12:00:00.000Z', annulledBy: 'uid-2', annulReason: 'erro de carga' });
      expect(mockPoolQuery.mock.calls[0][0]).not.toContain('annulled_at IS NULL');
    });
  });

  describe('findById', () => {
    it('filtra por paciente E por versão — id de outro paciente não abre a versão', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [row()] });
      const v = await repo().findById(PACIENTE, 'v-1');
      expect(v?.id).toBe('v-1');
      expect(mockPoolQuery.mock.calls[0][0]).toContain('WHERE v.patient_id = $1 AND v.id = $2');
      expect(mockPoolQuery.mock.calls[0][1]).toEqual([PACIENTE, 'v-1']);
    });

    it('sem linha → null (o controller responde 404)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      expect(await repo().findById(PACIENTE, 'nao-existe')).toBeNull();
    });
  });

  describe('toVersion — a conversão do que o driver devolve', () => {
    it('Date do driver vira ISO: `date` yyyy-mm-dd e `timestamptz` ISO completo', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [row({
          start_date: new Date('2026-01-01T00:00:00.000Z'),
          end_date: new Date('2026-06-30T00:00:00.000Z'),
          created_at: new Date('2026-09-08T10:00:00.000Z'),
          annulled_at: new Date('2026-09-08T12:00:00.000Z'),
        })],
      });
      const v = await repo().findById(PACIENTE, 'v-1');
      expect(v).toMatchObject({
        startDate: '2026-01-01',
        endDate: '2026-06-30',
        createdAt: '2026-09-08T10:00:00.000Z',
        annulledAt: '2026-09-08T12:00:00.000Z',
      });
    });

    it('string já ISO passa direto, e `annulled_at` nulo continua null (não vira "null")', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [row()] });
      const v = await repo().findById(PACIENTE, 'v-1');
      expect(v).toMatchObject({ startDate: '2026-01-01', createdAt: '2026-09-08T10:00:00.000Z', annulledAt: null });
    });

    it('versão anterior à 417 (modality ausente/undefined no row) sai com `modality: null`, nunca undefined', async () => {
      const { modality: _m, ...semModalidade } = row();
      mockPoolQuery.mockResolvedValue({ rows: [semModalidade] });
      const v = await repo().findById(PACIENTE, 'v-1');
      expect(v).toHaveProperty('modality', null);
    });

    it('o rótulo `V.M.m` sai do domínio e todo o resto do row é mapeado', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [row({ major: 2, minor: 3, edited_from_version_id: 'v-pai' })] });
      const v = await repo().findById(PACIENTE, 'v-1');
      expect(v).toEqual({
        id: 'v-1',
        patientId: PACIENTE,
        major: 2,
        minor: 3,
        version: 'V.2.3',
        editedFromVersionId: 'v-pai',
        contractedServiceId: 'svc-1',
        modality: 'IN_PERSON',
        contractedServiceCode: 'CAREGIVER',
        diagnoses: [{ uri: 'u', code: '6A02', title: 'TEA' }],
        clinicalContext: 'contexto',
        generalObjective: 'objetivo',
        specificObjectives: [{ id: 'o-1', label: 'Objetivo A' }],
        activities: [{ id: 'a-1', label: 'Atividade A' }],
        pathologyTypes: [{ id: '06', label: CAPITULO_06.title }],
        startDate: '2026-01-01',
        endDate: '2026-06-30',
        annulledAt: null,
        annulledBy: null,
        annulledByName: null,
        annulReason: null,
        createdBy: 'uid-autor',
        createdByName: 'Ana Joulie',
        createdAt: '2026-09-08T10:00:00.000Z',
        country: 'AR',
      });
    });
  });

  describe('createVersion — mode `new`', () => {
    it('sem injeção, a porta de terminologia vem da fábrica (TERMINOLOGY_ADAPTER, default postgres) — nenhuma query na construção', () => {
      expect(new TherapeuticProjectRepository()).toBeInstanceOf(TherapeuticProjectRepository);
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('trava o paciente ANTES de ler a numeração: `FOR UPDATE` vem antes do SELECT das versões', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO });
      const ordem = sqls(chamadas);
      expect(ordem[0]).toBe('SELECT id FROM patients WHERE id = $1 FOR UPDATE');
      expect(ordem[1]).toContain('WHERE v.patient_id = $1');
      expect(ordem.findIndex((s) => /^INSERT INTO patient_therapeutic_projects/.test(s))).toBeGreaterThan(1);
      expect(cli.release).toHaveBeenCalled();
    });


    it('paciente inexistente (ou invisível sob a RLS): a trava não acha linha → PatientNotFoundForProjectError, sem INSERT', async () => {
      const { cli, chamadas } = cliente({ pacienteExiste: false });
      mockConnect.mockResolvedValue(cli);
      await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid', version: CORPO }))
        .rejects.toBeInstanceOf(PatientNotFoundForProjectError);
      expect(chamadas.some((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))).toBe(false);
      // O client responde sozinho ao ROLLBACK (não entra em `chamadas`); a prova é que só a trava rodou.
      expect(chamadas.map((c) => c.sql)).toEqual(['SELECT id FROM patients WHERE id = $1 FOR UPDATE']);
      expect(cli.release).toHaveBeenCalled();
    });

    it('paciente sem projeto → 1.0', async () => {
      const { cli, chamadas } = cliente({ criada: row({ id: 'v-novo', major: 1, minor: 0 }) });
      mockConnect.mockResolvedValue(cli);
      const v = await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params.slice(0, 4)).toEqual([PACIENTE, 1, 0, null]);
      expect(v.version).toBe('V.1.0');
    });

    it('com 1.x e 2.x já existentes → 3.0, e `edited_from_version_id` fica NULL', async () => {
      const { cli, chamadas } = cliente({
        existentes: [row({ id: 'a', major: 1, minor: 2 }), row({ id: 'b', major: 2, minor: 0 })],
        criada: row({ id: 'v-novo', major: 3, minor: 0 }),
      });
      mockConnect.mockResolvedValue(cli);
      const v = await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params.slice(1, 4)).toEqual([3, 0, null]);
      expect(v.version).toBe('V.3.0');
    });

    it('o snapshot é montado do CATÁLOGO no mesmo client (lex C19): o cliente manda id, a versão congela label', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params[8]).toBe(JSON.stringify([{ id: 'o-1', label: 'Objetivo A' }]));
      expect(ins.params[9]).toBe(JSON.stringify([{ id: 'a-1', label: 'Atividade A' }]));
      // os dois catálogos foram consultados dentro da transação, não pelo pool
      expect(sqls(chamadas).filter((s) => /WHERE active AND id = ANY/.test(s))).toHaveLength(2);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    describe('contactRefs/careTeamIds (PR-7, migration 429, D328/SUP-25 — MICRO, só ids)', () => {
      it('insere UMA LINHA POR contato, na MESMA transação, sort_order pela ordem do corpo (contactRefs antes de careTeamIds)', async () => {
        const { cli, chamadas } = cliente();
        mockConnect.mockResolvedValue(cli);
        const corpo = {
          ...CORPO,
          contactRefs: [{ kind: 'RESPONSIBLE' as const, id: 'r-1' }, { kind: 'COVERAGE' as const, id: 'c-1' }],
          careTeamIds: ['p-1'],
        };
        await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo });
        const ligacoes = chamadas.filter((c) => /^INSERT INTO patient_therapeutic_project_contacts/.test(c.sql));
        expect(ligacoes).toHaveLength(3);
        expect(ligacoes[0].params).toEqual(['v-novo', PACIENTE, 'RESPONSIBLE', 'r-1', 0]);
        expect(ligacoes[1].params).toEqual(['v-novo', PACIENTE, 'COVERAGE', 'c-1', 1]);
        expect(ligacoes[2].params).toEqual(['v-novo', PACIENTE, 'CARE_TEAM', 'p-1', 2]);
        // A ligação nasce DEPOIS da versão, dentro da MESMA sequência de queries (SUP-26).
        const idxVersao = chamadas.findIndex((c) => /^INSERT INTO patient_therapeutic_projects\b/.test(c.sql));
        const idxLigacao = chamadas.findIndex((c) => /^INSERT INTO patient_therapeutic_project_contacts/.test(c.sql));
        expect(idxLigacao).toBeGreaterThan(idxVersao);
      });

      it('sem contactRefs/careTeamIds: nenhuma linha na ligação (retrocompatível, PATCH sem os campos)', async () => {
        const { cli, chamadas } = cliente();
        mockConnect.mockResolvedValue(cli);
        await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO });
        expect(chamadas.some((c) => /^INSERT INTO patient_therapeutic_project_contacts/.test(c.sql))).toBe(false);
      });

      it('trigger `ptp_contact_inactive` (22023) → ContactInactiveError com SÓ kind/id — nunca propaga o erro cru', async () => {
        const erro = Object.assign(new Error('ptp_contact_inactive: contato inativo ou de outro paciente não pode ser referenciado'), { code: '22023' });
        const { cli } = cliente({ erroEm: { padrao: /^INSERT INTO patient_therapeutic_project_contacts/, erro } });
        mockConnect.mockResolvedValue(cli);
        const corpo = { ...CORPO, contactRefs: [{ kind: 'RESPONSIBLE' as const, id: 'r-inativo' }] };
        const { ContactInactiveError } = await import('../TherapeuticProjectRepository');
        await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo }))
          .rejects.toMatchObject({ code: 'ptp_contact_inactive', kind: 'RESPONSIBLE', id: 'r-inativo' });
        await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo }))
          .rejects.toBeInstanceOf(ContactInactiveError);
      });

      it('FK violada (23503, id de outro paciente ou inexistente) → ContactNotFoundError, não 500', async () => {
        const erro = Object.assign(new Error('insert or update on table violates foreign key constraint "ptpc_cov_fk"'), { code: '23503' });
        const { cli } = cliente({ erroEm: { padrao: /^INSERT INTO patient_therapeutic_project_contacts/, erro } });
        mockConnect.mockResolvedValue(cli);
        const corpo = { ...CORPO, contactRefs: [{ kind: 'COVERAGE' as const, id: 'c-de-outro-paciente' }] };
        const { ContactNotFoundError } = await import('../TherapeuticProjectRepository');
        await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo }))
          .rejects.toMatchObject({ code: 'contact_not_found', kind: 'COVERAGE', id: 'c-de-outro-paciente' });
        await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo }))
          .rejects.toBeInstanceOf(ContactNotFoundError);
      });

      it('22023 com mensagem DIFERENTE de `ptp_contact_inactive` não vira ContactInactiveError — propaga cru', async () => {
        const outroCheck = Object.assign(new Error('other_check_violation: algo bem diferente'), { code: '22023' });
        const { cli } = cliente({ erroEm: { padrao: /^INSERT INTO patient_therapeutic_project_contacts/, erro: outroCheck } });
        mockConnect.mockResolvedValue(cli);
        const corpo = { ...CORPO, contactRefs: [{ kind: 'RESPONSIBLE' as const, id: 'r-1' }] };
        await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo })).rejects.toBe(outroCheck);
      });

      it('erro genérico na ligação propaga cru — não vira 422/404 mentiroso', async () => {
        const boom = new Error('conexão caiu');
        const { cli } = cliente({ erroEm: { padrao: /^INSERT INTO patient_therapeutic_project_contacts/, erro: boom } });
        mockConnect.mockResolvedValue(cli);
        const corpo = { ...CORPO, careTeamIds: ['p-1'] };
        await expect(repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo })).rejects.toBe(boom);
      });
    });

    it('o tipo de patologia é DERIVADO dos CID-11 (D163/D164): capítulo por diagnóstico, distinto e ordenado — o cliente não manda nada', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      const term = terminologia({
        ancestorsOf: jest.fn(async (uri: string) => ({
          chapter: uri === 'u-neuro' ? { code: '08', title: 'Enfermedades del sistema nervioso' } : CAPITULO_06,
        })),
      });
      const corpo = { ...CORPO, diagnoses: [{ uri: 'u-neuro', title: 'Epilepsia' }, { uri: 'u', title: 'TEA' }, { uri: 'u', title: 'TEA de novo' }] };
      await repo(term).createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: corpo });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params[10]).toBe(JSON.stringify([
        { id: '06', label: CAPITULO_06.title },
        { id: '08', label: 'Enfermedades del sistema nervioso' },
      ]));
      // URI repetida resolve UMA vez; nenhuma tabela `pathology_types` é consultada
      expect(term.ancestorsOf).toHaveBeenCalledTimes(2);
      expect(sqls(chamadas).some((s) => /pathology_types\b(?!,)/.test(s) && !/^INSERT/.test(s))).toBe(false);
    });

    it('CID-11 que não resolve no catálogo (`getByUri` → null) → DiagnosisUnknownError (422), sem INSERT nem `ancestorsOf`; falha de infra da porta propaga como está', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      const sumido = terminologia({ getByUri: jest.fn(async () => null) });
      await expect(repo(sumido).createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO }))
        .rejects.toBeInstanceOf(DiagnosisUnknownError);
      expect(chamadas.some((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))).toBe(false);
      expect(sumido.ancestorsOf).not.toHaveBeenCalled();
      const caiu = new Error('porta fora do ar');
      const fora = terminologia({ ancestorsOf: jest.fn(async () => { throw caiu; }) });
      await expect(repo(fora).createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO })).rejects.toBe(caiu);
    });

    it('diagnósticos e o uid do ator vão como parâmetro (jsonb string, nunca array JS)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-99', version: CORPO });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params[5]).toBe(JSON.stringify(CORPO.diagnoses));
      expect(ins.params[13]).toBe('uid-99');
      expect(ins.params).not.toContainEqual(CORPO.diagnoses);
    });

    it('id de catálogo desconhecido/inativo → CatalogItemsUnknownError propaga (o controller responde 422)', async () => {
      const { cli } = cliente();
      mockConnect.mockResolvedValue(cli);
      const p = repo().createVersion({
        mode: 'new',
        patientId: PACIENTE,
        actorUid: 'uid-1',
        version: { ...CORPO, activityIds: ['a-1', 'a-sumida'] },
      });
      await expect(p).rejects.toBeInstanceOf(CatalogItemsUnknownError);
      await expect(p).rejects.toMatchObject({ kind: 'activities', ids: ['a-sumida'] });
    });
  });

  describe('createVersion — mode `edit`', () => {
    it('editar a 1.0 com a 1.1 já existente gera 1.2 (SUP-4), e carimba a origem', async () => {
      const { cli, chamadas } = cliente({
        existentes: [row({ id: 'v-10', major: 1, minor: 0 }), row({ id: 'v-11', major: 1, minor: 1 })],
        criada: row({ id: 'v-novo', major: 1, minor: 2, edited_from_version_id: 'v-10' }),
      });
      mockConnect.mockResolvedValue(cli);
      const v = await repo().createVersion({
        mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-10', version: CORPO,
      });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params.slice(1, 4)).toEqual([1, 2, 'v-10']);
      expect(v.version).toBe('V.1.2');
    });

    it('editar a 2.0 não interfere na major 1 — a minor é contada DENTRO da major de origem', async () => {
      const { cli, chamadas } = cliente({
        // `created_at` distintos (ADR-4/SUP-24: vigente = mais recente) — v-20 é a VIGENTE aqui.
        existentes: [
          row({ id: 'v-10', major: 1, minor: 7, created_at: '2026-09-01T10:00:00.000Z' }),
          row({ id: 'v-20', major: 2, minor: 0, created_at: '2026-09-08T10:00:00.000Z' }),
        ],
        criada: row({ id: 'v-novo', major: 2, minor: 1 }),
      });
      mockConnect.mockResolvedValue(cli);
      await repo().createVersion({
        mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-20', version: CORPO,
      });
      const ins = chamadas.find((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))!;
      expect(ins.params.slice(1, 4)).toEqual([2, 1, 'v-20']);
    });

    it('origem que não é deste paciente → SourceVersionNotFoundError, sem INSERT', async () => {
      const { cli, chamadas } = cliente({ existentes: [row({ id: 'v-10' })] });
      mockConnect.mockResolvedValue(cli);
      const p = repo().createVersion({
        mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-de-outro', version: CORPO,
      });
      await expect(p).rejects.toBeInstanceOf(SourceVersionNotFoundError);
      await expect(p).rejects.toMatchObject({ code: 'source_version_not_found' });
      expect(sqls(chamadas).some((s) => /^INSERT INTO patient_therapeutic_projects/.test(s))).toBe(false);
    });

    it('origem ANULADA não serve de base — a versão anulada morreu (lex C5)', async () => {
      const { cli } = cliente({ existentes: [row({ id: 'v-10', annulled_at: '2026-09-08T12:00:00.000Z' })] });
      mockConnect.mockResolvedValue(cli);
      await expect(
        repo().createVersion({
          mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-10', version: CORPO,
        }),
      ).rejects.toBeInstanceOf(SourceVersionNotFoundError);
    });

    it('fromVersionId EXISTE mas não é mais a VIGENTE (outra edição ficou mais recente) → 409 ptp_not_current, NUNCA 422 (ADR-4/SUP-24)', async () => {
      const { cli, chamadas } = cliente({
        existentes: [
          row({ id: 'v-10', major: 1, minor: 0, created_at: '2026-09-01T10:00:00.000Z' }),
          row({ id: 'v-11', major: 1, minor: 1, created_at: '2026-09-08T10:00:00.000Z' }),
        ],
      });
      mockConnect.mockResolvedValue(cli);
      const { VersionNotCurrentError } = await import('../TherapeuticProjectRepository');
      await expect(
        repo().createVersion({ mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-10', version: CORPO }),
      ).rejects.toBeInstanceOf(VersionNotCurrentError);
      expect(chamadas.some((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))).toBe(false);
    });

    it('campo MACRO alterado na edição da vigente → 422 ptp_macro_locked com os NOMES mudados (D328)', async () => {
      const vigente = row({ id: 'v-10', major: 1, minor: 0, clinical_context: 'contexto ORIGINAL' });
      const { cli, chamadas } = cliente({ existentes: [vigente] });
      mockConnect.mockResolvedValue(cli);
      const { MacroFieldsLockedError } = await import('../TherapeuticProjectRepository');
      const corpoMudouMacro = { ...CORPO, clinicalContext: 'contexto MUDOU' };
      const p = repo().createVersion({ mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-10', version: corpoMudouMacro });
      await expect(p).rejects.toBeInstanceOf(MacroFieldsLockedError);
      await expect(p).rejects.toMatchObject({ fields: ['clinicalContext'] });
      expect(chamadas.some((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))).toBe(false);
    });

    it('editar a vigente SEM mudar nenhum MACRO (só MICRO: startDate/modality/contactRefs) → passa, sem 422', async () => {
      const vigente = row({ id: 'v-10', major: 1, minor: 0 });
      const { cli, chamadas } = cliente({ existentes: [vigente] });
      mockConnect.mockResolvedValue(cli);
      const corpoSoMicro = { ...CORPO, startDate: '2026-02-01', modality: 'ONLINE' as const };
      await repo().createVersion({ mode: 'edit', patientId: PACIENTE, actorUid: 'uid-1', fromVersionId: 'v-10', version: corpoSoMicro });
      expect(chamadas.some((c) => /^INSERT INTO patient_therapeutic_projects/.test(c.sql))).toBe(true);
    });
  });

  describe('createVersion — erros do banco', () => {
    it('trigger `ptp_service_de_outro_paciente` → ServiceNotOfPatientError (o controller responde 422)', async () => {
      const { cli } = cliente({
        erroEm: { padrao: /^INSERT INTO patient_therapeutic_projects/, erro: new Error('new row violates ptp_service_de_outro_paciente') },
      });
      mockConnect.mockResolvedValue(cli);
      const p = repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO });
      await expect(p).rejects.toBeInstanceOf(ServiceNotOfPatientError);
      await expect(p).rejects.toMatchObject({ code: 'service_not_of_patient' });
    });

    it('erro genérico propaga cru — não vira 422 mentiroso', async () => {
      const { cli } = cliente({ erroEm: { padrao: /^INSERT INTO patient_therapeutic_projects/, erro: new Error('deadlock detected') } });
      mockConnect.mockResolvedValue(cli);
      await expect(
        repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO }),
      ).rejects.toThrow('deadlock detected');
    });

    it('rejeição `null` (sem `.message`) passa pelo detector sem quebrar e propaga', async () => {
      const { cli } = cliente({ erroEm: { padrao: /FOR UPDATE/, erro: null } });
      mockConnect.mockResolvedValue(cli);
      await expect(
        repo().createVersion({ mode: 'new', patientId: PACIENTE, actorUid: 'uid-1', version: CORPO }),
      ).rejects.toBeNull();
    });
  });

  describe('annul (lex C5: a única escrita depois do INSERT)', () => {
    it('anula e relê a versão: o UPDATE só morde quem ainda não está anulado', async () => {
      const { cli, chamadas } = cliente({
        anuladas: [{ id: 'v-1' }],
        criada: row({ id: 'v-1', annulled_at: '2026-09-08T12:00:00.000Z', annulled_by: 'uid-2', annul_reason: 'carga errada' }),
      });
      mockConnect.mockResolvedValue(cli);
      const v = await repo().annul(PACIENTE, 'v-1', 'uid-2', 'carga errada');
      expect(v).toMatchObject({ id: 'v-1', annulledAt: '2026-09-08T12:00:00.000Z', annulledBy: 'uid-2', annulReason: 'carga errada' });
      const upd = chamadas.find((c) => /UPDATE patient_therapeutic_projects/.test(c.sql))!;
      expect(upd.sql.replace(/\s+/g, ' ')).toContain('WHERE patient_id = $1 AND id = $2 AND annulled_at IS NULL');
      expect(upd.params).toEqual([PACIENTE, 'v-1', 'uid-2', 'carga errada']);
    });

    it('0 linhas (inexistente ou JÁ anulada) → null, e nem relê a versão', async () => {
      const { cli, chamadas } = cliente({ anuladas: [] });
      mockConnect.mockResolvedValue(cli);
      expect(await repo().annul(PACIENTE, 'v-1', 'uid-2', 'motivo')).toBeNull();
      expect(sqls(chamadas)).toHaveLength(1);
    });

    it('a anulação NÃO apaga nada: o UPDATE não é DELETE e só toca as 3 colunas de anulação', async () => {
      const { cli, chamadas } = cliente({ anuladas: [{ id: 'v-1' }] });
      mockConnect.mockResolvedValue(cli);
      await repo().annul(PACIENTE, 'v-1', 'uid-2', 'motivo');
      const upd = chamadas[0].sql.replace(/\s+/g, ' ');
      expect(upd).not.toMatch(/DELETE/);
      expect(upd).toContain('SET annulled_at = NOW(), annulled_by = $3, annul_reason = $4');
      expect(upd).not.toMatch(/clinical_context|general_objective|diagnoses/);
    });
  });
});
