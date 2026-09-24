/**
 * parseCaseTitleReference — spec 027 Fase 6 (T063).
 *
 * Parser COMPARTILHADO dos 3 sítios que leem um título de projeto Talentum (ou
 * `data.name` do webhook) para extrair o caso e o ordinal de vaga:
 *   - SyncTalentumVacanciesUseCase.processProject
 *   - CreateJobPostingFromTalentumUseCase.execute
 *   - SyncTalentumWorkersUseCase.linkToCases (via extractCaseNumber)
 * Também reusado por GeminiVacancyParserHelpers (T065) para a extração de
 * `case_number` a partir do título Talentum.
 *
 * ⚠️ Por que existe: sem match, o código de origem cria uma vaga ÓRFÃ
 * (`VACANTE {n}`) desconectada do caso — sem erro, sem exceção, só um log
 * informativo. É o risco nº 1 da spec 027 Fase 6.
 *
 * Formatos aceitos (primeiro que casar vence):
 *   1. "CASO 729-5568"  → { caseNumber: 729,  ordinal: 5568 }  (legado)
 *   2. "CASO 230"       → { caseNumber: 230,  ordinal: null }  (nova vacante)
 *   3. "EN1234#01"      → { caseNumber: 1234, ordinal: 1 }     (novo, ClickUp nativo)
 *   4. "729#03"         → { caseNumber: 729,  ordinal: 3 }     (novo, caso legado)
 *   sem match           → { caseNumber: null, ordinal: null }
 *
 * ⚠️ CORRIGIDO (rodada de fecho do gate, pós-T063): o comentário antigo afirmava que
 * "EN1234#01" era "o formato que a EXIBIÇÃO da app usa desde a T062". **Isso é falso,
 * medido**: `grep -rn formatCaseOrdinal` dá **0 chamadores de produção** em
 * `worker-functions/src` e em `enlite-frontend/src` — só a própria definição em
 * `caseNumberFormat.ts`. A exibição real usa só `formatCaseNumber` (ex.: `EN1234`,
 * sem sufixo `#NN`); nenhuma tela mostra o formato `#NN`, então staff não o vê para
 * digitar de volta no Talentum. O formato "EN1234#01"/"729#03" aqui é só a forma que
 * ESTE parser sabe interpretar caso apareça — não uma garantia de que é o que o
 * staff digita.
 *
 * ⚠️ Dígitos "soltos" (sem "CASO"/"EN") só contam como referência de caso quando (a)
 * vêm com o separador `-`/`#`, **e** (b) o número está ANCORADO NO INÍCIO do título
 * (`BARE_PATTERN`). Sem a âncora, texto livre com número no meio — "Turno 8-14",
 * "Cuidador 2026-09" — casava como se fosse referência de caso (`caseNumber=8`/`2026`)
 * e vinculava o worker ao caso errado, sem erro nem log: o próprio código mede que
 * ~68% dos títulos do Talentum são texto livre (`ProcessTalentumPrescreening.ts:196-200`,
 * 400 de 590 não batem "CASO N"). Título que não casar com segurança devolve
 * `{null, null}` — nunca um palpite.
 *
 * ⚠️ O segundo número tem DOIS significados diferentes conforme o formato:
 *   - no formato legado "CASO N-M", M é `vacancy_number` (sequence global, migration 114);
 *   - no formato novo "EN N#M" / "N#M", M é `case_ordinal` (posição do caso, migration 460).
 *   Este parser NÃO tenta reconciliar os dois — devolve o valor cru em `ordinal` e
 *   quem chama decide o uso (os 3 sítios já toleram mismatch via fallback por case_number).
 */

export interface ParsedCaseTitleReference {
  caseNumber: number | null;
  ordinal: number | null;
}

const CASO_PATTERN = /CASO\s+(\d+)(?:-(\d+))?/i;
const EN_PATTERN = /\bEN(\d+)(?:[-#](\d+))?/i;
const BARE_PATTERN = /^\s*(\d+)[-#](\d+)\b/;

export function parseCaseTitleReference(title: string): ParsedCaseTitleReference {
  if (!title) return { caseNumber: null, ordinal: null };

  const casoMatch = title.match(CASO_PATTERN);
  if (casoMatch) {
    return {
      caseNumber: parseInt(casoMatch[1], 10),
      ordinal: casoMatch[2] != null ? parseInt(casoMatch[2], 10) : null,
    };
  }

  const enMatch = title.match(EN_PATTERN);
  if (enMatch) {
    return {
      caseNumber: parseInt(enMatch[1], 10),
      ordinal: enMatch[2] != null ? parseInt(enMatch[2], 10) : null,
    };
  }

  const bareMatch = title.match(BARE_PATTERN);
  if (bareMatch) {
    return {
      caseNumber: parseInt(bareMatch[1], 10),
      ordinal: parseInt(bareMatch[2], 10),
    };
  }

  return { caseNumber: null, ordinal: null };
}
