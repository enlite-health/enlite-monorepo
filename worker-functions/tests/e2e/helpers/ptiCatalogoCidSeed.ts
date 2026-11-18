/**
 * ptiCatalogoCidSeed — o que os e2e de API do PTI precisam para falar o formato POR DIAGNÓSTICO (spec 091, T221).
 *
 * Semeia, só com linhas sintéticas do próprio teste (nunca rede, nunca dado de paciente):
 *   · um release CID-11 de teste promovido como CORRENTE (o anterior volta no `restaurar`): 2 capítulos, 3 stems de 4
 *     caracteres (`tea`, `epi`, `vazio`), mais uma URI que NÃO existe na terminologia (`sumida`);
 *   · o catálogo do serviço `AT`: objetivos/atividades vinculados às categorias (`tea`, `epi`), um objetivo inativo e um
 *     de OUTRO serviço, ambos vinculados à categoria `tea` (a cascata tem de excluí-los);
 *   · (`semearVersaoPlana`) uma versão no FORMATO ANTIGO por SQL — lista plana, `diagnosis_plans` nulo — com o catálogo
 *     antigo INATIVO (CA-9: editar não pode reler o catálogo).
 * `limpar` apaga o catálogo pelo prefixo do rótulo; `restaurar` devolve o release anterior como corrente.
 */
import { Client, type Pool } from 'pg';

/** O serviço contratado dos e2e de PTI: tem catálogo semeado por este helper. */
export const SERVICO_CID = 'AT';

export const CAP06 = { code: '06', title: 'Trastornos mentales, del comportamiento y del neurodesarrollo' };
export const CAP08 = { code: '08', title: 'Enfermedades del sistema nervioso' };

export interface CatalogoCidOpts {
  /** `PT017` → release `PT017-FIX`, URIs `test://pt017/…`. */
  tag: string;
  /** 2 caracteres [0-9A-Z]: os stems viram `Z<sufixo>1/2/3` (4 caracteres, forma de categoria). */
  sufixo: string;
  /** Prefixo dos rótulos do catálogo semeado (a limpeza apaga por ele), ex.: `E2E 017 cid `. */
  prefixo: string;
}

export interface CatalogoCid {
  release: string;
  prefixo: string;
  uris: { tea: string; epi: string; vazio: string; semCategoria: string; sumida: string };
  categorias: { tea: string; epi: string; vazio: string };
  objetivos: { a: string; b: string; epi: string; inativo: string; outroServico: string };
  atividades: { a: string; b: string; epi: string };
  rotulos: { objetivoA: string; atividadeA: string };
  limpar(): Promise<void>;
  restaurar(): Promise<void>;
}


/** Chave do advisory lock que serializa quem promove um release CID de teste como corrente (`is_current` é GLOBAL no banco). */
const LOCK_RELEASE_CORRENTE = 9100221;

/**
 * Serializa, entre PROCESSOS jest que dividem o mesmo banco, os testes que promovem um release CID de teste como corrente.
 * Sem isso, duas execuções concorrentes (outro terminal/agente, ou rodada anterior ainda viva) trocam o `is_current` uma
 * debaixo da outra e a cascata devolve 422 em massa (T222). Conexão DEDICADA (fora do pool: `pool.end()` não trava) e
 * sessão-nível: se o processo morrer, o Postgres solta o lock. Devolve o `soltar` (idempotente). Espera no máximo 20 s e então
 * FALHA ALTO — nunca segue sem o lock. Dentro de uma execução serial (CI, `maxWorkers: 1`) o lock nunca espera.
 */
export async function travarReleaseCorrente(pool: Pool): Promise<() => Promise<void>> {
  const conn = new Client(pool.options);
  await conn.connect();
  try {
    await conn.query(`SET lock_timeout = '20s'`);
    await conn.query(`SELECT pg_advisory_lock($1)`, [LOCK_RELEASE_CORRENTE]);
  } catch (e) {
    await conn.end().catch(() => undefined);
    throw new Error(`release CID corrente ocupado por outra execução de e2e no mesmo banco (lock ${LOCK_RELEASE_CORRENTE}): ${(e as Error).message}`);
  }
  let solto = false;
  return async (): Promise<void> => {
    if (solto) return;
    solto = true;
    await conn.end().catch(() => undefined); // fechar a sessão solta o lock
  };
}

