/**
 * TESTE DE CONTRATO — allowlist CONGELADA das listas literais de "status de vaga" em `src/` (estado-automatico-do-paciente, F2, D3;
 * allowlist encolhida na F4 do semaforo-da-vaga).
 *
 * Há DOIS donos: `matching/domain/vacancyLifecycle.ts` (o selo: rascunho/baja) e `matching/domain/vacancyPublication.ts` ("publicável":
 * feed, página pública, candidatura, short link, a Luz, o painel e a marcação do Talentum leem dele). A F4 re-apontou os leitores que
 * decidiam "vaga aberta" por lista própria (`PublicJobsQueryBuilder`, `FindNearbyVacanciesForWorkerUseCase`, `PublicVacancyController`,
 * `VacancyCrudController`, `propagateVacancyEditToTalentum`): saíram da allowlist e o teste abaixo EXIGE que
 * não tenham voltado. Sobram os que a LISTA do design mantém ("vaga viva" com 3 donos, painéis legados): congelados, sem novos.
 * Uma NOVA lista literal de status de vaga num arquivo fora da allowlist reprova.
 *
 * Detecção: grupo `[...]` ou `(...)` com ≥ 2 valores distintos do CHECK da vaga, ao menos 1 deles exclusivo de vaga (não existe como
 * estado de paciente). Testes (`__tests__`, `*.test.ts`) e os donos ficam de fora.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VACANCY_STATUS_VALUES } from '../domain/vacancyLifecycle';

const SRC = join(__dirname, '../../..');
const SO_DE_VAGA = ['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'CLOSED', 'DE_BAJA'];
const DONOS = ['modules/matching/domain/vacancyLifecycle.ts', 'modules/matching/domain/vacancyPublication.ts'];

/** O que sobrou da LISTA item 1 do design (migrar é change própria). */
const LISTA_ITEM_1 = [
  'modules/matching/domain/openJobStatuses.ts',
  'modules/case/application/AddressAvailabilityCalculator.ts',
];

/** Re-apontados para `vacancyPublication.ts` na F4: NÃO podem voltar a ter lista própria. */
const RE_APONTADOS_NA_F4 = [
  'modules/matching/infrastructure/PublicJobsQueryBuilder.ts',
  'modules/matching/application/FindNearbyVacanciesForWorkerUseCase.ts',
  'modules/matching/interfaces/controllers/PublicVacancyController.ts',
  'modules/matching/interfaces/controllers/VacancyCrudController.ts',
  'modules/matching/application/propagateVacancyEditToTalentum.ts',
];

/** Outros arquivos que JÁ tinham lista literal quando a F2 mediu (painéis, fusão, OpenAPI…): congelados também, sem justificar novos. */
const JA_EXISTENTES_FORA_DA_LISTA = [
  'infrastructure/repositories/ClickUpCaseRepository.ts',
  'modules/agentes/domain/assistantCountMenu.ts',
  'modules/case/application/FuseDraftIntoOfficialVacancyUseCase.ts',
  'modules/case/domain/VacancyLinkEligibility.ts',
  'modules/case/infrastructure/DraftFusionRepository.ts',
  'modules/case/infrastructure/PatientDetailQueryHelper.ts',
  'modules/matching/application/PromoteBlockedApplicationsUseCase.ts',
  'modules/matching/interfaces/controllers/VacanciesAuxController.ts',
  // tempo_medio_fechamento: semântica legada, fora do escopo (LISTA). Os contadores de "abertas" do mesmo arquivo leem o dono de publicável.
  'modules/matching/interfaces/controllers/VacanciesController.ts',
  'modules/matching/interfaces/controllers/vacancyListHelpers.ts',
  'modules/worker/interfaces/controllers/AdminWorkersAuxController.ts',
];

export const ALLOWLIST: readonly string[] = [...LISTA_ITEM_1, ...JA_EXISTENTES_FORA_DA_LISTA];

function arquivosDeFonte(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') arquivosDeFonte(p, acc);
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Existe um grupo `[...]`/`(...)` com a lista literal de status de vaga? */
export function temListaDeStatusDeVaga(fonte: string): boolean {
  for (const m of fonte.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g)) {
    const toks = [...(m[1] ?? m[2]).matchAll(/['"]([A-Z_]+)['"]/g)]
      .map((x) => x[1])
      .filter((t) => (VACANCY_STATUS_VALUES as readonly string[]).includes(t));
    if (new Set(toks).size >= 2 && toks.some((t) => SO_DE_VAGA.includes(t))) return true;
  }
  return false;
}

const comLista = arquivosDeFonte(SRC)
  .map((f) => relative(SRC, f))
  .filter((rel) => !DONOS.includes(rel))
  .filter((rel) => temListaDeStatusDeVaga(readFileSync(join(SRC, rel), 'utf8')))
  .sort();

describe('contrato: allowlist congelada das listas literais de status de vaga', () => {
  it('controle positivo: o detector acha a lista num arquivo conhecido e num texto plantado; ignora lista de outro domínio', () => {
    expect(temListaDeStatusDeVaga("const X = ['SEARCHING','CLOSED'];")).toBe(true);
    expect(temListaDeStatusDeVaga("WHERE status IN ('SEARCHING','SEARCHING_REPLACEMENT')")).toBe(true);
    expect(temListaDeStatusDeVaga("const P = ['ACTIVE','SUSPENDED'];")).toBe(false); // sem valor exclusivo de vaga
    expect(temListaDeStatusDeVaga("const so = ['CLOSED'];")).toBe(false); // 1 valor só não é lista
    for (const f of LISTA_ITEM_1) expect(comLista).toContain(f); // o instrumento TEM de enxergar os que sobraram
  });

  it('NENHUMA lista literal nova de status de vaga fora da allowlist (uma 8ª reprova)', () => {
    const novas = comLista.filter((f) => !ALLOWLIST.includes(f));
    expect(novas).toEqual([]);
  });

  it('allowlist sem entrada morta: quem deixou de ter lista sai daqui (a allowlist só encolhe)', () => {
    const mortas = ALLOWLIST.filter((f) => !comLista.includes(f));
    expect(mortas).toEqual([]);
  });

  it('os leitores re-apontados na F4 NÃO têm lista própria (leem de vacancyPublication.ts)', () => {
    for (const f of RE_APONTADOS_NA_F4) {
      expect(comLista).not.toContain(f);
      // `propagateVacancyEditToTalentum` perdeu o ramo de status: não lê o dono, só não tem lista. Os outros leem.
      if (!f.endsWith('propagateVacancyEditToTalentum.ts')) {
        expect(readFileSync(join(SRC, f), 'utf8')).toMatch(/vacancyPublication|vagaPublicavelSql|vacancyShortLinks/);
      }
    }
  });

  it('o dono do selo continua sendo o único lugar com a tabela completa dos 9 valores', () => {
    const dono = readFileSync(join(SRC, DONOS[0]), 'utf8');
    for (const v of VACANCY_STATUS_VALUES) expect(dono).toContain(`'${v}'`);
  });
});
