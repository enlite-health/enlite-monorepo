/**
 * pti-cascata-091.ts — gestos de HUMANO do "Nuevo" em cascata do Projeto Terapêutico (spec 091, §9.8) e leitura do plano no banco,
 * compartilhados pelos specs de PTI. Régua humana (memória `e2e-humano-nao-e-fill`): click + `keyboard.type`, valor lido da TELA.
 * Terminologia sintética semeada sob o advisory lock do release corrente (`catalogo-cid-091-seed`).
 */
import { expect, type Page } from '@playwright/test';
import { runSQL } from './patient-detail-c-helper';
import { travarReleaseCorrente, semearRelease, restaurarRelease, type StemSintetico } from './catalogo-cid-091-seed';

/** Categoria CID presente na planilha 587 (6 objetivos AT e 6 CAREGIVER, conferida com `jq`) — o stem sintético dos specs usa este código. */
export const CATEGORIA_NA_PLANILHA = '2A00';
export const SERVICO_AT = 'Acompañante Terapéutico';
export const SERVICO_CUIDADOR = 'Cuidador';

export interface Item { id: string; label: string }
export interface Plano { objetivo: Item; atividade: Item }

/** Sem espaço nenhum: o PDF quebra linha em hífen/espaço, e o pdf-parse devolve a quebra como espaço. */
export const semEspaco = (s: string): string => s.replace(/\s+/g, '');

/**
 * Lock do release corrente + release sintético corrente com os `stems`. Devolve o encerramento (restaura o release anterior e solta o lock,
 * mesmo se a restauração falhar). Falha de semeadura solta o lock antes de propagar.
 */
export async function semearCatalogoSintetico(release: string, uriBase: string, stems: StemSintetico[]): Promise<() => void> {
  const soltar = await travarReleaseCorrente();
  let anterior = '';
  try {
    restaurarRelease(release, ''); // sobra de rodada interrompida (sem reativar nada)
    anterior = semearRelease(release, uriBase, stems);
  } catch (e) {
    soltar();
    throw e;
  }
  return () => {
    try {
      restaurarRelease(release, anterior);
    } finally {
      soltar();
    }
  };
}

/** Primeiro objetivo (ordem do vínculo, DD-4) da categoria para o serviço que tem ao menos uma atividade ligada, + essa atividade. */
export function primeiroPlano(servico: string, categoria: string = CATEGORIA_NA_PLANILHA): Plano {
  const lido = (sql: string): Item => {
    const [id, ...resto] = runSQL(sql).split('\n')[0].split('|');
    return { id, label: resto.join('|') };
  };
  const objetivo = lido(
    `SELECT o.id || '|' || o.label FROM therapeutic_objective_icd_categories l JOIN therapeutic_specific_objectives o ON o.id = l.objective_id ` +
      `WHERE o.active AND o.service_code = '${servico}' AND l.category_code = '${categoria}' ` +
      `AND EXISTS (SELECT 1 FROM therapeutic_activity_icd_categories a WHERE a.objective_id = o.id AND a.category_code = '${categoria}') ` +
      `ORDER BY l.sort_order NULLS LAST, lower(o.label) LIMIT 1`,
  );
  const atividade = lido(
    `SELECT t.id || '|' || t.label FROM therapeutic_activity_icd_categories l JOIN therapeutic_activities t ON t.id = l.activity_id ` +
      `WHERE t.active AND t.objective_id = '${objetivo.id}' AND l.category_code = '${categoria}' ORDER BY l.sort_order NULLS LAST, lower(t.label) LIMIT 1`,
  );
  expect(objetivo.id, 'controle de não-vacuidade: o plano veio do banco').toMatch(/^[0-9a-f-]{36}$/);
  return { objetivo, atividade };
}