/** Apaga (vínculos, atividades, objetivos) tudo que o teste semeou com o prefixo de rótulo — sobra de rodada interrompida inclusa. */
export async function limparCatalogoPorPrefixo(pool: Pool, prefixo: string): Promise<void> {
  const objetivos = `(SELECT id FROM therapeutic_specific_objectives WHERE label LIKE '${prefixo}%')`;
  await pool.query(`DELETE FROM therapeutic_activity_icd_categories WHERE objective_id IN ${objetivos}`);
  await pool.query(`DELETE FROM therapeutic_objective_icd_categories WHERE objective_id IN ${objetivos}`);
  await pool.query(`DELETE FROM therapeutic_activities WHERE label LIKE '${prefixo}%' OR objective_id IN ${objetivos}`);
  await pool.query(`DELETE FROM therapeutic_specific_objectives WHERE label LIKE '${prefixo}%'`);
}

export async function semearCatalogoCid(pool: Pool, opts: CatalogoCidOpts): Promise<CatalogoCid> {
  const { tag, sufixo, prefixo } = opts;
  const release = `${tag}-FIX`;
  const base = `test://${tag.toLowerCase()}`;
  const categorias = { tea: `Z${sufixo}1`, epi: `Z${sufixo}2`, vazio: `Z${sufixo}3` };
  const uris = {
    tea: `${base}/tea`, epi: `${base}/epi`, vazio: `${base}/vazio`, semCategoria: `${base}/cap06`, sumida: `${base}/nao-existe`,
  };

  const limpar = (): Promise<void> => limparCatalogoPorPrefixo(pool, prefixo);

  let releaseAnterior: string | null = null;
  let soltarLock: () => Promise<void> = async () => undefined;
  const restaurar = async (): Promise<void> => {
    try { await restaurarRelease(); } finally { await soltarLock(); }
  };
  const restaurarRelease = async (): Promise<void> => {
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = $1`, [release]);
    if (releaseAnterior) {
      await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = $2 WHERE release = $1`, [releaseAnterior, `${tag}-restore`]);
    }
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [release]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [release]);
  };

  // Sobra de rodada interrompida: some antes de semear de novo (o corrente anterior volta antes de ser lido).
  soltarLock = await travarReleaseCorrente(pool);
  try {
    await limpar();
    await restaurarRelease();

  const entidades: Array<[string, string, string, string, string]> = [
    [uris.semCategoria, CAP06.code, CAP06.title, CAP06.code, 'chapter'],
    [`${base}/cap08`, CAP08.code, CAP08.title, CAP08.code, 'chapter'],
    [uris.tea, categorias.tea, 'Trastorno del espectro autista', CAP06.code, 'stem'],
    [uris.epi, categorias.epi, 'Epilepsia', CAP08.code, 'stem'],
    [uris.vazio, categorias.vazio, 'Categoria sin catalogo', CAP06.code, 'stem'],
  ];
  await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, $2) ON CONFLICT (release) DO NOTHING`, [release, entidades.length]);
  for (const [uri, code, title, chapter, kind] of entidades) {
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7) ON CONFLICT (icd_uri, release) DO NOTHING`,
      [uri, release, code, title, chapter, kind, kind === 'stem'],
    );
  }
  releaseAnterior = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current LIMIT 1`)).rows[0]?.release ?? null;
  await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`);
  await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = $2 WHERE release = $1`, [release, `${tag}-e2e`]);

  const outroServico = (await pool.query<{ code: string }>(`SELECT code FROM service_types WHERE code <> $1 ORDER BY code LIMIT 1`, [SERVICO_CID])).rows[0].code;
  const novoObjetivo = async (label: string, servico: string | null, ativo = true): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_specific_objectives (label, service_code, active, deactivated_at, created_by, updated_by)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN NULL ELSE NOW() END, $4, $4) RETURNING id`,
      [prefixo + label, servico, ativo, tag],
    )).rows[0].id;
  const novaAtividade = async (label: string, objetivo: string, frequencia: string | null): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_activities (label, objective_id, suggested_frequency, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [prefixo + label, objetivo, frequencia, tag],
    )).rows[0].id;
  const vincObjetivo = (objetivo: string, categoria: string) =>
    pool.query(`INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, created_by) VALUES ($1, $2, $3)`, [objetivo, categoria, tag]);
  const vincAtividade = (atividade: string, objetivo: string, categoria: string) =>
    pool.query(`INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ($1, $2, $3, $4)`, [atividade, objetivo, categoria, tag]);

  const objetivos = {
    a: await novoObjetivo('obj A', SERVICO_CID),
    b: await novoObjetivo('obj B', SERVICO_CID),
    epi: await novoObjetivo('obj epi', SERVICO_CID),
    inativo: await novoObjetivo('obj inativo', SERVICO_CID, false),
    outroServico: await novoObjetivo('obj outro servico', outroServico),
  };
  for (const id of [objetivos.a, objetivos.b, objetivos.inativo, objetivos.outroServico]) await vincObjetivo(id, categorias.tea);
  await vincObjetivo(objetivos.epi, categorias.epi);
  const atividades = {
    a: await novaAtividade('ativ A', objetivos.a, 'semanal'),
    b: await novaAtividade('ativ B', objetivos.b, null),
    epi: await novaAtividade('ativ epi', objetivos.epi, null),
  };
  await vincAtividade(atividades.a, objetivos.a, categorias.tea);
  await vincAtividade(atividades.b, objetivos.b, categorias.tea);
  await vincAtividade(atividades.epi, objetivos.epi, categorias.epi);

  return {
    release, prefixo, uris, categorias, objetivos, atividades,
    rotulos: { objetivoA: `${prefixo}obj A`, atividadeA: `${prefixo}ativ A` },
    limpar, restaurar,
  };
  } catch (e) {
    await soltarLock(); // falhou no meio da semeadura: o afterAll não tem `cat` para restaurar, então o lock não pode ficar preso
    throw e;
  }
}

