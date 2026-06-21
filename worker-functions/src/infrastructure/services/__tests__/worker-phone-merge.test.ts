/**
 * worker-phone-merge.test.ts
 *
 * Testes unitários (com mock de pool/client) para a camada de merge de workers.
 *
 * Cobertos:
 *   classifyWorkerTier        → TIER 1 / 2 / 3 por auth_uid e email
 *   isFirebaseRealUid         → prefixos sintéticos vs UIDs reais (legado)
 *   selectMostComplete        → critérios de desempate (score → docs → updated_at)
 *   detectLegalFieldExceptions → apenas divergentes com ambos não-nulos geram exceção
 *   buildGroupPlans           → 3 categorias + skip + conflict
 *     - 1 TIER1 + N TIER2 = firebase (não conflict)   [caso do dry-run falso-positivo]
 *     - 2 TIER1 = conflict
 *   resolveGhosts             → ghost match + ghost orphan (no_phone + no_real_match)
 *   buildReparentQueries      → contagem de queries, estratégias update e upsert_delete
 *                               agora recebe FkTableInfo[] (descoberta dinâmica)
 *   discoverWorkerFkTables    → retorna lista correta a partir de rows do information_schema
 *   WorkerPhoneMergeService:
 *     executeSingleMerge      → idempotência, BEGIN/COMMIT, reparent, auditoria
 *     dryRun                  → estrutura do relatório, sem escrita
 *     execute                 → chama discoverWorkerFkTables uma vez antes dos merges
 */

// ─── Mocks antes de qualquer import ────────────────────────────────────────

jest.mock('@shared/database/DatabaseConnection');
jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn() },
}));

import type { Pool } from 'pg';
import {
  classifyWorkerTier,
  isFirebaseRealUid,
  selectMostComplete,
  detectLegalFieldExceptions,
  buildGroupPlans,
  resolveGhosts,
} from '../WorkerPhoneMergeHelpers';
import { buildReparentQueries } from '../WorkerPhoneMergeReparent';
import { WorkerPhoneMergeService } from '../WorkerPhoneMergeService';
import { FK_TABLES_TO_REPARENT, type WorkerInGroup } from '../WorkerPhoneMergeTypes';
import { type FkTableInfo } from '../WorkerPhoneMergeFkDiscovery';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

// ─── FkTableInfo representativa para os testes de buildReparentQueries ─────
//
// Converte a lista legada para o novo shape FkTableInfo, com fk_column='worker_id'.
// Isso preserva as asserções existentes sem depender de banco real.
const MOCK_DISCOVERED_FKS: FkTableInfo[] = FK_TABLES_TO_REPARENT.map(cfg => ({
  table:       cfg.table,
  fk_column:   'worker_id',
  strategy:    cfg.strategy,
  unique_cols: cfg.unique_cols ? [...cfg.unique_cols] : [],
}));

// ─── Helpers de fixture ────────────────────────────────────────────────────

function makeWorker(overrides: Partial<WorkerInGroup> = {}): WorkerInGroup {
  return {
    id:                       'w-default-id',
    auth_uid:                 'base1import_abc',
    email:                    'worker@enlite.import',
    phone:                    '5491151265663',
    phone_normalized:         '5491151265663',
    updated_at:               new Date('2025-01-01'),
    merged_into_id:           null,
    completeness_score:       3,
    document_count:           0,
    non_null_fields:          ['first_name_encrypted', 'phone', 'profession'],
    document_number_encrypted: null,
    data_sources:             ['planilla_operativa'],
    ...overrides,
  };
}

function makePool(queryResponses: unknown[] = []): jest.Mocked<{ query: jest.Mock; connect: jest.Mock }> {
  let callIdx = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = queryResponses[callIdx++] ?? { rows: [] };
      return Promise.resolve(resp);
    }),
    connect: jest.fn(),
  } as jest.Mocked<{ query: jest.Mock; connect: jest.Mock }>;
}

