import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWeekNavigation } from './useWeekNavigation';

describe('useWeekNavigation (spec 037)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00-03:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abre em HOJE quando o mês da página é o corrente; senão no dia 1 do mês', () => {
    expect(renderHook(() => useWeekNavigation('2026-10')).result.current.selectedDate).toBe('2026-10-01');
    expect(renderHook(() => useWeekNavigation('2026-09')).result.current.selectedDate).toBe('2026-09-01');
  });

  it('semana = segunda a domingo da data; meses = os dos 7 dias (28/09–04/10 cruza meses)', () => {
    const { result } = renderHook(() => useWeekNavigation('2026-10'));
    expect(result.current.weekStart).toBe('2026-09-28');
    expect(result.current.weekEnd).toBe('2026-10-04');
    expect(result.current.months).toEqual(['2026-09', '2026-10']);
  });

  it('goNext/goPrev movem a data 7 dias e avisam onMonthChange SÓ quando o mês da data muda', () => {
    const onMonthChange = vi.fn();
    const { result } = renderHook(() => useWeekNavigation('2026-09', onMonthChange));
    act(() => result.current.goNext()); // 09-08
    expect(result.current.selectedDate).toBe('2026-09-08');
    expect(onMonthChange).not.toHaveBeenCalled();
    act(() => result.current.selectDate('2026-09-28'));
    act(() => result.current.goNext()); // 10-05
    expect(result.current.selectedDate).toBe('2026-10-05');
    expect(onMonthChange).toHaveBeenCalledTimes(1);
    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('limites: canPrev falso na semana do piso; canNext falso na última semana do mês corrente; selectDate prende ao intervalo', () => {
    const { result } = renderHook(() => useWeekNavigation('2026-08'));
    act(() => result.current.selectDate('2026-08-03'));
    // 03/08 é segunda: a semana anterior (27/07–02/08) ainda tem 01/08 e 02/08 navegáveis.
    expect(result.current.canPrev).toBe(true);
    act(() => result.current.goPrev());
    expect(result.current.selectedDate).toBe('2026-08-01');
    expect(result.current.canPrev).toBe(false);
    expect(result.current.canNext).toBe(true);
    act(() => result.current.selectDate('2026-12-01'));
    expect(result.current.selectedDate).toBe('2026-10-31');
    expect(result.current.canNext).toBe(false);
    act(() => result.current.selectDate('2026-01-01'));
    expect(result.current.selectedDate).toBe('2026-08-01');
    expect(result.current.minDate).toBe('2026-08-01');
    expect(result.current.maxDate).toBe('2026-10-31');
  });

  it('(h) month vindo DE FORA (link / voltar do navegador) reinicia a data', () => {
    const { result, rerender } = renderHook(({ month }) => useWeekNavigation(month), { initialProps: { month: '2026-10' } });
    expect(result.current.selectedDate).toBe('2026-10-01');
    rerender({ month: '2026-09' });
    expect(result.current.selectedDate).toBe('2026-09-01');
  });

  it('(h) month que chega por consequência da própria navegação NÃO reinicia a data (sem laço)', () => {
    const { result, rerender } = renderHook(({ month }) => useWeekNavigation(month), { initialProps: { month: '2026-09' } });
    act(() => result.current.selectDate('2026-10-02'));
    // a página-rota gravou ?month=2026-10 em resposta ao aviso — a data escolhida tem de sobreviver
    rerender({ month: '2026-10' });
    expect(result.current.selectedDate).toBe('2026-10-02');
  });

  describe('última semana do mês e primeira do piso são alcançáveis (canNext/canPrev perguntam pela semana vizinha)', () => {
    /** Avança até `canNext` ficar falso; devolve as segundas-feiras visitadas e a data final. */
    const avancarAteOFim = (month: string) => {
      const { result } = renderHook(() => useWeekNavigation(month));
      const segundas = [result.current.weekStart];
      for (let i = 0; i < 10 && result.current.canNext; i += 1) {
        act(() => result.current.goNext());
        segundas.push(result.current.weekStart);
      }
      return { result, segundas };
    };

    it('(a) hoje domingo 11/10/2026: chega à semana que começa em 26/10; canNext só é falso nela', () => {
      vi.setSystemTime(new Date(2026, 9, 11, 12, 0, 0));
      const { result, segundas } = avancarAteOFim('2026-10');
      expect(segundas).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
      expect(result.current.selectedDate).toBe('2026-10-31');
      expect(result.current.canNext).toBe(false);
    });

    it('(b) hoje terça 03/11/2026: chega à semana que começa em 30/11, com a data presa em 30/11', () => {
      vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
      const { result, segundas } = avancarAteOFim('2026-11');
      expect(segundas).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
      expect(result.current.selectedDate).toBe('2026-11-30');
      expect(result.current.canNext).toBe(false);
    });

    it('(c) controle: hoje sábado 10/10/2026 também chega à semana de 26/10', () => {
      vi.setSystemTime(new Date(2026, 9, 10, 12, 0, 0));
      const { result, segundas } = avancarAteOFim('2026-10');
      expect(segundas[segundas.length - 1]).toBe('2026-10-26');
      expect(result.current.canNext).toBe(false);
    });

    it('(d) piso (2026-08): a semana que contém 01/08 (27/07–02/08) é alcançável e dali canPrev é falso', () => {
      vi.setSystemTime(new Date(2026, 9, 11, 12, 0, 0));
      const { result } = renderHook(() => useWeekNavigation('2026-08'));
      act(() => result.current.selectDate('2026-08-09'));
      expect(result.current.canPrev).toBe(true);
      act(() => result.current.goPrev()); // 02/08
      act(() => result.current.goPrev()); // 01/08 (preso ao piso), semana de 27/07
      expect(result.current.selectedDate).toBe('2026-08-01');
      expect(result.current.weekStart).toBe('2026-07-27');
      expect(result.current.canPrev).toBe(false);
    });
  });
});