/** Um bloco por diagnóstico, no formato do corpo (`diagnosisPlans`). */
export const bloco = (diagnosisUri: string, specificObjectiveIds: string[], activityIds: string[]) => ({ diagnosisUri, specificObjectiveIds, activityIds });

/** O plano mínimo válido: o diagnóstico `tea` com o objetivo A e a atividade A. */
export const planoTea = (c: CatalogoCid) => [bloco(c.uris.tea, [c.objetivos.a], [c.atividades.a])];

export interface VersaoPlanaSemeada {
  versionId: string;
  objetivo: { id: string; label: string };
  atividade: { id: string; label: string };
  segment: { id: string; label: string };
}

/**
 * Versão no FORMATO ANTIGO (lista plana, `segment` congelado, `diagnosis_plans` nulo) inserida por SQL — o catálogo antigo
 * fica INATIVO (sem dono, como a 586 deixou o seed 415). Molde: `patient-therapeutic-projects-db.e2e` (`insertVersion`).
 */
export async function semearVersaoPlana(
  pool: Pool,
  p: { patientId: string; serviceId: string; diagnoses: unknown; prefixo: string; autor: string; major?: number },
): Promise<VersaoPlanaSemeada> {
  const inativo = async (tabela: 'therapeutic_specific_objectives' | 'therapeutic_activities', label: string): Promise<{ id: string; label: string }> => ({
    id: (await pool.query<{ id: string }>(
      `INSERT INTO ${tabela} (label, active, deactivated_at, created_by, updated_by) VALUES ($1, false, NOW(), 'e2e', 'e2e') RETURNING id`,
      [label],
    )).rows[0].id,
    label,
  });
  const objetivo = await inativo('therapeutic_specific_objectives', `${p.prefixo}antigo obj`);
  const atividade = await inativo('therapeutic_activities', `${p.prefixo}antigo ativ`);
  const segment = { id: '11111111-1111-4111-8111-111111111111', label: 'Segmento antigo sintetico' };
  const row = await pool.query<{ id: string }>(
    `INSERT INTO patient_therapeutic_projects
       (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context, general_objective,
        specific_objectives, activities, pathology_types, segment, start_date, end_date, created_by)
     VALUES ($1, $2, 0, $3, 'IN_PERSON', $4, 'Sintese sintetica e2e antiga.', 'Objetivo general sintético e2e.',
             $5, $6, $9, $7, '2026-09-01', '2026-12-31', $8) RETURNING id`,
    [p.patientId, p.major ?? 1, p.serviceId, JSON.stringify(p.diagnoses), JSON.stringify([objetivo]), JSON.stringify([atividade]), JSON.stringify(segment), p.autor, JSON.stringify([{ id: CAP06.code, label: CAP06.title }])],
  );
  return { versionId: row.rows[0].id, objetivo, atividade, segment };
}