function makeClient(): jest.Mocked<{ query: jest.Mock; release: jest.Mock }> {
  return {
    query:   jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
}

// ─── classifyWorkerTier ────────────────────────────────────────────────────

describe('classifyWorkerTier', () => {
  // TIER 3: auth_uid sintético (qualquer email)
  it('TIER 3: auth_uid base1import_ → sintético, qualquer email', () => {
    expect(classifyWorkerTier({ auth_uid: 'base1import_xyz', email: 'w@gmail.com' })).toBe(3);
  });
  it('TIER 3: auth_uid anacareimport_', () => {
    expect(classifyWorkerTier({ auth_uid: 'anacareimport_123', email: 'w@gmail.com' })).toBe(3);
  });
  it('TIER 3: auth_uid candidatoimport_', () => {
    expect(classifyWorkerTier({ auth_uid: 'candidatoimport_xyz', email: 'w@gmail.com' })).toBe(3);
  });
  it('TIER 3: auth_uid pretalnimport_', () => {
    expect(classifyWorkerTier({ auth_uid: 'pretalnimport_abc', email: 'w@gmail.com' })).toBe(3);
  });
  it('TIER 3: auth_uid clickup_encuadre_', () => {
    expect(classifyWorkerTier({ auth_uid: 'clickup_encuadre_123', email: 'w@gmail.com' })).toBe(3);
  });
  it('TIER 3: auth_uid talentum_', () => {
    expect(classifyWorkerTier({ auth_uid: 'talentum_abc123', email: 'w@gmail.com' })).toBe(3);
  });
  it('TIER 3: auth_uid sintético com @enlite.import também é TIER 3 (síntético domina)', () => {
    expect(classifyWorkerTier({ auth_uid: 'talentum_abc', email: 'x@enlite.import' })).toBe(3);
  });

  // TIER 2: auth_uid não-sintético MAS email @enlite.import
  it('TIER 2: auth_uid Firebase real + email @enlite.import', () => {
    expect(classifyWorkerTier({ auth_uid: 'vQmKpT9xFirebaseUID', email: 'worker@enlite.import' })).toBe(2);
  });
  it('TIER 2: email @enlite.import case-insensitive', () => {
    expect(classifyWorkerTier({ auth_uid: 'XnJ2kFirebase', email: 'WORKER@ENLITE.IMPORT' })).toBe(2);
  });

  // TIER 1: auth_uid não-sintético E email sem @enlite.import
  it('TIER 1: auth_uid Firebase real + email real', () => {
    expect(classifyWorkerTier({ auth_uid: 'vQmKpT9xYzW2aB3cD4eF5gH6', email: 'user@gmail.com' })).toBe(1);
  });
  it('TIER 1: UID Firebase real tipico (28 chars) + email real', () => {
    expect(classifyWorkerTier({ auth_uid: 'XnJ2kP9abcFirebaseUID', email: 'user@hotmail.com' })).toBe(1);
  });
});

// ─── isFirebaseRealUid (legado — mantido para não quebrar callers existentes) ──

describe('isFirebaseRealUid', () => {
  it('retorna false para prefixo base1import_', () => {
    expect(isFirebaseRealUid('base1import_xyz')).toBe(false);
  });
  it('retorna false para prefixo anacareimport_', () => {
    expect(isFirebaseRealUid('anacareimport_123')).toBe(false);
  });
  it('retorna false para prefixo talentum_', () => {
    expect(isFirebaseRealUid('talentum_abc123')).toBe(false);
  });
  it('retorna false para null', () => {
    expect(isFirebaseRealUid(null)).toBe(false);
  });
  it('retorna false para string vazia', () => {
    expect(isFirebaseRealUid('')).toBe(false);
  });
  it('PEGADINHA: UID Firebase real que começa com letra maiúscula não sintética → true', () => {
    // UIDs Firebase são alfanuméricos, ex: 'XnJ2kP9abc'
    expect(isFirebaseRealUid('XnJ2kP9abcFirebaseUID')).toBe(true);
  });
  it('UID Firebase real típico (28 chars) → true', () => {
    expect(isFirebaseRealUid('vQmKpT9xYzW2aB3cD4eF5gH6')).toBe(true);
  });
  it('MUDANÇA v2: IMPORT_ maiúsculo NÃO é mais sintético (não estava na SSOT)', () => {
    // Antes: IMPORT_ era listado como prefixo sintético — era um bug (não existe na SSOT)
    // Agora: isFirebaseRealUid retorna true para prefixos que não estão na SSOT
    expect(isFirebaseRealUid('IMPORT_abc')).toBe(true);
  });
});

// ─── selectMostComplete ────────────────────────────────────────────────────

describe('selectMostComplete', () => {
  it('elege o com maior completeness_score', () => {
    const w1 = makeWorker({ id: 'w1', completeness_score: 5, document_count: 0 });
    const w2 = makeWorker({ id: 'w2', completeness_score: 8, document_count: 0 });
    expect(selectMostComplete([w1, w2]).id).toBe('w2');
  });

  it('PEGADINHA: score empatado → desempata por document_count', () => {
    const w1 = makeWorker({ id: 'w1', completeness_score: 5, document_count: 2 });
    const w2 = makeWorker({ id: 'w2', completeness_score: 5, document_count: 5 });
    expect(selectMostComplete([w1, w2]).id).toBe('w2');
  });

  it('PEGADINHA: score e docs empatados → desempata por updated_at mais recente', () => {
    const w1 = makeWorker({ id: 'w1', completeness_score: 5, document_count: 2, updated_at: new Date('2024-01-01') });
    const w2 = makeWorker({ id: 'w2', completeness_score: 5, document_count: 2, updated_at: new Date('2025-06-01') });
    expect(selectMostComplete([w1, w2]).id).toBe('w2');
  });

  it('não muta o array original', () => {
    const workers = [
      makeWorker({ id: 'w1', completeness_score: 7 }),
      makeWorker({ id: 'w2', completeness_score: 3 }),
    ];
    selectMostComplete(workers);
    expect(workers[0].id).toBe('w1'); // ordem preservada
  });
});

// ─── detectLegalFieldExceptions ───────────────────────────────────────────

describe('detectLegalFieldExceptions', () => {
  it('sem exceção quando ambos têm document_number null', () => {
    const s = makeWorker({ document_number_encrypted: null });
    const a = makeWorker({ document_number_encrypted: null });
    expect(detectLegalFieldExceptions(s, a)).toHaveLength(0);
  });

  it('sem exceção quando apenas absorvido tem document_number (COALESCE seguro)', () => {
    const s = makeWorker({ document_number_encrypted: null });
    const a = makeWorker({ document_number_encrypted: 'enc_abc123_value' });
    expect(detectLegalFieldExceptions(s, a)).toHaveLength(0);
  });

  it('sem exceção quando valores são IGUAIS (mesma pessoa, mesmo doc)', () => {
    const s = makeWorker({ document_number_encrypted: 'enc_abc123_same' });
    const a = makeWorker({ document_number_encrypted: 'enc_abc123_same' });
    expect(detectLegalFieldExceptions(s, a)).toHaveLength(0);
  });

  it('EXCEÇÃO quando ambos têm document_number E são diferentes', () => {
    const s = makeWorker({ document_number_encrypted: 'enc_survivor_doc' });
    const a = makeWorker({ document_number_encrypted: 'enc_absorbed_doc' });
    const exceptions = detectLegalFieldExceptions(s, a);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].field).toBe('document_number_encrypted');
    expect(exceptions[0].reason).toBe('divergent_values_both_non_null');
  });

  it('hash no relatório não expõe o ciphertext inteiro', () => {
    const s = makeWorker({ document_number_encrypted: 'enc_SENSITIVE_DATA_SURVIVOR_FULL' });
    const a = makeWorker({ document_number_encrypted: 'enc_SENSITIVE_DATA_ABSORBED_FULL' });
    const ex = detectLegalFieldExceptions(s, a)[0];
    // Mostra apenas os primeiros 8 chars + '...'
    expect(ex.survivor_value_hash).toMatch(/^enc_SENS\.\.\./);
    expect(ex.absorbed_value_hash).toMatch(/^enc_SENS\.\.\./);
  });
});

