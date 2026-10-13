/**
 * Fuso da LISTA de eventos (spec 052, T-32): data e hora de cada linha saem no fuso do PAÍS DO EVENTO, não no de Buenos Aires
 * por omissão. AR e BR têm o MESMO deslocamento hoje (-03), então um teste com fusos reais passaria por coincidência: aqui o
 * mapa país → fuso é trocado por fusos de deslocamentos distintos, e a linha de um evento BR tem de sair no fuso do BR.
 * Sabotagem: voltar a linha para `timeZoneForCountry(null)` deixa a hora do evento BR no fuso de AR e o teste reprova.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '@infrastructure/i18n/config';
import type { EnquadreEventListItem } from '@domain/entities/EnquadreEvent';
import { EnquadreEventsTable } from '../EnquadreEventsTable';

vi.mock('@presentation/utils/countryTimeZone', () => ({
  COUNTRY_TIME_ZONE: { AR: 'Etc/GMT+3', BR: 'Etc/GMT-5', UY: 'Etc/GMT+3' },
}));

const base: EnquadreEventListItem = {
  id: 'ev-ar',
  startsAt: '2026-10-16T17:00:00.000Z',
  endsAt: '2026-10-16T18:00:00.000Z',
  hostName: 'Entrevistadora Ficticia',
  country: 'AR',
  phase: 'scheduled',
  convokedCount: 2,
  markedCount: 0,
  outcome: { selected: 0, quickResponse: 0, rejected: 0, returned: 0 },
  meetLink: null,
  pipeline: null,
};

beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => cleanup());

describe('lista de eventos: fuso por país do evento', () => {
  it('o mesmo instante sai 14:00 no evento AR (-03) e 22:00 no evento BR (+05 no mapa trocado)', () => {
    const events: EnquadreEventListItem[] = [base, { ...base, id: 'ev-br', country: 'BR' }];
    render(<EnquadreEventsTable events={events} now={new Date('2026-10-01T12:00:00.000Z')} onSelect={() => undefined} />);
    expect(screen.getByTestId('enquadre-event-time-ev-ar').textContent).toBe('14:00');
    expect(screen.getByTestId('enquadre-event-time-ev-br').textContent).toBe('22:00');
    expect(screen.getByTestId('enquadre-event-date-ev-br').textContent).toBe('16/10');
  });
});
