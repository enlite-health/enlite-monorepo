import { fromPgError, overlapMessage, ItineraryOverlapError, type ItineraryOverlapSide } from '../itineraryOverlap';

/**
 * itineraryOverlap — P5, DX-11.7. `DETAIL_VALIDO` é o corpo que a trava do banco (DX-11.3) grava
 * no `23P01`; o `minGapMinutes` do fixture (45) é DIFERENTE da folga real (60, `itinerary_min_gap_minutes()`)
 * de propósito — prova que `overlapMessage` lê o valor do `DETAIL`, nunca de constante (DX-11.4).
 */
const DETAIL_VALIDO = {
  existingServiceId: 'svc-existente',
  existingWeekday: 1,
  existingStart: '08:00',
  existingEnd: '12:00',
  requestedServiceId: 'svc-solicitado',
  requestedWeekday: 1,
  requestedStart: '11:30',
  requestedEnd: '15:00',
  sameAddress: false,
  minGapMinutes: 45,
};

describe('fromPgError', () => {
  it('23P01 + itinerary_overlap + DETAIL legível → o erro com os dois horários e sameAddress', () => {
    const err = fromPgError({ code: '23P01', message: 'itinerary_overlap', detail: JSON.stringify(DETAIL_VALIDO) });

    expect(err).not.toBeNull();
    expect(err!.existing).toEqual({ serviceId: 'svc-existente', weekday: 1, startTime: '08:00', endTime: '12:00' });
    expect(err!.requested).toEqual({ serviceId: 'svc-solicitado', weekday: 1, startTime: '11:30', endTime: '15:00' });
    expect(err!.sameAddress).toBe(false);
    expect(err!.minGapMinutes).toBe(45);
  });

  it('outro código (não 23P01) → null', () => {
    const err = fromPgError({ code: '23505', message: 'itinerary_overlap', detail: JSON.stringify(DETAIL_VALIDO) });
    expect(err).toBeNull();
  });

  it('23P01 com outra mensagem → null', () => {
    const err = fromPgError({ code: '23P01', message: 'outra_excecao', detail: JSON.stringify(DETAIL_VALIDO) });
    expect(err).toBeNull();
  });

  it('DETAIL que não é JSON → null (o erro original do Postgres segue, sem relançar aqui)', () => {
    const err = fromPgError({ code: '23P01', message: 'itinerary_overlap', detail: 'isto não é JSON' });
    expect(err).toBeNull();
  });

  it('sem DETAIL nenhum → null', () => {
    const err = fromPgError({ code: '23P01', message: 'itinerary_overlap' });
    expect(err).toBeNull();
  });
});

describe('overlapMessage', () => {
  const existente: ItineraryOverlapSide = { serviceId: 'svc-existente', weekday: 1, startTime: '08:00', endTime: '12:00' };
  const solicitado: ItineraryOverlapSide = { serviceId: 'svc-solicitado', weekday: 1, startTime: '11:30', endTime: '15:00' };

  it('minGapMinutes null (mesmo endereço) → contém os dois horários e NÃO contém "folga"', () => {
    const err = new ItineraryOverlapError(existente, solicitado, true, null);
    const msg = overlapMessage(err);

    expect(msg).toContain('dia 1 08:00-12:00 (serviço svc-existente)');
    expect(msg).toContain('dia 1 11:30-15:00 (serviço svc-solicitado)');
    expect(msg).not.toContain('folga');
  });

  it('minGapMinutes com o valor do DETAIL (45, ≠ da folga real de 60) → mensagem cita "45", provando que vem do DETAIL', () => {
    const err = new ItineraryOverlapError(existente, solicitado, false, 45);
    const msg = overlapMessage(err);

    expect(msg).toContain('folga mínima de 45 min entre endereços');
    expect(msg).not.toContain('60');
  });
});

describe('sem PII no erro decodificado', () => {
  it('nenhuma chave de `existing`/`requested` casa /name|phone|email|address|diagnos|clinic/i — só serviceId/weekday/startTime/endTime cruzam a borda', () => {
    const err = fromPgError({ code: '23P01', message: 'itinerary_overlap', detail: JSON.stringify(DETAIL_VALIDO) })!;
    const regexPii = /name|phone|email|address|diagnos|clinic/i;

    // Escopo desta régua: as chaves dos dois lados do conflito (`existing`/`requested`), que são o
    // conteúdo MONTADO a partir do DETAIL arbitrário do banco — é aí que um campo PII poderia vazar
    // por engano no futuro. `sameAddress`/`minGapMinutes`/`name` (de `Error`) são campos FIXOS,
    // nomeados pelo próprio contrato (DX-11.3/DX-11.7) — `sameAddress` é um booleano ("mesmo
    // endereço?", nunca um endereço real) que bate a régua só por conter a substring "address";
    // não é o vazamento que esta régua caça.
    for (const key of Object.keys(err.existing)) {
      expect(key).not.toMatch(regexPii);
    }
    for (const key of Object.keys(err.requested)) {
      expect(key).not.toMatch(regexPii);
    }
  });
});