// ─── buildGroupPlans ──────────────────────────────────────────────────────

describe('buildGroupPlans', () => {
  it('categoria firebase: exatamente 1 TIER 1 → ele é o sobrevivente', async () => {
    const tier1Worker = makeWorker({ id: 'fw1', auth_uid: 'vQmKpT9xYzW2Firebase', email: 'real@gmail.com' });
    const synthetic1  = makeWorker({ id: 'sw1', auth_uid: 'base1import_xyz' });
    const synthetic2  = makeWorker({ id: 'sw2', auth_uid: 'talentum_abc' });

    const pool = makePool([
      { rows: [tier1Worker, synthetic1, synthetic2] }, // fetchWorkersById
    ]) as unknown as Pool;

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491151265663', worker_ids: ['fw1', 'sw1', 'sw2'] }],
      pool,
    );

    expect(plans).toHaveLength(1);
    expect(plans[0].category).toBe('firebase');
    expect(plans[0].survivor_id).toBe('fw1');
    expect(plans[0].absorbed_ids).toEqual(expect.arrayContaining(['sw1', 'sw2']));
  });

  it('BUG CORRIGIDO: 1 TIER 1 + vários TIER 2 (@enlite.import) = firebase, NÃO conflict', async () => {
    // Antes da correção, TIER 2 (uid real + @enlite.import) era tratado como "firebase real"
    // junto com o TIER 1, gerando falso CONFLICT no dry-run de prod.
    const tier1  = makeWorker({ id: 't1', auth_uid: 'FirebaseRealUID_aaa', email: 'real@gmail.com' });
    const tier2a = makeWorker({ id: 't2a', auth_uid: 'FirebaseRealUID_bbb', email: 'worker@enlite.import' });
    const tier2b = makeWorker({ id: 't2b', auth_uid: 'FirebaseRealUID_ccc', email: 'outro@enlite.import' });

    const pool = makePool([{ rows: [tier1, tier2a, tier2b] }]) as unknown as Pool;

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491444444444', worker_ids: ['t1', 't2a', 't2b'] }],
      pool,
    );

    expect(plans[0].category).toBe('firebase');        // auto, não conflict
    expect(plans[0].survivor_id).toBe('t1');           // TIER 1 é o sobrevivente
    expect(plans[0].absorbed_ids).toEqual(expect.arrayContaining(['t2a', 't2b']));
  });

  it('categoria conflict: ≥2 TIER 1 reais → sem sobrevivente, sem absorvidos', async () => {
    const fb1 = makeWorker({ id: 'fb1', auth_uid: 'FirebaseUID_aaa', email: 'user1@gmail.com' });
    const fb2 = makeWorker({ id: 'fb2', auth_uid: 'FirebaseUID_bbb', email: 'user2@hotmail.com' });

    const pool = makePool([{ rows: [fb1, fb2] }]) as unknown as Pool;

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491222222222', worker_ids: ['fb1', 'fb2'] }],
      pool,
    );

    expect(plans[0].category).toBe('conflict');
    expect(plans[0].survivor_id).toBeNull();
    expect(plans[0].absorbed_ids).toHaveLength(0);
    expect(plans[0].survivor_reason).toMatch(/2_tier1_real_humans/);
  });

  it('TIER 1 + TIER 2 + TIER 3 misturados: apenas TIER 1 conta para conflict', async () => {
    // Cenário: 1 real, 1 @enlite.import, 1 sintético — deve ser firebase (auto), não conflict
    const tier1 = makeWorker({ id: 'r1', auth_uid: 'FirebaseUID_real', email: 'person@gmail.com' });
    const tier2 = makeWorker({ id: 'r2', auth_uid: 'FirebaseUID_claimed', email: 'w@enlite.import' });
    const tier3 = makeWorker({ id: 'r3', auth_uid: 'talentum_xyz', email: 'any@email.com' });

    const pool = makePool([{ rows: [tier1, tier2, tier3] }]) as unknown as Pool;

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491555555555', worker_ids: ['r1', 'r2', 'r3'] }],
      pool,
    );

    expect(plans[0].category).toBe('firebase');
    expect(plans[0].survivor_id).toBe('r1');
    expect(plans[0].absorbed_ids).toEqual(expect.arrayContaining(['r2', 'r3']));
  });

  it('categoria most_complete: 0 TIER 1 → elege por completude entre TIER 2 e TIER 3', async () => {
    const w1 = makeWorker({ id: 'w1', auth_uid: 'base1import_a', completeness_score: 3 });
    const w2 = makeWorker({ id: 'w2', auth_uid: 'anacareimport_b', completeness_score: 7 });

    const pool = makePool([{ rows: [w1, w2] }]) as unknown as Pool;

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491111111111', worker_ids: ['w1', 'w2'] }],
      pool,
    );

    expect(plans[0].category).toBe('most_complete');
    expect(plans[0].survivor_id).toBe('w2');
    expect(plans[0].absorbed_ids).toEqual(['w1']);
  });

  it('TIER 2 vs TIER 3 sem TIER 1: elege most_complete (não conflict)', async () => {
    const tier2 = makeWorker({ id: 't2', auth_uid: 'FirebaseUID_claimed', email: 'w@enlite.import', completeness_score: 6 });
    const tier3 = makeWorker({ id: 't3', auth_uid: 'talentum_xyz', email: 'x@enlite.import', completeness_score: 2 });

    const pool = makePool([{ rows: [tier2, tier3] }]) as unknown as Pool;

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491666666666', worker_ids: ['t2', 't3'] }],
      pool,
    );

    expect(plans[0].category).toBe('most_complete');
    expect(plans[0].survivor_id).toBe('t2');
  });

  it('categoria skip: apenas 1 ativo (já resolvido) → sem absorbed_ids', async () => {
    const w1 = makeWorker({ id: 'w1', merged_into_id: 'other-id' }); // já mergeado, filtrado
    const w2 = makeWorker({ id: 'w2', merged_into_id: null });

    const pool = makePool([{ rows: [w2] }]) as unknown as Pool; // fetchWorkersById filtra merged

    const plans = await buildGroupPlans(
      [{ phone_normalized: '5491333333333', worker_ids: ['w1', 'w2'] }],
      pool,
    );

    expect(plans[0].category).toBe('skip');
    expect(plans[0].absorbed_ids).toHaveLength(0);
  });
});

