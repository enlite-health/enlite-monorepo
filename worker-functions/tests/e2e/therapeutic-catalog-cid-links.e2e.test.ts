/**
 * Spec 091 (T207, DD-2, DD-11, DD-16, DD-23) — lookup de categoria CID-11 e repositório de vínculos, no BANCO REAL.
 *
 * Provas: add/list/remove de objetivo e de atividade; atividade fora do objetivo → erro nomeado (23503 da FK composta);
 * remover a categoria do objetivo devolve `removedActivityLinks` contado na transação e relê 0; `search` só devolve `stem`
 * de 4 caracteres. A terminologia vem de linhas semeadas AQUI (sintéticas, URIs `http://e2e207.test/…`) e limpas no fim.
 * Só dado de catálogo e de terminologia; nenhum dado de paciente.
 */
import { Pool } from 'pg';
import { PgIcdCategoryLookup } from '../../src/modules/case/infrastructure/PgIcdCategoryLookup';
import { TherapeuticCatalogLinkRepository } from '../../src/modules/case/infrastructure/TherapeuticCatalogLinkRepository';
import { InvalidIcdCategoryCodeError } from '../../src/modules/case/domain/icdCategory';
import {
  CatalogLinkOwnerNotFoundError,
  IcdCategoryAlreadyLinkedError,
  IcdCategoryNotInObjectiveError,
} from '../../src/modules/case/domain/TherapeuticCatalogLinkErrors';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ACTOR = 'e2e207-actor';
const URI = 'http://e2e207.test/';
const PROBE = 'e2e207probe';
const CAT_A = 'ZZ01';
const CAT_B = 'ZZ02';
const CAT_EXTENSION = 'ZZ03'; // kind='extension', 4 caracteres: o filtro por kind a exclui
const CAT_SUBCODE = 'ZZ04.1'; // kind='stem' mas com 6 caracteres: o filtro de 4 caracteres a exclui
const CAT_UNKNOWN = 'ZZ09'; // não existe na terminologia semeada

