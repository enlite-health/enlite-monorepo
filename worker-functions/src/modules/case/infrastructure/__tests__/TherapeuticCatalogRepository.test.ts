/**
 * TherapeuticCatalogRepository — os 3 catálogos do Projeto Terapêutico (migration 415, spec 017,
 * D299). Molde: `PatientContractedServiceRepository.test.ts` — pool/client mockados na FRONTEIRA
 * (`@shared/database/DatabaseConnection`), `withActorContext` REAL (é ele que abre a transação e
 * faz BEGIN/set_config/COMMIT, por isso o client mock responde a esses).
 *
 * O que este unit prova: a FORMA do SQL (tabela vinda do domínio, filtro de ativos, sets
 * condicionais do PATCH), o mapeamento row→item, e os dois erros nomeados
 * (`CatalogLabelTakenError` a partir do `23505` do índice `_label_ativo`, `CatalogItemsUnknownError`
 * com a lista de ids — lex C19). A prova de que o SQL roda de verdade é o e2e.
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }),
  },
}));

import {
  TherapeuticCatalogRepository,
  CatalogItemsUnknownError,
  CatalogLabelTakenError,
  CatalogItemNeedsOwnerError,
  ActivityCategoriesOutsideObjectiveError,
  CatalogObjectiveInvalidError,
} from '../TherapeuticCatalogRepository';
import { THERAPEUTIC_CATALOG_TABLE } from '../../domain/TherapeuticProject';

const ROW = {
  id: 'item-1',
  label: 'Vínculo terapéutico',
  sort_order: 10,
  active: true,
  deactivated_at: null,
  created_at: '2026-09-08T10:00:00.000Z',
  updated_at: '2026-09-08T10:00:00.000Z',
};

/** Erro do pg como ele chega: `code` + `constraint` (o índice `uq_<tabela>_label_ativo` da 415). */
function erroPg(code: string, constraint?: string): Error & { code: string; constraint?: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code, constraint });
}

/**
 * Client de transação. Responde sozinho a BEGIN/COMMIT/ROLLBACK/set_config (como o
 * `poolMockSupport`) e registra a sequência de queries de negócio para as asserções.
 */
function cliente(resposta: { rows: unknown[] } | Error = { rows: [ROW] }) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$|set_config\s*\(/i.test(sql)) return { rows: [], rowCount: 0 };
    chamadas.push({ sql, params });
    if (resposta instanceof Error) throw resposta;
    return { rows: resposta.rows, rowCount: resposta.rows.length };
  });
  return { cli: { query, release: jest.fn() }, chamadas };
}