// ─── resolveGhosts ────────────────────────────────────────────────────────

describe('resolveGhosts', () => {
  it('ghost COM phone e match real → ghostMatches', async () => {
    const pool = makePool([
      { rows: [{ id: 'g1', email: 'worker@enlite.import', phone: '5491151265663', phone_normalized: '5491151265663' }] },
      { rows: [{ id: 'r1', email: 'worker@gmail.com' }] }, // match real
    ]) as unknown as Pool;

    const { ghostMatches, ghostOrphans } = await resolveGhosts(pool);

    expect(ghostMatches).toHaveLength(1);
    expect(ghostMatches[0].ghost_id).toBe('g1');
    expect(ghostMatches[0].real_id).toBe('r1');
    expect(ghostOrphans).toHaveLength(0);
  });

  it('ghost SEM phone → ghostOrphan com reason no_phone', async () => {
    const pool = makePool([
      { rows: [{ id: 'g2', email: 'noPhone@enlite.import', phone: null, phone_normalized: null }] },
    ]) as unknown as Pool;

    const { ghostMatches, ghostOrphans } = await resolveGhosts(pool);

    expect(ghostMatches).toHaveLength(0);
    expect(ghostOrphans).toHaveLength(1);
    expect(ghostOrphans[0].reason).toBe('no_phone');
    expect(ghostOrphans[0].worker_id).toBe('g2');
  });

  it('ghost COM phone MAS sem match real → ghostOrphan com reason no_real_match', async () => {
    const pool = makePool([
      { rows: [{ id: 'g3', email: 'alone@enlite.import', phone: '5491999999999', phone_normalized: '5491999999999' }] },
      { rows: [] }, // nenhum real encontrado
    ]) as unknown as Pool;

    const { ghostMatches, ghostOrphans } = await resolveGhosts(pool);

    expect(ghostMatches).toHaveLength(0);
    expect(ghostOrphans).toHaveLength(1);
    expect(ghostOrphans[0].reason).toBe('no_real_match');
  });
});