describe('vínculos item↔categoria CID-11 e lookup de categoria (banco real) @integration', () => {
  let pool: Pool;
  let createdRelease: string | null = null;
  let release: string;
  let lookup: PgIcdCategoryLookup;
  let repo: TherapeuticCatalogLinkRepository;
  let objectiveId: string;
  let otherObjectiveId: string;
  let activityId: string;
  let activity2Id: string;
  let otherActivityId: string;

  const insertEntity = (code: string, kind: string, title: string, n: number) =>
    pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, chapter, kind)
       VALUES ($1, $2, $3, $4, '06', $5)`,
      [`${URI}${n}`, release, code, title, kind],
    );
  const insertObjective = async (label: string) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_specific_objectives (label, service_code, created_by, updated_by)
       VALUES ($1, 'AT', $2, $2) RETURNING id`,
      [label, ACTOR],
    )).rows[0].id;
  const insertActivity = async (label: string, objective: string) =>
    (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_activities (label, objective_id, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`,
      [label, objective, ACTOR],
    )).rows[0].id;
  const count = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);

  async function cleanup(): Promise<void> {
    const objectives = `(SELECT id FROM therapeutic_specific_objectives WHERE created_by = '${ACTOR}')`;
    await pool.query(`DELETE FROM therapeutic_activity_icd_categories WHERE created_by = $1 OR objective_id IN ${objectives}`, [ACTOR]);
    await pool.query(`DELETE FROM therapeutic_objective_icd_categories WHERE created_by = $1 OR objective_id IN ${objectives}`, [ACTOR]);
    await pool.query(`DELETE FROM therapeutic_activities WHERE created_by = $1`, [ACTOR]);
    await pool.query(`DELETE FROM therapeutic_specific_objectives WHERE created_by = $1`, [ACTOR]);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE icd_uri LIKE $1`, [`${URI}%`]);
    if (createdRelease) await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [createdRelease]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    const current = await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current`);
    if (current.rows[0]) {
      release = current.rows[0].release;
    } else {
      release = 'e2e207-release';
      createdRelease = release;
      await pool.query(
        `INSERT INTO terminology.icd_releases (release, is_current, promoted_at, promoted_by) VALUES ($1, true, NOW(), $2)`,
        [release, ACTOR],
      );
    }
    await insertEntity(CAT_A, 'stem', `${PROBE} categoria alfa`, 1);
    await insertEntity(CAT_B, 'stem', `${PROBE} categoria beta`, 2);
    await insertEntity(CAT_EXTENSION, 'extension', `${PROBE} extensao`, 3);
    await insertEntity(CAT_SUBCODE, 'stem', `${PROBE} subcodigo`, 4);

    lookup = new PgIcdCategoryLookup(pool);
    repo = new TherapeuticCatalogLinkRepository(lookup, pool);
    objectiveId = await insertObjective('e2e207 objetivo principal');
    otherObjectiveId = await insertObjective('e2e207 objetivo outro');
    activityId = await insertActivity('e2e207 atividade 1', objectiveId);
    activity2Id = await insertActivity('e2e207 atividade 2', objectiveId);
    otherActivityId = await insertActivity('e2e207 atividade do outro', otherObjectiveId);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  describe('PgIcdCategoryLookup (DD-11)', () => {
    it('search só devolve stem de 4 caracteres do release corrente', async () => {
      const found = await lookup.search(PROBE);
      expect(found.map((c) => c.code)).toEqual([CAT_A, CAT_B]);
      expect(found[0].title).toBe(`${PROBE} categoria alfa`);
    });

    it('search respeita o teto de 20 e casa por código', async () => {
      expect((await lookup.search(CAT_B)).map((c) => c.code)).toEqual([CAT_B]);
      expect((await lookup.search(PROBE, 1)).length).toBe(1);
    });

    it('isCategory e titlesByCode: stem de 4 caracteres sim; extension, subcódigo e ausente não', async () => {
      expect(await lookup.isCategory(CAT_A)).toBe(true);
      expect(await lookup.isCategory(CAT_EXTENSION)).toBe(false);
      expect(await lookup.isCategory(CAT_SUBCODE)).toBe(false);
      expect(await lookup.isCategory(CAT_UNKNOWN)).toBe(false);
      expect([...(await lookup.titlesByCode([CAT_A, CAT_B, CAT_UNKNOWN])).keys()]).toEqual([CAT_A, CAT_B]);
    });
  });

  describe('vínculo de objetivo', () => {
    it('add → list (com título e activityLinks 0) → duplicado → 409 nomeado', async () => {
      expect(await repo.addObjectiveCategory(objectiveId, CAT_A, ACTOR)).toEqual({ code: CAT_A, title: `${PROBE} categoria alfa` });
      await expect(repo.addObjectiveCategory(objectiveId, CAT_A, ACTOR)).rejects.toBeInstanceOf(IcdCategoryAlreadyLinkedError);
      expect(await repo.listObjectiveCategories(objectiveId)).toEqual({
        total: 1,
        items: [{ code: CAT_A, title: `${PROBE} categoria alfa`, activityLinks: 0 }],
      });
    });

    it('código que não é categoria do release corrente → icd_category_invalid; objetivo inexistente → erro nomeado', async () => {
      await expect(repo.addObjectiveCategory(objectiveId, CAT_UNKNOWN, ACTOR)).rejects.toBeInstanceOf(InvalidIcdCategoryCodeError);
      await expect(repo.addObjectiveCategory(objectiveId, CAT_EXTENSION, ACTOR)).rejects.toBeInstanceOf(InvalidIcdCategoryCodeError);
      await expect(repo.addObjectiveCategory(objectiveId, 'ab', ACTOR)).rejects.toBeInstanceOf(InvalidIcdCategoryCodeError);
      await expect(
        repo.addObjectiveCategory('00000000-0000-4000-8000-000000000207', CAT_A, ACTOR),
      ).rejects.toBeInstanceOf(CatalogLinkOwnerNotFoundError);
    });

    it('título nulo quando o código do vínculo não existe mais no release corrente', async () => {
      await pool.query(
        `INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, created_by) VALUES ($1, $2, $3)`,
        [otherObjectiveId, CAT_UNKNOWN, ACTOR],
      );
      expect((await repo.listObjectiveCategories(otherObjectiveId)).items).toEqual([{ code: CAT_UNKNOWN, title: null, activityLinks: 0 }]);
      await repo.removeObjectiveCategory(otherObjectiveId, CAT_UNKNOWN);
    });
  });

  describe('vínculo de atividade (DD-2)', () => {
    it('add dentro das categorias do objetivo → list → duplicado → 409 nomeado', async () => {
      expect(await repo.addActivityCategory(activityId, CAT_A, ACTOR)).toEqual({ code: CAT_A, title: `${PROBE} categoria alfa` });
      await expect(repo.addActivityCategory(activityId, CAT_A, ACTOR)).rejects.toBeInstanceOf(IcdCategoryAlreadyLinkedError);
      expect(await repo.listActivityCategories(activityId)).toEqual({
        total: 1,
        items: [{ code: CAT_A, title: `${PROBE} categoria alfa` }],
      });
      // o objective_id do vínculo veio da atividade, nunca de parâmetro
      expect(await count(
        `SELECT count(*) AS n FROM therapeutic_activity_icd_categories WHERE activity_id = $1 AND objective_id = $2`,
        [activityId, objectiveId],
      )).toBe(1);
    });

    it('categoria fora das categorias do objetivo → icd_category_not_in_objective (23503, DD-23)', async () => {
      await expect(repo.addActivityCategory(activityId, CAT_B, ACTOR)).rejects.toBeInstanceOf(IcdCategoryNotInObjectiveError);
      await expect(repo.addActivityCategory(otherActivityId, CAT_A, ACTOR)).rejects.toBeInstanceOf(IcdCategoryNotInObjectiveError);
      expect((await repo.listActivityCategories(activityId)).total).toBe(1);
    });

    it('atividade inexistente → erro nomeado', async () => {
      await expect(
        repo.addActivityCategory('00000000-0000-4000-8000-000000000208', CAT_A, ACTOR),
      ).rejects.toBeInstanceOf(CatalogLinkOwnerNotFoundError);
    });

    it('remove a linha (DD-16) e devolve removed true; segunda vez false', async () => {
      await repo.addActivityCategory(activity2Id, CAT_A, ACTOR);
      expect(await repo.removeActivityCategory(activity2Id, CAT_A)).toEqual({ removed: true });
      expect(await repo.removeActivityCategory(activity2Id, CAT_A)).toEqual({ removed: false });
      expect((await repo.listActivityCategories(activity2Id)).total).toBe(0);
    });
  });

  describe('remover categoria do objetivo (DD-23)', () => {
    it('devolve removedActivityLinks contado no banco e relê 0 vínculos restantes', async () => {
      await repo.addObjectiveCategory(objectiveId, CAT_B, ACTOR);
      await repo.addActivityCategory(activity2Id, CAT_A, ACTOR);
      await repo.addActivityCategory(activity2Id, CAT_B, ACTOR);
      expect((await repo.listObjectiveCategories(objectiveId)).items.map((i) => [i.code, i.activityLinks])).toEqual([
        [CAT_A, 2],
        [CAT_B, 1],
      ]);

      expect(await repo.removeObjectiveCategory(objectiveId, CAT_A)).toEqual({ removedActivityLinks: 2 });

      const restantes = await count(
        `SELECT count(*) AS n FROM therapeutic_activity_icd_categories WHERE objective_id = $1 AND category_code = $2`,
        [objectiveId, CAT_A],
      );
      expect(restantes).toBe(0);
      expect((await repo.listObjectiveCategories(objectiveId)).items.map((i) => i.code)).toEqual([CAT_B]);
      // a outra categoria do mesmo objetivo ficou intacta
      expect((await repo.listActivityCategories(activity2Id)).items.map((i) => i.code)).toEqual([CAT_B]);
    });

    it('categoria já ausente: removedActivityLinks 0', async () => {
      expect(await repo.removeObjectiveCategory(objectiveId, CAT_A)).toEqual({ removedActivityLinks: 0 });
    });
  });
});
