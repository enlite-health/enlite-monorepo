/**
 * admissionTime — fuso do país do PACIENTE (spec 049, F7).
 *
 * ⚠️ AR, BR e UY têm hoje o mesmo offset (-03) e a máquina de dev roda em São Paulo: formatar "no fuso certo" e
 * "no fuso do navegador" imprimem a MESMA hora. Por isso estes testes NÃO afirmam a saída de AR/BR e sim o MECANISMO:
 * (1) o fuso passado pelo chamador manda (Asia/Tokyo, que nunca coincide com o do host) e (2) o `timeZone`
 * entregue ao `Intl` é o do país. A sanidade abaixo falha alto se a régua (Tokyo ≠ host) deixar de funcionar.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatSlotIn,
  formatTimeIn,
  isFuture,
  slotProblem,
  timeZoneForCountry,
  toWallClock,
  wallClockIn,
  wallClockNow,
} from '../admissionTime';

const INSTANT = '2026-10-13T15:00:00.000Z'; // 15:00 UTC

afterEach(() => { vi.restoreAllMocks(); });

describe('fuso explícito (não coincide com o do host)', () => {
  it('sanidade da régua: Tokyo imprime outra hora que o host (se isto falhar, os testes abaixo não provam nada)', () => {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(wallClockIn(INSTANT, 'Asia/Tokyo')).not.toBe(wallClockIn(INSTANT, host));
  });

  it('wallClockIn respeita o fuso passado: 15:00Z = 00:00 do dia 14 em Tokyo', () => {
    expect(wallClockIn(INSTANT, 'Asia/Tokyo')).toBe('2026-10-14T00:00');
    expect(wallClockIn(INSTANT, 'UTC')).toBe('2026-10-13T15:00');
  });

  it('formatSlotIn / formatTimeIn respeitam o fuso passado, ES e PT', () => {
    expect(formatSlotIn(INSTANT, 'Asia/Tokyo', 'es')).toBe('14 de oct. 00:00');
    expect(formatSlotIn(INSTANT, 'Asia/Tokyo', 'pt-BR')).toBe('14 de out. 00:00');
    expect(formatTimeIn(INSTANT, 'UTC')).toBe('15:00');
  });

  it('entrega ao Intl o timeZone do PAÍS, não o do navegador (AR e BR)', () => {
    const Real = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      return new Real(locales, options);
    } as unknown as typeof Intl.DateTimeFormat);
    formatTimeIn(INSTANT, timeZoneForCountry('BR'));
    formatTimeIn(INSTANT, timeZoneForCountry('AR'));
    const zones = spy.mock.calls.map((c) => (c[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone);
    expect(zones).toEqual(['America/Sao_Paulo', 'America/Argentina/Buenos_Aires']);
  });

  it('país → fuso: AR e BR distintos, desconhecido/nulo cai em Buenos Aires (nunca no do navegador)', () => {
    expect(timeZoneForCountry('AR')).toBe('America/Argentina/Buenos_Aires');
    expect(timeZoneForCountry('BR')).toBe('America/Sao_Paulo');
    expect(timeZoneForCountry('XX')).toBe('America/Argentina/Buenos_Aires');
    expect(timeZoneForCountry(null)).toBe('America/Argentina/Buenos_Aires');
  });

  it('data inválida não lança: devolve null / o texto cru', () => {
    expect(wallClockIn('lixo', 'UTC')).toBeNull();
    expect(formatSlotIn('lixo', 'UTC', 'es')).toBe('lixo');
    expect(formatTimeIn('lixo', 'UTC')).toBe('lixo');
  });
});

describe('hora de parede e janela do painel', () => {
  const now = new Date('2026-10-12T15:00:00.000Z'); // em Tokyo: 13/10 00:00

  it('toWallClock junta data e hora sem fuso e rejeita incompleto', () => {
    expect(toWallClock('2026-10-14', '09:30')).toBe('2026-10-14T09:30');
    expect(toWallClock('', '09:30')).toBeNull();
    expect(toWallClock('2026-10-14', '9:3')).toBeNull();
  });

  it('wallClockNow usa o fuso: o "agora" de Tokyo é o dia seguinte', () => {
    expect(wallClockNow('Asia/Tokyo', now)).toBe('2026-10-13T00:00');
    expect(wallClockNow('UTC', now)).toBe('2026-10-12T15:00');
  });

  it('"passado" é medido no relógio do fuso do país, não no do navegador', () => {
    // 13/10 08:00 já passou em Tokyo? Agora lá são 13/10 00:00 → ainda é futuro.
    expect(slotProblem('2026-10-13', '08:00', 'Asia/Tokyo', now)).toBeNull();
    // Em UTC (agora 12/10 15:00) o mesmo "13/10 08:00" também é futuro; já "12/10 09:00" é passado em UTC e futuro em Tokyo.
    expect(slotProblem('2026-10-12', '09:00', 'UTC', now)).toBe('in_past');
    expect(slotProblem('2026-10-12', '09:00', 'Asia/Tokyo', now)).toBe('in_past');
    expect(slotProblem('2026-10-13', '00:30', 'Asia/Tokyo', now)).toBe('outside_window');
  });

  it('janela 8h-22h: início de 08:00 a 21:00 (a reunião dura 60 min e termina até as 22:00)', () => {
    expect(slotProblem('2026-12-01', '07:45', 'UTC', now)).toBe('outside_window');
    expect(slotProblem('2026-12-01', '08:00', 'UTC', now)).toBeNull();
    expect(slotProblem('2026-12-01', '21:00', 'UTC', now)).toBeNull();
    expect(slotProblem('2026-12-01', '21:15', 'UTC', now)).toBe('outside_window');
    expect(slotProblem('', '', 'UTC', now)).toBe('incomplete');
  });

  it('isFuture compara o INSTANTE de término', () => {
    expect(isFuture('2026-10-12T15:00:01.000Z', now)).toBe(true);
    expect(isFuture('2026-10-12T15:00:00.000Z', now)).toBe(false);
    expect(isFuture('lixo', now)).toBe(false);
  });
});