// ─── buildReparentQueries ─────────────────────────────────────────────────

describe('buildReparentQueries', () => {
  it('gera queries para TODAS as tabelas em MOCK_DISCOVERED_FKS', () => {
    const queries = buildReparentQueries('survivor-id', 'absorbed-id', MOCK_DISCOVERED_FKS);
    // Extrai a tabela do description (formato: "reparent:<strategy>:<table>:<col>")
    const tablesWithQueries = new Set(
      queries.map(q => {
        const parts = q.description.split(':');
        // parts[2] é a tabela, parts[3] é a coluna
        return parts[2];
      }),
    );

    for (const cfg of MOCK_DISCOVERED_FKS) {
      expect(tablesWithQueries.has(cfg.table)).toBe(true);
    }
  });

  it('PEGADINHA: worker_job_applications (N:1) → inclui DELETE de conflitos ANTES do UPDATE', () => {
    const queries = buildReparentQueries('s', 'a', MOCK_DISCOVERED_FKS);
    const wjaQueries = queries.filter(q => q.description.includes('worker_job_applications'));

    // Deve ter: delete_conflicts + update (2 queries para N:1)
    expect(wjaQueries.length).toBeGreaterThanOrEqual(2);

    const deleteIdx = wjaQueries.findIndex(q => q.description.includes('dedup_conflicts'));
    const updateIdx = wjaQueries.findIndex(q => q.description.includes('Nto1_update'));

    // Delete de conflitos deve vir ANTES do update
    expect(deleteIdx).toBeLessThan(updateIdx);
  });

  it('worker_documents (1:1) → UPDATE condicional + DELETE cleanup', () => {
    const queries = buildReparentQueries('s', 'a', MOCK_DISCOVERED_FKS);
    const docsQueries = queries.filter(q => q.description.includes('worker_documents'));

    expect(docsQueries).toHaveLength(2);
    expect(docsQueries[0].sql).toMatch(/NOT EXISTS/);
    expect(docsQueries[1].sql).toMatch(/DELETE/);
  });

  it('PEGADINHA: DELETE cleanup de tabela 1:1 usa apenas [absorbedId] (1 param)', () => {
    // O DELETE FROM worker_documents WHERE worker_id = $1 só precisa do absorbedId.
    // Confirma que o gerador não passa acidentalmente o survivor como parâmetro extra.
    const queries = buildReparentQueries('surv-uuid', 'abs-uuid', MOCK_DISCOVERED_FKS);
    const docsCleanup = queries.find(q =>
      q.description === 'reparent:1to1_cleanup:worker_documents:worker_id',
    );
    expect(docsCleanup).toBeDefined();
    expect(docsCleanup!.params).toEqual(['abs-uuid']);
  });

  it('tabela com fk_column diferente de worker_id gera SQL com a coluna correta', () => {
    const customFks: FkTableInfo[] = [
      { table: 'some_audit', fk_column: 'reviewed_by_worker_id', strategy: 'update', unique_cols: [] },
    ];
    const queries = buildReparentQueries('surv', 'abs', customFks);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/reviewed_by_worker_id/);
    expect(queries[0].description).toBe('reparent:update:some_audit:reviewed_by_worker_id');
  });

  it('multi-FK na mesma tabela gera queries independentes para cada coluna', () => {
    const multiFks: FkTableInfo[] = [
      { table: 'some_table', fk_column: 'worker_id',             strategy: 'update', unique_cols: [] },
      { table: 'some_table', fk_column: 'reviewed_by_worker_id', strategy: 'update', unique_cols: [] },
    ];
    const queries = buildReparentQueries('surv', 'abs', multiFks);
    expect(queries).toHaveLength(2);
    expect(queries[0].description).toContain('worker_id');
    expect(queries[1].description).toContain('reviewed_by_worker_id');
  });

  it('lista vazia de FKs gera 0 queries (banco sem tabelas filho)', () => {
    const queries = buildReparentQueries('surv', 'abs', []);
    expect(queries).toHaveLength(0);
  });
});