describe('TherapeuticCatalogRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('list', () => {
    it('sem opts → só os ATIVOS, ordenados por lower(label) (spec 061); mapeia a linha inteira', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [ROW] });
      const itens = await new TherapeuticCatalogRepository().list('specific-objectives');
      const sql = mockPoolQuery.mock.calls[0][0] as string;
      expect(sql).toContain('FROM therapeutic_specific_objectives');
      expect(sql).toContain('WHERE o.active');
      expect(sql).toContain('ORDER BY lower(o.label)');
      expect(sql).not.toContain('ORDER BY sort_order');
      expect(itens).toEqual([
        {
          id: 'item-1',
          label: 'Vínculo terapéutico',
          sortOrder: 10,
          active: true,
          deactivatedAt: null,
          createdAt: '2026-09-08T10:00:00.000Z',
          updatedAt: '2026-09-08T10:00:00.000Z',
        },
      ]);
    });

    it('includeInactive → SEM o WHERE (a baixa é `active=false`, nunca DELETE: o painel precisa ver)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ...ROW, active: false, deactivated_at: '2026-09-08T11:00:00.000Z' }] });
      const itens = await new TherapeuticCatalogRepository().list('activities', { includeInactive: true });
      expect(mockPoolQuery.mock.calls[0][0]).not.toContain('a.active');
      expect(itens[0]).toMatchObject({ active: false, deactivatedAt: '2026-09-08T11:00:00.000Z' });
    });

    it.each([
      ['specific-objectives', 'therapeutic_specific_objectives'],
      ['activities', 'therapeutic_activities'],
    ] as const)('a tabela do kind %s vem do DOMÍNIO (%s), nunca de string do cliente', async (kind, tabela) => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await new TherapeuticCatalogRepository().list(kind);
      expect(mockPoolQuery.mock.calls[0][0]).toContain(`FROM ${tabela}`);
      expect(THERAPEUTIC_CATALOG_TABLE[kind]).toBe(tabela);
    });

    it('kind `service-exit-reasons` (492) resolve a tabela nova; `code` só aparece quando a linha tem a coluna', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ...ROW, code: 'OTHER' }] });
      const itens = await new TherapeuticCatalogRepository().list('service-exit-reasons');
      expect(mockPoolQuery.mock.calls[0][0]).toContain('FROM service_exit_reasons');
      expect(itens[0]).toMatchObject({ id: 'item-1', code: 'OTHER' });
      mockPoolQuery.mockResolvedValue({ rows: [ROW] });
      const semCode = await new TherapeuticCatalogRepository().list('activities');
      expect(semCode[0]).not.toHaveProperty('code');
      expect(semCode[0]).not.toHaveProperty('segmentId');
      expect(Object.keys(THERAPEUTIC_CATALOG_TABLE)).not.toContain('segments');
    });

    it('o pool é memoizado: duas chamadas, um único getPool()', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      const repo = new TherapeuticCatalogRepository();
      await repo.list('activities');
      await repo.list('activities');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseConnection } = require('@shared/database/DatabaseConnection');
      expect(DatabaseConnection.getInstance().getPool).toHaveBeenCalledTimes(1);
    });
  });

  describe('091 — list com serviceCode/categoryCount e filtros', () => {
    it('objetivos: item leva serviceCode e categoryCount (contagem do vínculo); categoryCode filtra por EXISTS parametrizado', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ...ROW, service_code: 'AT', category_count: 3 }] });
      const itens = await new TherapeuticCatalogRepository().list('specific-objectives', { categoryCode: '6A02' });
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('therapeutic_objective_icd_categories');
      expect(sql).toContain('f.category_code = $1');
      expect(params).toEqual(['6A02']);
      expect(itens[0]).toMatchObject({ serviceCode: 'AT', categoryCount: 3 });
    });

    it('objetivos: `objectiveId` não é filtro de objetivo (ignorado, nenhum param)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await new TherapeuticCatalogRepository().list('specific-objectives', { objectiveId: 'obj-1' });
      expect(mockPoolQuery.mock.calls[0][1]).toEqual([]);
    });

    it('atividades: item leva objectiveId/objectiveLabel/objectiveActive/suggestedFrequency/categoryCount; filtros categoryCode e objectiveId em params sequenciais', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ...ROW, objective_id: 'obj-1', objective_label: 'Obj', objective_active: true, suggested_frequency: null, category_count: 2 }] });
      const itens = await new TherapeuticCatalogRepository().list('activities', { categoryCode: '6A02', objectiveId: 'obj-1' });
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('therapeutic_activity_icd_categories');
      expect(sql).toContain('f.category_code = $1');
      expect(sql).toContain('a.objective_id = $2');
      expect(sql).toContain('WHERE a.active AND ');
      expect(params).toEqual(['6A02', 'obj-1']);
      expect(itens[0]).toEqual(expect.objectContaining({ objectiveId: 'obj-1', objectiveLabel: 'Obj', objectiveActive: true, suggestedFrequency: null, categoryCount: 2 }));
    });

    it('includeInactive + filtro → WHERE só com o filtro (sem `a.active`)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await new TherapeuticCatalogRepository().list('activities', { includeInactive: true, objectiveId: 'obj-1' });
      const sql = mockPoolQuery.mock.calls[0][0] as string;
      expect(sql).toContain('WHERE a.objective_id = $1');
      expect(sql).not.toContain('a.active AND');
    });

    it('não existe método de segmento no repositório (091)', () => {
      const repo = new TherapeuticCatalogRepository() as unknown as Record<string, unknown>;
      expect(repo.snapshotSegment).toBeUndefined();
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter((n) => /segment/i.test(n))).toEqual([]);
    });
  });

  describe('spec 061 — description e ordem do list por kind', () => {
    it('`service-exit-reasons` mantém a ordem manual (active DESC, sort_order, lower(label))', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [ROW] });
      await new TherapeuticCatalogRepository().list('service-exit-reasons');
      expect(mockPoolQuery.mock.calls[0][0] as string).toContain('ORDER BY active DESC, sort_order, lower(label)');
    });
    it.each(['service-exit-reasons'] as const)(
      'kind `%s` (sem coluna description): list com ORDER BY antigo; create/update NÃO tocam `description` mesmo se vier no input',
      async (kind) => {
        mockPoolQuery.mockResolvedValue({ rows: [ROW] });
        await new TherapeuticCatalogRepository().list(kind);
        const listSql = mockPoolQuery.mock.calls[0][0] as string;
        expect(listSql).toContain('ORDER BY active DESC, sort_order, lower(label)');
        expect(listSql).not.toContain('description');

        const c = cliente();
        mockConnect.mockResolvedValue(c.cli);
        await new TherapeuticCatalogRepository().create(kind, { label: 'MOTIVO-SINTETICO-1', description: 'DESCRIPCION-SINTETICA-1', actorUid: 'uid-1' });
        expect(c.chamadas[0].sql).not.toContain('description');
        expect(c.chamadas[0].params).toEqual(['MOTIVO-SINTETICO-1', null, 'uid-1']);

        const u = cliente();
        mockConnect.mockResolvedValue(u.cli);
        await new TherapeuticCatalogRepository().update(kind, 'item-1', { label: 'MOTIVO-SINTETICO-2', description: 'DESCRIPCION-SINTETICA-2', actorUid: 'uid-1' });
        expect(u.chamadas[0].sql).not.toContain('description');
        expect(u.chamadas[0].params).toEqual(['item-1', 'MOTIVO-SINTETICO-2', 'uid-1']);
      },
    );
    it('list: linha COM a coluna `description` → item leva `description`; sem a coluna → chave ausente', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ...ROW, description: 'DESCRIPCION-SINTETICA-1' }, { ...ROW, id: 'item-2', description: null }] });
      const itens = await new TherapeuticCatalogRepository().list('activities');
      expect(itens[0].description).toBe('DESCRIPCION-SINTETICA-1');
      expect(itens[1].description).toBeNull();
    });
    it('create COM description → coluna e param entram no INSERT, antes de created_by', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('activities', { label: 'TITULO-SINTETICO-1', description: 'DESCRIPCION-SINTETICA-1', actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('description');
      expect(chamadas[0].params).toEqual(['TITULO-SINTETICO-1', null, 'DESCRIPCION-SINTETICA-1', 'uid-1']);
    });
    it('create SEM description → coluna fora do INSERT', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('activities', { label: 'TITULO-SINTETICO-1', actorUid: 'uid-1' });
      expect(chamadas[0].sql).not.toContain('description');
    });
    it('update só description → SET description = $2 (sem label)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { description: 'DESCRIPCION-SINTETICA-2', actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('SET description = $2, updated_by = $3, updated_at = NOW()');
      expect(chamadas[0].sql).not.toContain('label =');
      expect(chamadas[0].params).toEqual(['item-1', 'DESCRIPCION-SINTETICA-2', 'uid-1']);
    });
    it('update description: null → LIMPA (param null presente)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { description: null, actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('SET description = $2');
      expect(chamadas[0].params).toEqual(['item-1', null, 'uid-1']);
    });
    it('snapshotOf devolve `description` quando há e OMITE a chave quando NULL', async () => {
      mockPoolQuery.mockResolvedValue({
        rows: [
          { id: 'a', label: 'TITULO-SINTETICO-A', description: 'DESCRIPCION-SINTETICA-A'},
          { id: 'b', label: 'TITULO-SINTETICO-B', description: null},
        ],
      });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('activities', ['a', 'b']);
      expect(snap[0]).toEqual({ id: 'a', label: 'TITULO-SINTETICO-A', description: 'DESCRIPCION-SINTETICA-A'});
      expect('description' in snap[1]).toBe(false);
      const sql = mockPoolQuery.mock.calls[0][0] as string;
      expect(sql).toContain('c.description');
      expect(sql).toContain('ORDER BY c.sort_order, lower(c.label)');
    });
  });

  describe('snapshotOf (lex C19: o servidor congela o texto, o cliente só manda id)', () => {
    it('todos os ids ativos → devolve `{ id, label }` na ordem do catálogo', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A' }, { id: 'b', label: 'Objetivo B' }] });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('specific-objectives', ['a', 'b']);
      expect(snap).toEqual([{ id: 'a', label: 'Objetivo A' }, { id: 'b', label: 'Objetivo B' }]);
      expect(mockPoolQuery.mock.calls[0][0]).toContain('WHERE c.active AND c.id = ANY($1::uuid[])');
    });

    it('snapshot não traz mais segmento (091): sem JOIN com `therapeutic_segments` e sem `segmentId`', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A' }] });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('specific-objectives', ['a']);
      expect(snap).toEqual([{ id: 'a', label: 'Objetivo A' }]);
      expect(mockPoolQuery.mock.calls[0][0]).not.toContain('segment');
    });

    it('ids repetidos são deduplicados antes do ANY (o mesmo id duas vezes não é "faltando")', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A' }] });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('activities', ['a', 'a', 'a']);
      expect(mockPoolQuery.mock.calls[0][1]).toEqual([['a']]);
      expect(snap).toEqual([{ id: 'a', label: 'Objetivo A' }]);
    });

    it('id desconhecido ou INATIVO → CatalogItemsUnknownError com o kind e SÓ os ids faltantes', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A' }] });
      const erro: CatalogItemsUnknownError = await new TherapeuticCatalogRepository()
        .snapshotOf('activities', ['a', 'sumido-1', 'sumido-2'])
        .then(() => { throw new Error('devia ter lançado'); }, (e: unknown) => e as CatalogItemsUnknownError);
      expect(erro).toBeInstanceOf(CatalogItemsUnknownError);
      expect(erro.code).toBe('catalog_items_unknown');
      expect(erro.kind).toBe('activities');
      expect(erro.ids).toEqual(['sumido-1', 'sumido-2']);
    });

    it('lista vazia de ids → nenhum faltante, snapshot vazio', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      expect(await new TherapeuticCatalogRepository().snapshotOf('activities', [])).toEqual([]);
    });

    it('aceita um client de transação no lugar do pool — é assim que o INSERT da versão o usa', async () => {
      const { cli, chamadas } = cliente({ rows: [{ id: 'a', label: 'Objetivo A' }] });
      await new TherapeuticCatalogRepository().snapshotOf('activities', ['a'], cli as never);
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(chamadas[0].sql).toContain('FROM therapeutic_activities');
    });
  });

  describe('create', () => {
    it('com sortOrder → o valor vai como parâmetro; INSERT dentro da transação, COMMIT no fim', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      const item = await new TherapeuticCatalogRepository().create('specific-objectives', {
        label: 'Vínculo terapéutico',
        sortOrder: 30,
        actorUid: 'uid-1',
      });
      expect(chamadas[0].sql).toContain('INSERT INTO therapeutic_specific_objectives');
      expect(chamadas[0].params).toEqual(['Vínculo terapéutico', 30, 'uid-1']);
      expect(item).toMatchObject({ id: 'item-1', label: 'Vínculo terapéutico', sortOrder: 10 });
      expect(cli.release).toHaveBeenCalled();
    });

    it('sem sortOrder → vai NULL e o COALESCE do SQL calcula MAX+10 (a ordem nasce no banco)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('activities', { label: 'Acompañamiento', actorUid: 'uid-1' });
      expect(chamadas[0].params).toEqual(['Acompañamiento', null, 'uid-1']);
      expect(chamadas[0].sql).toContain('COALESCE(MAX(sort_order), 0) + 10');
    });

    it('o mesmo uid carimba created_by E updated_by ($3 nos dois)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('activities', { label: 'Neurodesarrollo', actorUid: 'uid-9' });
      expect(chamadas[0].sql).toContain('created_by, updated_by');
      expect(chamadas[0].sql).toContain('$3, $3');
    });

    it('rótulo repetido entre os ATIVOS (23505 no índice `_label_ativo`) → CatalogLabelTakenError', async () => {
      const { cli } = cliente(erroPg('23505', 'uq_therapeutic_activities_label_ativo'));
      mockConnect.mockResolvedValue(cli);
      const p = new TherapeuticCatalogRepository().create('activities', { label: 'Repetido', actorUid: 'uid-1' });
      await expect(p).rejects.toBeInstanceOf(CatalogLabelTakenError);
      await expect(p).rejects.toMatchObject({ code: 'catalog_label_taken' });
    });

    it('23505 de OUTRA constraint (não `_label_ativo`) propaga cru — não vira 409 mentiroso', async () => {
      const { cli } = cliente(erroPg('23505', 'pk_therapeutic_activities'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().create('activities', { label: 'X', actorUid: 'uid-1' }),
      ).rejects.toMatchObject({ code: '23505', constraint: 'pk_therapeutic_activities' });
    });

    it('23505 SEM constraint (undefined) → o `?? ""` segura e o erro propaga cru', async () => {
      const { cli } = cliente(erroPg('23505'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().create('activities', { label: 'X', actorUid: 'uid-1' }),
      ).rejects.not.toBeInstanceOf(CatalogLabelTakenError);
    });

    it('erro de outro código propaga cru', async () => {
      const { cli } = cliente(erroPg('23514', 'therapeutic_activities_label_len'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().create('activities', { label: 'X', actorUid: 'uid-1' }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejeição que NÃO é objeto (string crua) não confunde o detector de rótulo repetido', async () => {
      const chamadas: string[] = [];
      const cli = {
        query: jest.fn(async (sql: string) => {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [], rowCount: 0 };
          chamadas.push(sql);
          // eslint-disable-next-line no-throw-literal
          throw 'rejeição crua';
        }),
        release: jest.fn(),
      };
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().create('activities', { label: 'X', actorUid: 'uid-1' }),
      ).rejects.toBe('rejeição crua');
      expect(chamadas).toHaveLength(1);
    });

    it('091: objetivo com `serviceCode` → coluna service_code entra no INSERT antes de created_by', async () => {
      const { cli, chamadas } = cliente({ rows: [{ ...ROW, service_code: 'AT' }] });
      mockConnect.mockResolvedValue(cli);
      const item = await new TherapeuticCatalogRepository().create('specific-objectives', { label: 'Vínculo', serviceCode: 'AT', actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('service_code');
      expect(chamadas[0].params).toEqual(['Vínculo', null, 'AT', 'uid-1']);
      expect(item).toMatchObject({ serviceCode: 'AT' });
    });

    it('091: atividade com `objectiveId` e `suggestedFrequency` → ambas as colunas entram; `suggestedFrequency: null` explícito também', async () => {
      const { cli, chamadas } = cliente({ rows: [{ ...ROW, objective_id: 'obj-1', suggested_frequency: '3x por semana' }] });
      mockConnect.mockResolvedValue(cli);
      const item = await new TherapeuticCatalogRepository().create('activities', { label: 'Acompañamiento', objectiveId: 'obj-1', suggestedFrequency: '3x por semana', actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('objective_id, suggested_frequency');
      expect(chamadas[0].params).toEqual(['Acompañamiento', null, 'obj-1', '3x por semana', 'uid-1']);
      expect(item).toMatchObject({ objectiveId: 'obj-1', suggestedFrequency: '3x por semana' });
      const n = cliente();
      mockConnect.mockResolvedValue(n.cli);
      await new TherapeuticCatalogRepository().create('activities', { label: 'A', objectiveId: 'obj-1', suggestedFrequency: null, actorUid: 'uid-1' });
      expect(n.chamadas[0].params).toEqual(['A', null, 'obj-1', null, 'uid-1']);
    });

    it('091: kind sem coluna de dono (motivos de saída) ignora serviceCode/objectiveId do input', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('service-exit-reasons', { label: 'M', serviceCode: 'AT', objectiveId: 'o', actorUid: 'uid-1' });
      expect(chamadas[0].sql).not.toContain('service_code');
      expect(chamadas[0].sql).not.toContain('objective_id');
    });

    it('091: 23514 (item ativo sem dono, DD-15) → CatalogItemNeedsOwnerError code catalog_item_needs_owner, nunca cru', async () => {
      const { cli } = cliente(erroPg('23514', 'therapeutic_specific_objectives_ativo_tem_servico'));
      mockConnect.mockResolvedValue(cli);
      const p = new TherapeuticCatalogRepository().create('specific-objectives', { label: 'X', actorUid: 'uid-1' });
      await expect(p).rejects.toBeInstanceOf(CatalogItemNeedsOwnerError);
      await expect(p).rejects.toMatchObject({ code: 'catalog_item_needs_owner' });
    });

    it('091: 23514 de OUTRO CHECK (ex. frequência fora de 1..100) propaga cru', async () => {
      const { cli } = cliente(erroPg('23514', 'therapeutic_activities_suggested_frequency_len'));
      mockConnect.mockResolvedValue(cli);
      await expect(new TherapeuticCatalogRepository().create('activities', { label: 'X', actorUid: 'uid-1' })).rejects.not.toBeInstanceOf(CatalogItemNeedsOwnerError);
    });

    it('rejeição `null` também passa pelo detector sem quebrar', async () => {
      const cli = {
        query: jest.fn(async (sql: string) => {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [], rowCount: 0 };
          // eslint-disable-next-line no-throw-literal
          throw null;
        }),
        release: jest.fn(),
      };
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().create('activities', { label: 'X', actorUid: 'uid-1' }),
      ).rejects.toBeNull();
    });
  });

  describe('update (Merge Patch: chave ausente não toca a coluna)', () => {
    it('só label → SET label + updated_by + updated_at; sort_order e active ficam de fora', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { label: 'Novo', actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('SET label = $2, updated_by = $3, updated_at = NOW()');
      expect(chamadas[0].sql).not.toContain('sort_order');
      expect(chamadas[0].sql).not.toContain('active =');
      expect(chamadas[0].params).toEqual(['item-1', 'Novo', 'uid-1']);
    });

    it('só sortOrder → SET sort_order; e `0` (falsy) entra, porque a guarda é `!== undefined`', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { sortOrder: 0, actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('sort_order = $2');
      expect(chamadas[0].params).toEqual(['item-1', 0, 'uid-1']);
    });

    it('active:false → carimba `deactivated_at = NOW()` (a baixa, nunca DELETE: versões antigas apontam para o id)', async () => {
      const { cli, chamadas } = cliente({ rows: [{ ...ROW, active: false, deactivated_at: '2026-09-08T12:00:00.000Z' }] });
      mockConnect.mockResolvedValue(cli);
      const item = await new TherapeuticCatalogRepository().update('activities', 'item-1', { active: false, actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('active = $2');
      expect(chamadas[0].sql).toContain('deactivated_at = NOW()');
      expect(chamadas[0].params).toEqual(['item-1', false, 'uid-1']);
      expect(item).toMatchObject({ active: false, deactivatedAt: '2026-09-08T12:00:00.000Z' });
    });

    it('active:true → LIMPA `deactivated_at` (reativar é caminho válido)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { active: true, actorUid: 'uid-1' });
      expect(chamadas[0].sql).toContain('deactivated_at = NULL');
      expect(chamadas[0].sql).not.toContain('deactivated_at = NOW()');
    });

    it('patch cheio → os três sets na ordem em que foram empurrados, com o id sempre em $1', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('specific-objectives', 'item-1', {
        label: 'Novo',
        sortOrder: 20,
        active: false,
        actorUid: 'uid-7',
      });
      expect(chamadas[0].sql).toContain('SET label = $2, sort_order = $3, active = $4, deactivated_at = NOW(), updated_by = $5, updated_at = NOW()');
      expect(chamadas[0].sql).toContain('WHERE id = $1 RETURNING *');
      expect(chamadas[0].params).toEqual(['item-1', 'Novo', 20, false, 'uid-7']);
    });

    it('091: serviceCode/objectiveId/suggestedFrequency entram no SET quando a chave vem; `null` explícito LIMPA a frequência', async () => {
      const a = cliente();
      mockConnect.mockResolvedValue(a.cli);
      await new TherapeuticCatalogRepository().update('specific-objectives', 'item-1', { serviceCode: 'CAREGIVER', actorUid: 'uid-1' });
      expect(a.chamadas[0].sql).toContain('SET service_code = $2');
      expect(a.chamadas[0].params).toEqual(['item-1', 'CAREGIVER', 'uid-1']);
      const b = cliente();
      mockConnect.mockResolvedValue(b.cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { objectiveId: 'obj-2', suggestedFrequency: null, actorUid: 'uid-1' });
      expect(b.chamadas[0].sql).toContain('SET objective_id = $2, suggested_frequency = $3');
      expect(b.chamadas[0].params).toEqual(['item-1', 'obj-2', null, 'uid-1']);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('091: reativar item antigo sem dono (23514 do CHECK) → CatalogItemNeedsOwnerError no PATCH', async () => {
      const { cli } = cliente(erroPg('23514', 'therapeutic_activities_ativa_tem_objetivo'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().update('activities', 'item-1', { active: true, actorUid: 'uid-1' }),
      ).rejects.toMatchObject({ code: 'catalog_item_needs_owner' });
    });

    it('091: troca de objetivo com vínculos fora do novo (23503 da FK composta) → ActivityCategoriesOutsideObjectiveError', async () => {
      const { cli } = cliente(erroPg('23503', 'therapeutic_activity_icd_categories_dentro_do_objetivo_fk'));
      mockConnect.mockResolvedValue(cli);
      const p = new TherapeuticCatalogRepository().update('activities', 'item-1', { objectiveId: 'obj-2', actorUid: 'uid-1' });
      await expect(p).rejects.toBeInstanceOf(ActivityCategoriesOutsideObjectiveError);
      await expect(p).rejects.toMatchObject({ code: 'activity_categories_outside_objective' });
    });

    it('091: 23503 da FK do objetivo (objectiveId inexistente) → CatalogObjectiveInvalidError code catalog_objective_invalid, no PATCH e no POST', async () => {
      const patch = cliente(erroPg('23503', 'therapeutic_activities_objective_id_fkey'));
      mockConnect.mockResolvedValue(patch.cli);
      const p = new TherapeuticCatalogRepository().update('activities', 'item-1', { objectiveId: 'x', actorUid: 'uid-1' });
      await expect(p).rejects.toBeInstanceOf(CatalogObjectiveInvalidError);
      await expect(p).rejects.toMatchObject({ code: 'catalog_objective_invalid' });
      const post = cliente(erroPg('23503', 'therapeutic_activities_objective_id_fkey'));
      mockConnect.mockResolvedValue(post.cli);
      await expect(new TherapeuticCatalogRepository().create('activities', { label: 'A', objectiveId: 'x', actorUid: 'uid-1' })).rejects.toBeInstanceOf(CatalogObjectiveInvalidError);
    });

    it('091: 23503 de OUTRA FK propaga cru — não vira 409 mentiroso', async () => {
      const { cli } = cliente(erroPg('23503', 'therapeutic_activity_icd_categories_atividade_fk'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().update('activities', 'item-1', { objectiveId: 'x', actorUid: 'uid-1' }),
      ).rejects.not.toBeInstanceOf(ActivityCategoriesOutsideObjectiveError);
    });

    it('nenhuma linha atingida (id inexistente) → null, e o controller responde 404', async () => {
      const { cli } = cliente({ rows: [] });
      mockConnect.mockResolvedValue(cli);
      expect(await new TherapeuticCatalogRepository().update('activities', 'nao-existe', { label: 'X', actorUid: 'uid-1' })).toBeNull();
    });

    it('rótulo repetido no PATCH também vira CatalogLabelTakenError', async () => {
      const { cli } = cliente(erroPg('23505', 'uq_therapeutic_activities_label_ativo'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().update('activities', 'item-1', { label: 'Repetido', actorUid: 'uid-1' }),
      ).rejects.toBeInstanceOf(CatalogLabelTakenError);
    });

    it('erro genérico no PATCH propaga cru', async () => {
      const { cli } = cliente(new Error('boom'));
      mockConnect.mockResolvedValue(cli);
      await expect(
        new TherapeuticCatalogRepository().update('activities', 'item-1', { label: 'X', actorUid: 'uid-1' }),
      ).rejects.toThrow('boom');
    });
  });
});
