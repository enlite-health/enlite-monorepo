/**
 * TESTE DE CONTRATO — allowlist CONGELADA das listas literais de "status de vaga" em `src/` (estado-automatico-do-paciente, F2, D3).
 *
 * O dono do ciclo de vida é `matching/domain/vacancyLifecycle.ts`. Existem leitores que, ANTES desta change, decidiam "vaga aberta" por
 * lista própria — os 7 da LISTA item 1 de `proposal.md` (`PublicJobsQueryBuilder`, `openJobStatuses`, `FindNearbyVacanciesForWorkerUseCase`,
 * `propagateVacancyEditToTalentum`, `PublicVacancyController`, `VacancyCrudController`, `AddressAvailabilityCalculator`) e outros que a
 * varredura achou (painéis, fusão de rascunho…; a OpenAPI de vaga já saiu: lê `STATUS_GRAVAVEIS`). A D3 os tira do escopo; este teste CONGELA a lista: uma NOVA lista literal de
 * status de vaga num arquivo fora da allowlist reprova. Fechar o item é a change própria da LISTA (ler `cicloDeVidaDaVaga`).
 *
 * Detecção: grupo `[...]` ou `(...)` com ≥ 2 valores distintos do CHECK da vaga, ao menos 1 deles exclusivo de vaga (não existe como
 * estado de paciente). Testes (`__tests__`, `*.test.ts`) e o próprio dono ficam de fora.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VACANCY_STATUS_VALUES } from '../domain/vacancyLifecycle';

const SRC = join(__dirname, '../../..');
const SO_DE_VAGA = ['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'CLOSED', 'DE_BAJA'];
const DONO = 'modules/matching/domain/vacancyLifecycle.ts';

/** Os 7 da LISTA item 1 (decisão: ficam como estão — migrar é change própria). */
const LISTA_ITEM_1 = [
  'modules/matching/infrastructure/PublicJobsQueryBuilder.ts',
  'modules/matching/domain/openJobStatuses.ts',
  'modules/matching/application/FindNearbyVacanciesForWorkerUseCase.ts',
  'modules/matching/application/propagateVacancyEditToTalentum.ts',
  'modules/matching/interfaces/controllers/PublicVacancyController.ts',
  'modules/matching/interfaces/controllers/VacancyCrudController.ts',
  'modules/case/application/AddressAvailabilityCalculator.ts',
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
  .filter((rel) => rel !== DONO)
  .filter((rel) => temListaDeStatusDeVaga(readFileSync(join(SRC, rel), 'utf8')))
  .sort();

describe('contrato: allowlist congelada das listas literais de status de vaga', () => {
  it('controle positivo: o detector acha a lista num arquivo conhecido e num texto plantado; ignora lista de outro domínio', () => {
    expect(temListaDeStatusDeVaga("const X = ['SEARCHING','CLOSED'];")).toBe(true);
    expect(temListaDeStatusDeVaga("WHERE status IN ('SEARCHING','SEARCHING_REPLACEMENT')")).toBe(true);
    expect(temListaDeStatusDeVaga("const P = ['ACTIVE','SUSPENDED'];")).toBe(false); // sem valor exclusivo de vaga
    expect(temListaDeStatusDeVaga("const so = ['CLOSED'];")).toBe(false); // 1 valor só não é lista
    for (const f of LISTA_ITEM_1) expect(comLista).toContain(f); // o instrumento TEM de enxergar os 7
  });

  it('NENHUMA lista literal nova de status de vaga fora da allowlist (uma 8ª reprova)', () => {
    const novas = comLista.filter((f) => !ALLOWLIST.includes(f));
    expect(novas).toEqual([]);
  });

  it('allowlist sem entrada morta: quem deixou de ter lista sai daqui (a allowlist só encolhe)', () => {
    const mortas = ALLOWLIST.filter((f) => !comLista.includes(f));
    expect(mortas).toEqual([]);
  });

  it('o dono continua sendo o único lugar com a tabela completa dos 9 valores', () => {
    const dono = readFileSync(join(SRC, DONO), 'utf8');
    for (const v of VACANCY_STATUS_VALUES) expect(dono).toContain(`'${v}'`);
  });
});