// ─── discoverWorkerFkTables (unit — mock de pool) ─────────────────────────

describe('discoverWorkerFkTables', () => {
  // Importa a função diretamente para testar a lógica de mapeamento
  // sem depender de banco real.
  const { discoverWorkerFkTables: discover } = jest.requireActual(
    '../WorkerPhoneMergeFkDiscovery',
  ) as typeof import('../WorkerPhoneMergeFkDiscovery');

  it('retorna lista vazia quando information_schema não retorna FKs', async () => {
    const fakePool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    const result = await discover(fakePool);
    expect(result).toHaveLength(0);
  });

  it('estratégia update quando unique constraint não existe para a coluna FK', async () => {
    const fakePool = {
      query: jest.fn()
        // 1ª chamada: FK_DISCOVERY_SQL → retorna 1 FK
        .mockResolvedValueOnce({ rows: [{ fk_table: 'worker_availability', fk_column: 'worker_id' }] })
        // 2ª chamada: UNIQUE_CONSTRAINT_SQL → sem unique constraint
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Pool;

    const result = await discover(fakePool);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ table: 'worker_availability', fk_column: 'worker_id', strategy: 'update', unique_cols: [] });
  });

  it('estratégia upsert_delete quando unique constraint existe para a coluna FK', async () => {
    const fakePool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ fk_table: 'worker_job_applications', fk_column: 'worker_id' }] })
        .mockResolvedValueOnce({ rows: [{ cols: ['worker_id', 'job_posting_id'] }] }),
    } as unknown as Pool;

    const result = await discover(fakePool);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      table:       'worker_job_applications',
      fk_column:   'worker_id',
      strategy:    'upsert_delete',
      unique_cols: ['worker_id', 'job_posting_id'],
    });
  });

  it('multi-FK por tabela: retorna uma entrada por (table, fk_column)', async () => {
    const fakePool = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [
            { fk_table: 'some_table', fk_column: 'worker_id' },
            { fk_table: 'some_table', fk_column: 'reviewed_by_worker_id' },
          ],
        })
        // unique check para worker_id: sem constraint
        .mockResolvedValueOnce({ rows: [] })
        // unique check para reviewed_by_worker_id: sem constraint
        .mockResolvedValueOnce({ rows: [] }),
    } as unknown as Pool;

    const result = await discover(fakePool);
    expect(result).toHaveLength(2);
    expect(result[0].fk_column).toBe('worker_id');
    expect(result[1].fk_column).toBe('reviewed_by_worker_id');
    // Ambas com strategy update (sem unique constraint)
    expect(result[0].strategy).toBe('update');
    expect(result[1].strategy).toBe('update');
  });

  it('WARN de tabelas conhecidas ausentes (drift de schema) — não lança erro', async () => {
    const fakePool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] }), // FK_DISCOVERY_SQL retorna vazio
    } as unknown as Pool;

    // Não deve lançar — apenas logar WARN
    await expect(
      discover(fakePool, { knownTables: ['worker_quiz_responses', 'worker_availability'] }),
    ).resolves.toEqual([]);
  });
});

