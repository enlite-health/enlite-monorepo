import { describe, it, expect } from 'vitest';
import {
  allShiftsOf,
  blockReason,
  filterPatients,
  isShiftSelectable,
  originCounts,
  patientDisplayName,
  pendingOriginBreakdown,
  pendingShiftsOf,
  providerDisplayName,
  providerPendingSelectionState,
  selectionSummary,
  shiftHours,
  totalHours,
  validationProgress,
} from './selectors';
import type { AnaCarePatient, AnaCareProvider, AnaCareShift } from './types';

function makeShift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 'shift-1',
    date: '2026-08-14',
    scheduledStart: '08:00',
    scheduledEnd: '16:00',
    actualStart: '08:00',
    actualEnd: '16:00',
    hoursActual: 8,
    hoursScheduled: 8,
    origin: 'app',
    status: 'pendiente',
    anaCareShiftId: '90101',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<AnaCareProvider> = {}): AnaCareProvider {
  return {
    anaCareId: '90200',
    name: 'Rocío García QA',
    shifts: [],
    ...overrides,
  };
}

function makePatient(overrides: Partial<AnaCarePatient> = {}): AnaCarePatient {
  return {
    anaCareId: '90000',
    providers: [],
    ...overrides,
  };
}

describe('shiftHours', () => {
  it('POSITIVO — usa hoursActual quando existe, independente do modo', () => {
    const shift = makeShift({ hoursActual: 7.5 });
    expect(shiftHours(shift)).toBe(7.5);
    expect(shiftHours(shift, 'scheduled')).toBe(7.5);
  });

  it("NEGATIVO — sin check-in (hoursActual null) no modo padrão ('zero') conta 0", () => {
    const shift = makeShift({ hoursActual: null, origin: 'sin_checkin', actualStart: null, actualEnd: null });
    expect(shiftHours(shift)).toBe(0);
  });

  it("sin check-in no modo 'scheduled' conta a hora prevista (decisão aberta, task 6)", () => {
    const shift = makeShift({ hoursActual: null, origin: 'sin_checkin', actualStart: null, actualEnd: null, hoursScheduled: 8 });
    expect(shiftHours(shift, 'scheduled')).toBe(8);
  });
});

describe('totalHours', () => {
  it('POSITIVO — soma horas de vários turnos', () => {
    const shifts = [makeShift({ hoursActual: 4 }), makeShift({ id: 's2', hoursActual: 6 })];
    expect(totalHours(shifts)).toBe(10);
  });

  it('NEGATIVO — lista vazia soma 0', () => {
    expect(totalHours([])).toBe(0);
  });
});

describe('validationProgress', () => {
  it('POSITIVO — conta validado/contestado/pendente e calcula percentual arredondado', () => {
    const shifts = [
      makeShift({ id: 's1', status: 'validado' }),
      makeShift({ id: 's2', status: 'validado' }),
      makeShift({ id: 's3', status: 'contestado' }),
      makeShift({ id: 's4', status: 'pendiente' }),
    ];
    const progress = validationProgress(shifts);
    expect(progress).toEqual({ total: 4, validated: 2, contested: 1, pending: 1, percentage: 50 });
  });

  it('NEGATIVO — mês sem turnos dá percentage 0 (não NaN)', () => {
    const progress = validationProgress([]);
    expect(progress.percentage).toBe(0);
    expect(progress.total).toBe(0);
  });
});

describe('originCounts', () => {
  it('POSITIVO — conta cada origem separadamente', () => {
    const shifts = [
      makeShift({ id: 's1', origin: 'sin_checkin' }),
      makeShift({ id: 's2', origin: 'sin_checkin' }),
      makeShift({ id: 's3', origin: 'web_admin' }),
      makeShift({ id: 's4', origin: 'app' }),
    ];
    expect(originCounts(shifts)).toEqual({ sinCheckin: 2, webAdmin: 1, app: 1 });
  });

  it('NEGATIVO — sem turnos de uma origem, a contagem fica 0 (não ausente)', () => {
    const shifts = [makeShift({ origin: 'app' })];
    expect(originCounts(shifts)).toEqual({ sinCheckin: 0, webAdmin: 0, app: 1 });
  });
});

