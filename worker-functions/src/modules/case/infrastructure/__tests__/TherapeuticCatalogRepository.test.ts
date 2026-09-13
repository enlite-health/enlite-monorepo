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
  CatalogSegmentInvalidError,
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
    it('sem opts → só os ATIVOS, ordenados por active DESC, sort_order, lower(label); mapeia a linha inteira', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [ROW] });
      const itens = await new TherapeuticCatalogRepository().list('specific-objectives');
      const sql = mockPoolQuery.mock.calls[0][0] as string;
      expect(sql).toContain('FROM therapeutic_specific_objectives');
      expect(sql).toContain('WHERE active');
      expect(sql).toContain('ORDER BY active DESC, sort_order, lower(label)');
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
      expect(mockPoolQuery.mock.calls[0][0]).not.toContain('WHERE active');
      expect(itens[0]).toMatchObject({ active: false, deactivatedAt: '2026-09-08T11:00:00.000Z' });
    });

    it.each([
      ['specific-objectives', 'therapeutic_specific_objectives'],
      ['activities', 'therapeutic_activities'],
      ['segments', 'therapeutic_segments'],
    ] as const)('a tabela do kind %s vem do DOMÍNIO (%s), nunca de string do cliente', async (kind, tabela) => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      await new TherapeuticCatalogRepository().list(kind);
      expect(mockPoolQuery.mock.calls[0][0]).toContain(`FROM ${tabela}`);
      expect(THERAPEUTIC_CATALOG_TABLE[kind]).toBe(tabela);
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

  describe('snapshotOf (lex C19: o servidor congela o texto, o cliente só manda id)', () => {
    it('todos os ids ativos → devolve `{ id, label }` na ordem do catálogo', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A' }, { id: 'b', label: 'Objetivo B' }] });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('specific-objectives', ['a', 'b']);
      expect(snap).toEqual([{ id: 'a', label: 'Objetivo A' }, { id: 'b', label: 'Objetivo B' }]);
      expect(mockPoolQuery.mock.calls[0][0]).toContain('WHERE c.active AND c.id = ANY($1::uuid[])');
    });

    it('lex-pr7 C3(b): traz `segmentId`/`segmentLabel` (430) via LEFT JOIN com `therapeutic_segments`', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A', segment_id: 'seg-1', segment_label: 'Salud mental' }] });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('specific-objectives', ['a']);
      expect(snap).toEqual([{ id: 'a', label: 'Objetivo A', segmentId: 'seg-1', segmentLabel: 'Salud mental' }]);
      expect(mockPoolQuery.mock.calls[0][0]).toContain('LEFT JOIN therapeutic_segments s ON s.id = c.segment_id');
    });

    it('item sem segmento (segment_id NULL no catálogo) → `segmentId`/`segmentLabel` saem `null`, não `undefined`', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ id: 'a', label: 'Objetivo A', segment_id: null, segment_label: null }] });
      const snap = await new TherapeuticCatalogRepository().snapshotOf('specific-objectives', ['a']);
      expect(snap).toEqual([{ id: 'a', label: 'Objetivo A', segmentId: null, segmentLabel: null }]);
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

    it('US-17/430: com `segmentId` de um segmento ATIVO → checa o segmento ANTES, e o INSERT ganha a coluna', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ok: 1 }] }); // `assertSegmentActive` usa o pool, não a transação
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('specific-objectives', { label: 'Vínculo', segmentId: 'seg-1', actorUid: 'uid-1' });
      expect(mockPoolQuery.mock.calls[0][0]).toContain('FROM therapeutic_segments WHERE id = $1 AND active');
      expect(mockPoolQuery.mock.calls[0][1]).toEqual(['seg-1']);
      expect(chamadas[0].sql).toContain('segment_id');
      expect(chamadas[0].params).toEqual(['Vínculo', null, 'seg-1', 'uid-1']);
    });

    it('US-17/430: `segmentId` de segmento INATIVO/inexistente → `CatalogSegmentInvalidError`, SEM abrir transação', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      const p = new TherapeuticCatalogRepository().create('activities', { label: 'Acompañamiento', segmentId: 'sumido', actorUid: 'uid-1' });
      await expect(p).rejects.toBeInstanceOf(CatalogSegmentInvalidError);
      await expect(p).rejects.toMatchObject({ code: 'catalog_segment_invalid' });
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('US-17/430: `segmentId: null` (sem vínculo) NÃO consulta `therapeutic_segments`, mas a coluna entra NULL (chave presente)', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('activities', { label: 'Acompañamiento', segmentId: null, actorUid: 'uid-1' });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(chamadas[0].sql).toContain('segment_id');
      expect(chamadas[0].params).toEqual(['Acompañamiento', null, null, 'uid-1']);
    });

    it('US-17/430: SEM `segmentId` na chamada (kind `segments`, ou chamador que não manda a chave) — coluna fora do INSERT, params intactos', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().create('segments', { label: 'Salud mental', actorUid: 'uid-1' });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(chamadas[0].sql).toContain('INSERT INTO therapeutic_segments');
      expect(chamadas[0].sql).not.toContain('segment_id');
      expect(chamadas[0].params).toEqual(['Salud mental', null, 'uid-1']);
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

    it('US-17/430: `segmentId` de um segmento ATIVO → checa ANTES do UPDATE, coluna entra no SET', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [{ ok: 1 }] });
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('specific-objectives', 'item-1', { segmentId: 'seg-1', actorUid: 'uid-1' });
      expect(mockPoolQuery.mock.calls[0][0]).toContain('FROM therapeutic_segments WHERE id = $1 AND active');
      expect(chamadas[0].sql).toContain('segment_id = $2');
      expect(chamadas[0].params).toEqual(['item-1', 'seg-1', 'uid-1']);
    });

    it('US-17/430: `segmentId` de segmento INATIVO/inexistente → `CatalogSegmentInvalidError`, SEM abrir transação', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });
      const p = new TherapeuticCatalogRepository().update('activities', 'item-1', { segmentId: 'sumido', actorUid: 'uid-1' });
      await expect(p).rejects.toBeInstanceOf(CatalogSegmentInvalidError);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('US-17/430: `segmentId: null` LIMPA o vínculo — sem checar `therapeutic_segments`', async () => {
      const { cli, chamadas } = cliente();
      mockConnect.mockResolvedValue(cli);
      await new TherapeuticCatalogRepository().update('activities', 'item-1', { segmentId: null, actorUid: 'uid-1' });
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(chamadas[0].sql).toContain('segment_id = $2');
      expect(chamadas[0].params).toEqual(['item-1', null, 'uid-1']);
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