// ─── WorkerPhoneMergeService.executeSingleMerge ───────────────────────────

describe('WorkerPhoneMergeService.executeSingleMerge', () => {
  let service: WorkerPhoneMergeService;
  let mockClient: ReturnType<typeof makeClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = makeClient();

    const mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
      query:   jest.fn().mockResolvedValue({ rows: [] }),
      end:     jest.fn(),
    };

    (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({
      getPool: () => mockPool,
    });

    service = new WorkerPhoneMergeService();
  });

  it('idempotência: absorvido já com merged_into_id → ROLLBACK sem fazer mais nada', async () => {
    // Primeira query (check merged_into_id) retorna id preenchido
    mockClient.query
      .mockResolvedValueOnce(undefined)                                   // BEGIN
      .mockResolvedValueOnce({ rows: [{ merged_into_id: 'some-other' }] }); // check

    // Passa discoveredFks explicitamente para não depender de pool.query mock
    await service.executeSingleMerge({
      survivorId:           's1',
      absorbedId:           'a1',
      phoneNormalized:      '5491111111111',
      category:             'firebase',
      legalFieldExceptions: [],
      discoveredFks:        MOCK_DISCOVERED_FKS,
    });

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    // Não deve ter tentado reparentar nada
    expect(calls.some(q => q.includes('UPDATE') && q.includes('worker_id'))).toBe(false);
  });

  it('happy path: BEGIN → audit_insert → snapshot → coalesce → reparent → soft-delete → COMMIT', async () => {
    // Nova ordem após adição de snapshot:
    //   0: BEGIN
    //   1: SELECT merged_into_id (check idempotência)
    //   2: INSERT worker_merge_audit RETURNING id
    //   3: SELECT * FROM workers (captureSnapshot: worker_row)
    //   4+: SELECT * FROM fk tables (captureSnapshot: fk_rows) — pode haver 0 a N
    //   N: INSERT INTO worker_merge_snapshots RETURNING id
    //   N+1: UPDATE workers (coalesce)
    //   N+2: SELECT fields_filled
    //   N+3: UPDATE worker_merge_audit SET fields_filled
    //   N+4+: reparent queries
    //   M: UPDATE workers SET merged_into_id
    //   M+1: COMMIT
    mockClient.query
      .mockResolvedValueOnce(undefined)                             // BEGIN
      .mockResolvedValueOnce({ rows: [{ merged_into_id: null }] }) // check idempotência
      .mockResolvedValueOnce({ rows: [{ id: '42' }] })             // INSERT worker_merge_audit RETURNING id
      .mockResolvedValueOnce({ rows: [{ id: 'a1', email: 'x@x.com' }] }) // SELECT * FROM workers (snapshot)
      .mockResolvedValue({ rows: [{ fields_filled: ['profession'], id: 'snap-1' }] }); // resto (fk tables + snapshot insert + coalesce + etc)

    // Passa discoveredFks com lista vazia para simplificar (sem fk_rows extras)
    await service.executeSingleMerge({
      survivorId:           's1',
      absorbedId:           'a1',
      phoneNormalized:      '5491111111111',
      category:             'firebase',
      legalFieldExceptions: [],
      discoveredFks:        [], // sem FKs = sem reparent queries
    });

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');

    // merged_into_id setado no absorvido
    const softDelete = calls.find(q => q.includes('merged_into_id') && q.includes('$1') && q.includes('$2'));
    expect(softDelete).toBeTruthy();

    // Auditoria inserida
    const audit = calls.find(q => q.includes('worker_merge_audit'));
    expect(audit).toBeTruthy();
  });

  it('erro no reparent → ROLLBACK, client.release() chamado', async () => {
    // Usa uma FK artificial para forçar uma query de reparent que vai falhar
    const oneFk: FkTableInfo[] = [
      { table: 'worker_availability', fk_column: 'worker_id', strategy: 'update', unique_cols: [] },
    ];

    // Nova ordem de queries com snapshot:
    //   0: BEGIN
    //   1: check idempotência
    //   2: INSERT worker_merge_audit RETURNING id
    //   3: SELECT * FROM workers (snapshot worker_row)
    //   4: SELECT * FROM worker_availability (snapshot fk_rows)
    //   5: INSERT worker_merge_snapshots RETURNING id
    //   6: UPDATE workers (coalesce)
    //   7: SELECT fields_filled
    //   8: UPDATE worker_merge_audit SET fields_filled
    //   9: reparent query → FALHA aqui
    mockClient.query
      .mockResolvedValueOnce(undefined)                                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ merged_into_id: null }] })          // check
      .mockResolvedValueOnce({ rows: [{ id: '99' }] })                      // INSERT audit RETURNING id
      .mockResolvedValueOnce({ rows: [{ id: 'a1', status: 'INCOMPLETE' }] }) // worker_row snapshot
      .mockResolvedValueOnce({ rows: [] })                                   // fk_rows (worker_availability)
      .mockResolvedValueOnce({ rows: [{ id: 'snap-99' }] })                 // INSERT snapshot RETURNING
      .mockResolvedValueOnce({ rows: [] })                                   // COALESCE UPDATE
      .mockResolvedValueOnce({ rows: [{ fields_filled: [] }] })             // fields query
      .mockResolvedValueOnce({ rows: [] })                                   // UPDATE audit fields_filled
      .mockRejectedValueOnce(new Error('FK constraint failed'));              // reparent falha

    await expect(
      service.executeSingleMerge({
        survivorId:           's1',
        absorbedId:           'a1',
        phoneNormalized:      '5491111111111',
        category:             'firebase',
        legalFieldExceptions: [],
        discoveredFks:        oneFk,
      }),
    ).rejects.toThrow('FK constraint failed');

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