describe('providerDisplayName', () => {
  it('POSITIVO — prestador com nome resolvido mostra o nome', () => {
    const provider = makeProvider({ name: 'Rocío García QA' });
    expect(providerDisplayName(provider)).toBe('Rocío García QA');
  });

  it('NEGATIVO — prestador sem nome resolvido mostra só o ID cru, NUNCA um rótulo negativo tipo "Sin vínculo" (decisão de 16/09)', () => {
    const provider = makeProvider({ name: undefined, anaCareId: '90512' });
    expect(providerDisplayName(provider)).toBe('90512');
  });
});

describe('patientDisplayName', () => {
  it('paciente NUNCA tem nome (reconciliação fora de escopo) — sempre o ID cru', () => {
    const patient = makePatient({ anaCareId: '90447' });
    expect(patientDisplayName(patient)).toBe('90447');
  });
});

describe('allShiftsOf', () => {
  it('POSITIVO — junta turnos de todos os prestadores do paciente', () => {
    const patient = makePatient({
      providers: [
        makeProvider({ anaCareId: 'p1', shifts: [makeShift({ id: 's1' })] }),
        makeProvider({ anaCareId: 'p2', shifts: [makeShift({ id: 's2' }), makeShift({ id: 's3' })] }),
      ],
    });
    expect(allShiftsOf(patient).map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('NEGATIVO — paciente sem prestadores dá lista vazia', () => {
    expect(allShiftsOf(makePatient({ providers: [] }))).toEqual([]);
  });
});

describe('pendingShiftsOf', () => {
  it('POSITIVO — filtra só os turnos pendentes do prestador', () => {
    const provider = makeProvider({
      shifts: [makeShift({ id: 's1', status: 'pendiente' }), makeShift({ id: 's2', status: 'validado' })],
    });
    expect(pendingShiftsOf(provider).map((s) => s.id)).toEqual(['s1']);
  });

  it('NEGATIVO — prestador 100% validado dá lista vazia de pendentes', () => {
    const provider = makeProvider({ shifts: [makeShift({ id: 's1', status: 'validado' })] });
    expect(pendingShiftsOf(provider)).toEqual([]);
  });
});

describe('pendingOriginBreakdown', () => {
  it('POSITIVO — conta sin_checkin e web_admin entre os turnos passados', () => {
    const shifts = [
      makeShift({ id: 's1', origin: 'sin_checkin' }),
      makeShift({ id: 's2', origin: 'web_admin' }),
      makeShift({ id: 's3', origin: 'app' }),
    ];
    expect(pendingOriginBreakdown(shifts)).toEqual({ sinCheckin: 1, webAdmin: 1 });
  });

  it('NEGATIVO — nenhum turno sin_checkin/web_admin dá zero nos dois', () => {
    expect(pendingOriginBreakdown([makeShift({ origin: 'app' })])).toEqual({ sinCheckin: 0, webAdmin: 0 });
  });
});

describe('isShiftSelectable', () => {
  it('POSITIVO — pendente e contestado são selecionáveis', () => {
    expect(isShiftSelectable(makeShift({ status: 'pendiente' }))).toBe(true);
    expect(isShiftSelectable(makeShift({ status: 'contestado', contestNote: 'nota' }))).toBe(true);
  });

  it('NEGATIVO — validado CONGELA e não é selecionável', () => {
    expect(isShiftSelectable(makeShift({ status: 'validado' }))).toBe(false);
  });
});

describe('selectionSummary', () => {
  it('POSITIVO — soma contagem, horas e turnos sin check-in da seleção', () => {
    const shifts = [
      makeShift({ id: 's1', hoursActual: 4, origin: 'app' }),
      makeShift({ id: 's2', hoursActual: null, origin: 'sin_checkin', actualStart: null, actualEnd: null }),
    ];
    expect(selectionSummary(shifts)).toEqual({ count: 2, hours: 4, sinCheckinCount: 1 });
  });

  it('NEGATIVO — seleção vazia dá tudo zero (nunca ausente)', () => {
    expect(selectionSummary([])).toEqual({ count: 0, hours: 0, sinCheckinCount: 0 });
  });
});

describe('providerPendingSelectionState', () => {
  it('NEGATIVO — nenhum pendente selecionado dá "none"', () => {
    const provider = makeProvider({ shifts: [makeShift({ id: 's1', status: 'pendiente' })] });
    expect(providerPendingSelectionState(provider, new Set())).toBe('none');
  });

  it('POSITIVO — todos os pendentes selecionados dá "all"', () => {
    const provider = makeProvider({
      shifts: [makeShift({ id: 's1', status: 'pendiente' }), makeShift({ id: 's2', status: 'pendiente' })],
    });
    expect(providerPendingSelectionState(provider, new Set(['s1', 's2']))).toBe('all');
  });

  it('POSITIVO — parte dos pendentes selecionados dá "partial"', () => {
    const provider = makeProvider({
      shifts: [makeShift({ id: 's1', status: 'pendiente' }), makeShift({ id: 's2', status: 'pendiente' })],
    });
    expect(providerPendingSelectionState(provider, new Set(['s1']))).toBe('partial');
  });

  it('NEGATIVO — prestador sem pendentes (só validado) dá "none" mesmo se o ID estiver no set (contestado não conta)', () => {
    const provider = makeProvider({
      shifts: [makeShift({ id: 's1', status: 'contestado', contestNote: 'nota' })],
    });
    // s1 é contestado — nunca entra na conta do checkbox de cabeçalho, mesmo selecionado à mão.
    expect(providerPendingSelectionState(provider, new Set(['s1']))).toBe('none');
  });

  it('NEGATIVO — prestador 100% validado (sem pendentes) dá "none"', () => {
    const provider = makeProvider({ shifts: [makeShift({ id: 's1', status: 'validado' })] });
    expect(providerPendingSelectionState(provider, new Set(['s1']))).toBe('none');
  });
});

describe('blockReason', () => {
  it('NEGATIVO — retrato em dia (não stale, sem disjuntor) não bloqueia — undefined', () => {
    expect(blockReason({ stale: false, circuitBreakerOpen: false })).toBeUndefined();
  });

  it('POSITIVO — modo largo (padrão) com disjuntor aberto dá o texto específico do disjuntor', () => {
    const reason = blockReason({ stale: true, circuitBreakerOpen: true });
    expect(reason).toContain('disjuntor');
  });

  it('POSITIVO — modo largo só stale (sem disjuntor) dá o texto de retrato simples', () => {
    const reason = blockReason({ stale: true, circuitBreakerOpen: false }, 'largo');
    expect(reason).toBe('Retrato con más de 24 horas — validación deshabilitada hasta actualizar.');
  });

  it("POSITIVO — modo 'corto' dá sempre o mesmo texto fixo, com ou sem disjuntor", () => {
    expect(blockReason({ stale: true, circuitBreakerOpen: false }, 'corto')).toBe('retrato desactualizado');
    expect(blockReason({ stale: true, circuitBreakerOpen: true }, 'corto')).toBe('retrato desactualizado');
  });
});

describe('filterPatients', () => {
  const p90000 = makePatient({ anaCareId: '90000', providers: [makeProvider({ anaCareId: 'p1' })] });
  const p90447 = makePatient({ anaCareId: '90447', providers: [makeProvider({ anaCareId: 'p2' })] });

  it('POSITIVO — sem filtros devolve a lista intacta (mesma referência dos itens)', () => {
    expect(filterPatients([p90000, p90447])).toEqual([p90000, p90447]);
  });

  it('POSITIVO — patientSearch casa pelo ID do Ana Care (case-insensitive) — paciente nunca tem nome, fora de escopo', () => {
    expect(filterPatients([p90000, p90447], { patientSearch: '90000' })).toEqual([p90000]);
  });

  it('POSITIVO — patientSearch casa pelo ID do Ana Care', () => {
    expect(filterPatients([p90000, p90447], { patientSearch: '90447' })).toEqual([p90447]);
  });

  it('NEGATIVO — patientSearch sem match devolve lista vazia', () => {
    expect(filterPatients([p90000, p90447], { patientSearch: 'zzz-no-existe' })).toEqual([]);
  });

  it('POSITIVO — providerId restringe aos pacientes daquele prestador', () => {
    expect(filterPatients([p90000, p90447], { providerId: 'p1' })).toEqual([p90000]);
  });

  it('NEGATIVO — providerId inexistente devolve lista vazia', () => {
    expect(filterPatients([p90000, p90447], { providerId: 'no-existe' })).toEqual([]);
  });
});
