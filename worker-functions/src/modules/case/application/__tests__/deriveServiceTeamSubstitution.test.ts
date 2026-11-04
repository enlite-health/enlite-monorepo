/**
 * deriveServiceTeamSubstitution — Fase 13, DX-13.4, P10. Prova o critério 5 (o substituto volta a
 * Selecionado quando a data da substituição passa, EM QUALQUER FUSO) via `deriveServiceTeamFromRows`
 * com `now` FIXO — nunca `jest.useFakeTimers`/mock de `Date` (`now` é parâmetro, não relógio global)
 * e nunca `process.env.TZ` dentro do teste (o runner do CI decide o fuso externamente; a memória
 * `teste-de-fuso-passa-por-coincidencia` alerta que São Paulo === Buenos Aires em UTC-3 esconderia um
 * bug de "data local do PROCESSO" em vez de "data local do PAÍS" — por isso a asserção de SANIDADE
 * abaixo prova que o instante escolhido CRUZA a meia-noite entre a AR e o UTC/Tóquio).
 */
import { deriveServiceTeamFromRows } from '../serviceTeamPresentation';
import { operationDateOf } from '../itineraryCoverage';
import { SERVICE_TEAM_ENTRY_STAGE } from '../../domain/deriveServiceTeam';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';

const SERVICE_ID = 'service-1';
const LIVE_VACANCY_ID = 'vacancy-live';
const TITULAR_VACANCY_ID = 'vacancy-titular';
const SUBSTITUTE_DATE = '2026-10-05'; // segunda — D

/**
 * Titular alocado desde sempre (não sai por causa da ausência, invariante da Fase 13) + o
 * substituto candidato da vaga viva (para reaparecer em `selected` quando a data passar) +
 * a substituição em si, no dia `SUBSTITUTE_DATE`.
 */
function rowComSubstituicao(): ServiceTeamRows {
  return {
    serviceId: SERVICE_ID,
    country: 'AR',
    liveVacancyId: LIVE_VACANCY_ID,
    candidacies: [
      { workerId: 'w-substituto', vacancyId: LIVE_VACANCY_ID, stage: SERVICE_TEAM_ENTRY_STAGE, firstNameEncrypted: null, lastNameEncrypted: null },
    ],
    assignments: [
      {
        workerId: 'w-titular',
        serviceId: SERVICE_ID,
        vacancyId: TITULAR_VACANCY_ID,
        validFrom: '2026-01-01',
        validTo: null,
        status: 'ACTIVE',
        firstNameEncrypted: null,
        lastNameEncrypted: null,
      },
    ],
    marks: [],
    substitutions: [
      {
        workerId: 'w-substituto',
        serviceId: SERVICE_ID,
        vacancyId: LIVE_VACANCY_ID,
        date: SUBSTITUTE_DATE,
        firstNameEncrypted: null,
        lastNameEncrypted: null,
      },
    ],
  };
}

describe('deriveServiceTeamFromRows — quem substitui volta a Selecionado quando a data passa (DX-13.4, critério 5)', () => {
  it('hoje = D → Em Atendimento: quem substitui no dia certo fica em inService com a data, fora de selected; o titular também em inService', () => {
    const now1 = new Date('2026-10-06T02:30:00Z'); // BA (UTC-3) = segunda 05/10 23:30 local; UTC e Tóquio já em 06/10
    const row = rowComSubstituicao();

    const result = deriveServiceTeamFromRows(row, now1);

    expect(result.asOf).toBe(SUBSTITUTE_DATE);
    expect(result.inService).toEqual([
      { workerId: 'w-titular', vacancyId: TITULAR_VACANCY_ID },
      { workerId: 'w-substituto', vacancyId: LIVE_VACANCY_ID, substitutionDates: [SUBSTITUTE_DATE] },
    ]);
    expect(result.selected).toEqual([]);
  });

  it('hoje = D+1 → Selecionado: passada a data, quem substituiu volta a Selecionado por derivação (nenhuma escrita), fora de inService; o titular segue em inService', () => {
    const now2 = new Date('2026-10-06T12:00:00Z'); // BA (UTC-3) = terça 06/10 09:00 local
    const row = rowComSubstituicao();

    const result = deriveServiceTeamFromRows(row, now2);

    expect(result.asOf).toBe('2026-10-06');
    expect(result.selected).toEqual([{ workerId: 'w-substituto', vacancyId: LIVE_VACANCY_ID }]);
    expect(result.inService).toEqual([{ workerId: 'w-titular', vacancyId: TITULAR_VACANCY_ID }]);
  });

  /**
   * SANIDADE (memória `teste-de-fuso-passa-por-coincidencia`): prova que `now1` CRUZA a meia-noite
   * entre a data local em Buenos Aires e a data em UTC — se alguém trocar o instante por um que não
   * cruze, esta asserção falha ALTO, antes mesmo da sabotagem (P40) precisar rodar. Sem isso, um bug
   * "data local do PROCESSO" (em vez de "data local do PAÍS") passaria despercebido em qualquer fuso
   * que coincida com o de Buenos Aires (ex.: São Paulo, também UTC-3) — por isso o fuso do runner
   * nunca é fixado aqui dentro (a prova do passo roda `TZ=UTC` e `TZ=Asia/Tokyo` por fora).
   */
  it('sanidade: now1 cruza a meia-noite — AR ainda em 05/10, UTC já em 06/10 (protege o teste de quem substitui de coincidência de fuso)', () => {
    const now1 = new Date('2026-10-06T02:30:00Z');

    expect(operationDateOf('AR', now1)).toBe('2026-10-05');
    expect(now1.toISOString().slice(0, 10)).toBe('2026-10-06');
  });
});