// ─── WorkerPhoneMergeService.dryRun ──────────────────────────────────────

describe('WorkerPhoneMergeService.dryRun', () => {
  let service: WorkerPhoneMergeService;
  let mockPool: ReturnType<typeof makePool>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPool = makePool([]);
    // Override mockPool.connect para não ser chamado em dryRun
    (mockPool as unknown as { connect: jest.Mock }).connect = jest.fn();

    (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({
      getPool: () => mockPool,
    });

    service = new WorkerPhoneMergeService();
  });

  it('sem colisões e sem ghosts → relatório zerado e arrays vazios', async () => {
    // fetchCollisionGroups → []
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });
    // resolveGhosts: SELECT ghosts → []
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const plan = await service.dryRun();

    expect(plan.total_collision_groups).toBe(0);
    expect(plan.total_merges_planned).toBe(0);
    expect(plan.group_plans).toHaveLength(0);
    expect(plan.ghost_matches).toHaveLength(0);
    expect(plan.ghost_orphans).toHaveLength(0);
    expect(plan.conflict_groups).toHaveLength(0);
    expect(typeof plan.analyzed_at).toBe('string');
  });

  it('dryRun NÃO chama connect() (nenhuma escrita no banco)', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });

    await service.dryRun();

    expect((mockPool as unknown as { connect: jest.Mock }).connect).not.toHaveBeenCalled();
  });

  it('estrutura do relatório tem todos os campos obrigatórios', async () => {
    (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });

    const plan = await service.dryRun();

    const required = [
      'analyzed_at', 'total_collision_groups', 'total_firebase_groups',
      'total_most_complete_groups', 'total_conflict_groups',
      'total_ghost_matches', 'total_ghost_orphans',
      'group_plans', 'ghost_matches', 'ghost_orphans',
      'conflict_groups', 'total_merges_planned', 'analysis_errors',
    ] as const;

    for (const field of required) {
      expect(plan).toHaveProperty(field);
    }
  });
});