/** Combobox do serviço: abre o gatilho e clica a opção pelo rótulo que a pessoa lê (traz "· N h/sem" depois do nome). */
export async function escolherServico(page: Page, servico: string): Promise<void> {
  const gatilho = page.getByTestId('tp-service');
  await gatilho.click();
  await page.getByRole('option', { name: new RegExp(`^${servico}`) }).click();
  await expect(gatilho).toContainText(servico);
}

/** Busca digitada → opção 0 (confere o título) → clique; a cascata responde 200 e o chip aparece. */
export async function escolherDiagnostico(page: Page, titulo: string, busca: string): Promise<void> {
  const resposta = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
  await page.getByTestId('tp-icd-input').click();
  await page.keyboard.type(busca);
  expect((await resposta).status()).toBe(200);
  const opcao = page.getByTestId('tp-icd-option-0');
  await expect(opcao).toContainText(titulo, { timeout: 10_000 });
  const cascata = page.waitForResponse((r) => r.request().method() === 'POST' && /therapeutic-catalogs\/cascade/.test(r.url()));
  await opcao.click();
  expect((await cascata).status()).toBe(200);
  await expect(page.getByTestId('tp-diagnosis-chip')).toHaveCount(1);
}

/** 099: o acordeão do diagnóstico `uri` precisa estar aberto antes de marcar (só o 1º nasce aberto): clica o cabeçalho se estiver fechado. */
export async function abrirBloco(page: Page, uri: string): Promise<void> {
  const cabecalho = page.getByTestId(`tp-block-toggle-${uri}`);
  if ((await cabecalho.getAttribute('aria-expanded')) !== 'true') await cabecalho.click();
  await expect(cabecalho).toHaveAttribute('aria-expanded', 'true');
}

/** 099: objetivo e atividade são cartões-botão (`aria-pressed`): o humano clica e a tela passa a marcar o botão como pressionado. */
export async function marcar(page: Page, testId: string): Promise<void> {
  const botao = page.getByTestId(testId);
  await botao.click();
  await expect(botao).toHaveAttribute('aria-pressed', 'true');
}

/** Paso 3 do bloco do diagnóstico `uri`: abre o acordeão, marca o objetivo e depois a atividade (que só aparece dentro do cartão marcado). */
export async function marcarPlano(page: Page, uri: string, plano: Plano): Promise<void> {
  await abrirBloco(page, uri);
  await marcar(page, `tp-obj-${uri}-${plano.objetivo.id}`);
  await marcar(page, `tp-act-${uri}-${plano.objetivo.id}-${plano.atividade.id}`);
}

/** Passos 1-3 do "Nuevo" já com o drawer aberto: serviço pelo rótulo, diagnóstico pela busca, e o plano do bloco marcado. */
export async function preencherCascata(page: Page, a: { servico: string; titulo: string; busca: string; uri: string; plano: Plano }): Promise<void> {
  await escolherServico(page, a.servico);
  await escolherDiagnostico(page, a.titulo, a.busca);
  await marcarPlano(page, a.uri, a.plano);
}

/** `diagnosisPlans` de uma versão `byDiagnosis` no banco, no formato do CORPO da API (ids por bloco) — o MACRO que a edição repete. */
export function diagnosisPlansDaVersao(versaoId: string): Array<{ diagnosisUri: string; specificObjectiveIds: string[]; activityIds: string[] }> {
  const json = runSQL(
    `SELECT jsonb_agg(jsonb_build_object('diagnosisUri', p->>'diagnosisUri', ` +
      `'specificObjectiveIds', (SELECT coalesce(jsonb_agg(o->>'id'), '[]'::jsonb) FROM jsonb_array_elements(p->'objectives') o), ` +
      `'activityIds', (SELECT coalesce(jsonb_agg(a->>'id'), '[]'::jsonb) FROM jsonb_array_elements(p->'activities') a))) ` +
      `FROM patient_therapeutic_projects, jsonb_array_elements(diagnosis_plans) p WHERE id = '${versaoId}'`,
  ).trim();
  expect(json, 'a versão tem diagnosis_plans (formato byDiagnosis)').not.toBe('');
  return JSON.parse(json);
}
