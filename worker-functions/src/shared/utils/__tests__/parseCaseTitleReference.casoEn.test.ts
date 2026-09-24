import { parseCaseTitleReference } from '../parseCaseTitleReference';

/**
 * spec `028-caso-en-em-todo-lugar`, passo 3.1 — Livro de Suposições SUP-1.
 *
 * Decisão do Gabriel: título de vacante e todo rótulo "CASO {n}" passam a usar
 * o número FORMATADO — "CASO EN1041-5597" pra caso nativo (>= 1000), "CASO
 * 828-5597" legado.
 *
 * Shape real do retorno é { caseNumber, ordinal } (não { caseNumber, vacancyNumber }
 * — não existe campo `vacancyNumber` no parser). SUP-1: no ramo legado "CASO N-M"
 * (via CASO_PATTERN), M já preenche `ordinal` com o `vacancy_number` (mig 114) — é
 * o mesmo `-{m}` que `formatCaseTitle` grava no título. O ramo NOVO "CASO EN N-M"
 * (via CASO_EN_PATTERN, adicionado nesta task) segue a MESMA convenção: `ordinal`
 * aqui também carrega o `vacancy_number`, não o `case_ordinal` (mig 460) — que só
 * é o significado de `ordinal` no formato SEM "CASO" na frente ("EN N#M" / "N#M",
 * via EN_PATTERN/BARE_PATTERN, testados em `parseCaseTitleReference.test.ts`).
 *
 * F0 (medição, 24/09/2026) mediu que os 5 casos abaixo já PASSAVAM antes desta
 * task — mas por ACIDENTE de fallback no EN_PATTERN genérico (que não tem ramo
 * próprio para "CASO EN", e cujo campo `ordinal` documenta case_ordinal, não
 * vacancy_number). Esta rodada troca o parser para um ramo `CASO_EN_PATTERN`
 * explícito, tentado ANTES do EN_PATTERN — o valor numérico devolvido não muda
 * (por isso os asserts abaixo continuam os mesmos da F0), mas a ROTA e o RÓTULO
 * semântico do campo mudam: de "acidente via EN_PATTERN/case_ordinal" para
 * "ramo dedicado/vacancy_number". A prova de que a rota mudou é indireta (não há
 * como testar "qual branch casou" só pelo valor de retorno) — fica documentada
 * aqui e no comentário do arquivo de produção.
 */
describe('parseCaseTitleReference — formato "CASO EN…" (spec 028, ramo CASO_EN_PATTERN)', () => {
  it('CASO EN1041-5597 → ramo CASO EN dedicado; ordinal carrega vacancy_number (SUP-1)', () => {
    expect(parseCaseTitleReference('CASO EN1041-5597')).toEqual({
      caseNumber: 1041,
      ordinal: 5597,
    });
  });

  it('CASO EN1041 (sem segundo número) → ordinal null', () => {
    expect(parseCaseTitleReference('CASO EN1041')).toEqual({
      caseNumber: 1041,
      ordinal: null,
    });
  });

  it('CASO 828-5597 (legado, < 1000) continua no CASO_PATTERN — ordinal já era vacancy_number, sem mudança', () => {
    expect(parseCaseTitleReference('CASO 828-5597')).toEqual({
      caseNumber: 828,
      ordinal: 5597,
    });
  });

  it('caso en1041-5597 (minúsculo) — parser já é case-insensitive', () => {
    expect(parseCaseTitleReference('caso en1041-5597')).toEqual({
      caseNumber: 1041,
      ordinal: 5597,
    });
  });

  it('CASO EN1041-5597 com texto extra ao redor (título completo do Talentum)', () => {
    expect(parseCaseTitleReference('CASO EN1041-5597 - AT Recoleta')).toEqual({
      caseNumber: 1041,
      ordinal: 5597,
    });
  });
});
