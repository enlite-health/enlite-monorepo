import { describe, it, expect } from 'vitest';
import {
  allShiftsOf,
  blockReason,
  filterPatients,
  formatSourceRange,
  formatSourceTime,
  isShiftSelectable,
  originCounts,
  patientDisplayName,
  pendingOriginBreakdown,
  providerDisplayName,
  selectionSummary,
  shiftHours,
  startOfWeekMonday,
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
    linked: true,
    name: 'Rocío García QA',
    shifts: [],
    ...overrides,
  };
}

function makePatient(overrides: Partial<AnaCarePatient> = {}): AnaCarePatient {
  return {
    anaCareId: '90000',
    linked: true,
    name: 'Lucía Fernández QA',
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
  it('POSITIVO — prestador vinculado mostra o nome', () => {
    const provider = makeProvider({ linked: true, name: 'Rocío García QA' });
    expect(providerDisplayName(provider)).toBe('Rocío García QA');
  });

  it('NEGATIVO — prestador sem vínculo mostra "Sin vínculo · ID <n>", nunca o nome', () => {
    const provider = makeProvider({ linked: false, name: undefined, anaCareId: '90512' });
    expect(providerDisplayName(provider)).toBe('Sin vínculo · ID 90512');
  });
});

describe('patientDisplayName', () => {
  it('POSITIVO — paciente vinculado mostra o nome', () => {
    const patient = makePatient({ linked: true, name: 'Lucía Fernández QA' });
    expect(patientDisplayName(patient)).toBe('Lucía Fernández QA');
  });

  it('NEGATIVO — paciente sem vínculo mostra "Sin vínculo · ID <n>"', () => {
    const patient = makePatient({ linked: false, name: undefined, anaCareId: '90447' });
    expect(patientDisplayName(patient)).toBe('Sin vínculo · ID 90447');
  });

  /**
   * Item 1 (17/09): o nome do paciente vem do PAYLOAD do turno, não do cruzamento com `patients`
   * — `linked` continua SEMPRE `false` (D349 item 2, bloqueado), mas o nome tem de aparecer mesmo
   * assim. Antes desta mudança, `patientDisplayName` exigia `linked && name` e nunca mostrava o
   * nome (linked nunca é true) — este teste MORRE se essa exigência voltar.
   */
  it('POSITIVO — paciente com nome da FONTE mostra o nome mesmo com linked=false (D349 item 2)', () => {
    const patient = makePatient({ linked: false, name: 'Lucía Fernández QA', anaCareId: '90447' });
    expect(patientDisplayName(patient)).toBe('Lucía Fernández QA');
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
  const linked = makePatient({ anaCareId: '90000', linked: true, name: 'Lucía Fernández QA', providers: [makeProvider({ anaCareId: 'p1' })] });
  const unlinked = makePatient({ anaCareId: '90447', linked: false, name: undefined, providers: [makeProvider({ anaCareId: 'p2' })] });

  it('POSITIVO — sem filtros devolve a lista intacta (mesma referência dos itens)', () => {
    expect(filterPatients([linked, unlinked])).toEqual([linked, unlinked]);
  });

  it('POSITIVO — patientSearch casa pelo nome (case-insensitive)', () => {
    expect(filterPatients([linked, unlinked], { patientSearch: 'lucía' })).toEqual([linked]);
  });

  it('POSITIVO — patientSearch casa pelo ID do Ana Care quando não há vínculo', () => {
    expect(filterPatients([linked, unlinked], { patientSearch: '90447' })).toEqual([unlinked]);
  });

  it('NEGATIVO — patientSearch sem match devolve lista vazia', () => {
    expect(filterPatients([linked, unlinked], { patientSearch: 'zzz-no-existe' })).toEqual([]);
  });

  it('POSITIVO — providerId restringe aos pacientes daquele prestador', () => {
    expect(filterPatients([linked, unlinked], { providerId: 'p1' })).toEqual([linked]);
  });

  it('NEGATIVO — providerId inexistente devolve lista vazia', () => {
    expect(filterPatients([linked, unlinked], { providerId: 'no-existe' })).toEqual([]);
  });
});

describe('startOfWeekMonday', () => {
  it('POSITIVO — segunda-feira devolve ela mesma', () => {
    expect(startOfWeekMonday('2026-08-10')).toBe('2026-08-10');
  });

  it('POSITIVO — sexta-feira devolve a segunda da mesma semana', () => {
    expect(startOfWeekMonday('2026-08-14')).toBe('2026-08-10');
  });

  /**
   * Cobertura (17/09): domingo é o único dia em que `Date.getUTCDay()` devolve `0` — o código
   * mapeia isso pra `7` (ISO) antes de subtrair. Sem este caso, o ramo do domingo nunca roda, e um
   * paciente com turno marcado num domingo abriria o detalhe na semana ERRADA (a seguinte, não a
   * que contém o turno).
   */
  it('POSITIVO — domingo (getUTCDay()===0) devolve a segunda da MESMA semana, não da seguinte', () => {
    expect(startOfWeekMonday('2026-08-16')).toBe('2026-08-10');
  });
});

/**
 * Item 2 (17/09): fixtures medidas de verdade contra a API real — turno noturno
 * `2026-08-01T20:00:00-06:00` → `2026-08-02T08:00:00-06:00` (cruza a meia-noite, 46% dos turnos
 * de agosto). `formatSourceTime`/`formatSourceRange` têm de devolver o relógio de parede da FONTE
 * (offset `-06:00`), nunca convertido pro fuso do navegador.
 */
describe('formatSourceTime', () => {
  it('POSITIVO — HH:MM no fuso fixo -06:00 da fonte, não no fuso do navegador', () => {
    expect(formatSourceTime('2026-08-01T20:00:00-06:00')).toBe('20:00');
    expect(formatSourceTime('2026-08-02T08:00:00-06:00')).toBe('08:00');
  });

  it('POSITIVO — mesmo instante gravado como Z (round-trip por timestamptz) devolve a MESMA hora de parede -06:00', () => {
    // 2026-08-01T20:00:00-06:00 === 2026-08-02T02:00:00Z (mesmo instante).
    expect(formatSourceTime('2026-08-02T02:00:00.000Z')).toBe('20:00');
  });

  it('NEGATIVO — null/undefined/vazio/inválido devolvem undefined, nunca lançam', () => {
    expect(formatSourceTime(null)).toBeUndefined();
    expect(formatSourceTime(undefined)).toBeUndefined();
    expect(formatSourceTime('')).toBeUndefined();
    expect(formatSourceTime('nao-e-data')).toBeUndefined();
  });
});

describe('formatSourceRange', () => {
  it('POSITIVO — turno no MESMO dia mostra HH:MM–HH:MM sem marca', () => {
    expect(formatSourceRange('2026-08-14T08:00:00-06:00', '2026-08-14T16:00:00-06:00')).toBe('08:00–16:00');
  });

  it('POSITIVO — turno NOTURNO cruzando a meia-noite mostra a marca do dia seguinte (+1)', () => {
    expect(formatSourceRange('2026-08-01T20:00:00-06:00', '2026-08-02T08:00:00-06:00')).toBe('20:00–08:00 (+1)');
  });

  it('NEGATIVO — falta início ou fim (retrato sem previsto gravado) mostra "—", nunca horário inventado', () => {
    expect(formatSourceRange(null, '2026-08-14T16:00:00-06:00')).toBe('—');
    expect(formatSourceRange('2026-08-14T08:00:00-06:00', null)).toBe('—');
    expect(formatSourceRange('', '')).toBe('—');
  });
});
