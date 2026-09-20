import { describe, it, expect } from 'vitest';
import {
  allShiftsOf,
  axonicoDayEligibility,
  blockReason,
  currentMonthIso,
  filterPatients,
  formatMonthLabel,
  formatSourceRange,
  formatSourceTime,
  isShiftSelectable,
  monthOptionsUntilNow,
  originCounts,
  patientDisplayName,
  pendingOriginBreakdown,
  providerDisplayName,
  selectionSummary,
  shiftHours,
  startOfWeekMonday,
  todayIsoLocal,
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

describe('axonicoDayEligibility', () => {
  const validado = (overrides: Partial<AnaCareShift> = {}): AnaCareShift =>
    makeShift({ status: 'validado', hoursActual: 8, ...overrides });

  it('POSITIVO — elegível com as 4 condições satisfeitas (validado, com par, hora cheia, documento presente)', () => {
    const result = axonicoDayEligibility([validado({ id: 's1' })], '30111222');
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it('NEGATIVO — motivo notValidated quando algum turno do dia não está validado', () => {
    const result = axonicoDayEligibility([validado({ id: 's1' }), makeShift({ id: 's2', status: 'pendiente', hoursActual: 8 })], '30111222');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['notValidated']);
  });

  it('NEGATIVO — motivo notValidated quando o dia não tem NENHUM turno (lista vazia)', () => {
    const result = axonicoDayEligibility([], '30111222');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('notValidated');
  });

  it('NEGATIVO — motivo missingCheckInOut quando algum turno validado não tem par completo (hoursActual null)', () => {
    // D363/D344: turno sem check-in pode estar "validado" (contestação resolvida) mas hoursActual continua null.
    const result = axonicoDayEligibility([validado({ id: 's1', hoursActual: null, actualStart: null, actualEnd: null })], '30111222');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['missingCheckInOut']);
  });

  it('NEGATIVO — motivo fractionalHours quando o total do dia não é hora cheia (nunca arredonda)', () => {
    const result = axonicoDayEligibility([validado({ id: 's1', hoursActual: 8.5 })], '30111222');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['fractionalHours']);
  });

  it('POSITIVO — soma de decimais que fecha em hora cheia dentro da tolerância de ponto flutuante é aceita (8.1+7.9=16)', () => {
    const result = axonicoDayEligibility([validado({ id: 's1', hoursActual: 8.1 }), validado({ id: 's2', hoursActual: 7.9 })], '30111222');
    expect(result.eligible).toBe(true);
  });

  it('NEGATIVO — motivo missingDocument quando documentNumber está ausente', () => {
    const result = axonicoDayEligibility([validado({ id: 's1' })], undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['missingDocument']);
  });

  it('NEGATIVO — motivo missingDocument quando documentNumber é string vazia', () => {
    const result = axonicoDayEligibility([validado({ id: 's1' })], '');
    expect(result.reasons).toEqual(['missingDocument']);
  });

  it('NEGATIVO — mais de um motivo pode estar presente ao mesmo tempo (nunca só o primeiro)', () => {
    const result = axonicoDayEligibility([makeShift({ id: 's1', status: 'pendiente', hoursActual: null, actualStart: null, actualEnd: null })], undefined);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['notValidated', 'missingCheckInOut', 'missingDocument']));
    expect(result.reasons).toHaveLength(3);
  });
});

/**
 * Oráculo independente da implementação, usado só nos testes de fuso abaixo (20/09). Nunca chama
 * `currentMonthIso`/`todayIsoLocal` nem reimplementa `getFullYear`/`getMonth`/`getDate` — usa
 * `Intl` (`toLocaleDateString('en-CA')`, que formata `YYYY-MM-DD` na hora LOCAL do processo) como
 * segunda fonte. Reusar a própria função como oráculo seria tautologia: só provaria que ela
 * concorda consigo mesma.
 */
function localIsoDateOracle(instant: Date): string {
  return instant.toLocaleDateString('en-CA');
}

function localIsoMonthOracle(instant: Date): string {
  return localIsoDateOracle(instant).slice(0, 7);
}

/**
 * Deriva o dia/mês local ESPERADO a partir do offset REAL do ambiente (`Date.getTimezoneOffset`),
 * sem cravar `'2026-09-30'`/`'2026-09'` no teste — assim o valor esperado continua correto tanto
 * em UTC-3 (Buenos Aires) quanto em UTC-4/UTC-5, se o runner algum dia rodar noutro fuso negativo.
 * Desloca o instante em milissegundos e lê com `getUTC*`: esses getters devolvem sempre os MESMOS
 * dígitos não importa o TZ do processo, porque o deslocamento já foi aplicado antes de ler.
 */
function expectedLocalFromOffset(instant: Date): { dayIso: string; monthIso: string } {
  const offsetMinutes = instant.getTimezoneOffset();
  const shifted = new Date(instant.getTime() - offsetMinutes * 60000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return { dayIso: `${year}-${month}-${day}`, monthIso: `${year}-${month}` };
}

describe('currentMonthIso', () => {
  it('POSITIVO — data injetada no meio do mês devolve o YYYY-MM daquele mês', () => {
    expect(currentMonthIso(new Date('2026-09-20T12:00:00Z'))).toBe('2026-09');
  });

  // Meio-dia (não meia-noite) de propósito: instante SEGURO em qualquer fuso — nenhum fuso real
  // desloca ±12h a ponto de mudar o dia/mês. O caso de fuso que MUDA de dia/mês é o teste de
  // contrato e o controle negativo abaixo.
  it('POSITIVO — primeiro dia do mês, instante seguro em qualquer fuso, ainda cai nesse mês', () => {
    expect(currentMonthIso(new Date('2026-10-01T12:00:00Z'))).toBe('2026-10');
  });

  it('POSITIVO — mês de um dígito vem com zero à esquerda', () => {
    expect(currentMonthIso(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01');
  });

  /**
   * CONTRATO (decisão do Gabriel, 20/09) — roda SEMPRE, em QUALQUER fuso, porque compara contra um
   * oráculo independente (`Intl`), não contra um valor cravado. Prova a régua: o mês segue o
   * relógio de parede LOCAL do operador, nunca UTC.
   */
  it('POSITIVO — contrato: acompanha o relógio LOCAL do processo em qualquer fuso (oráculo Intl, não a própria função)', () => {
    const instant = new Date('2026-10-01T02:30:00Z');
    expect(currentMonthIso(instant)).toBe(localIsoMonthOracle(instant));
  });

  /**
   * CONTROLE NEGATIVO — discrimina local×UTC só onde os dois DIVERGEM de verdade. Dentro de um
   * processo rodando em UTC, "relógio local" e "UTC" são a MESMA coisa (offset 0): nenhum teste
   * consegue distinguir os dois ali, e forçar a distinção é o que quebrou no CI (ver abaixo) — por
   * isso este caso vira `it.skip` quando o offset do ambiente é zero. Fora de UTC, o valor esperado
   * é DERIVADO do offset real (`expectedLocalFromOffset`), não cravado, pra valer em UTC-3, UTC-4
   * ou UTC-5 igual, sem reescrever o teste se o runner do time mudar de fuso.
   *
   * Antes desta versão o teste pinava `process.env.TZ = 'America/Argentina/Buenos_Aires'` em
   * RUNTIME (depois do processo já ter começado) — removido porque o V8 cacheia o fuso na primeira
   * leitura de `Date`/`Intl`, então atribuir `TZ` depois não garante efeito: passava na máquina do
   * dev (já UTC-3) e falhava no CI (`ubuntu-latest`, UTC). Não reintroduzir o pino de `TZ` aqui.
   */
  const controlInstant = new Date('2026-10-01T02:30:00Z');
  const runnerIsUtc = controlInstant.getTimezoneOffset() === 0;
  const itDiscrimina = runnerIsUtc ? it.skip : it;
  itDiscrimina(
    'NEGATIVO — 30/09 23:30 em Buenos Aires (UTC-3) é 01/10 de madrugada em UTC: o mês segue o relógio LOCAL, não UTC (só discrimina fora de UTC — pulado quando o runner É UTC, que não distingue os dois)',
    () => {
      expect(currentMonthIso(controlInstant)).toBe(expectedLocalFromOffset(controlInstant).monthIso);
    },
  );
});

describe('todayIsoLocal', () => {
  it('POSITIVO — instante ao meio-dia UTC devolve o mesmo dia em YYYY-MM-DD, com zero à esquerda', () => {
    expect(todayIsoLocal(new Date('2026-09-05T12:00:00Z'))).toBe('2026-09-05');
  });

  /**
   * CONTRATO (decisão do Gabriel, 20/09) — mesma lógica do contrato de `currentMonthIso` acima:
   * compara contra o oráculo `Intl`, roda sempre, em qualquer fuso.
   */
  it('POSITIVO — contrato: acompanha o relógio LOCAL do processo em qualquer fuso (oráculo Intl, não a própria função)', () => {
    const instant = new Date('2026-10-01T02:30:00Z');
    expect(todayIsoLocal(instant)).toBe(localIsoDateOracle(instant));
  });

  /**
   * CONTROLE NEGATIVO — mesma lógica do controle de `currentMonthIso` acima (mesmo instante, mesmo
   * `it.skip` condicional ao offset, mesmo valor DERIVADO em vez de cravado). A implementação
   * ANTIGA usava `toISOString().slice(0, 10)` (sempre UTC) e devolveria `'2026-10-01'` aqui; a
   * fórmula LOCAL tem de devolver o dia derivado do offset do ambiente.
   *
   * O pino de `process.env.TZ` em runtime foi removido pelo mesmo motivo do bloco acima (cache de
   * fuso do V8) — não reintroduzir.
   */
  const controlInstant = new Date('2026-10-01T02:30:00Z');
  const runnerIsUtc = controlInstant.getTimezoneOffset() === 0;
  const itDiscrimina = runnerIsUtc ? it.skip : it;
  itDiscrimina(
    'NEGATIVO — 30/09 23:30 em Buenos Aires (UTC-3) é 01/10 de madrugada em UTC: o dia segue o relógio LOCAL, não UTC (só discrimina fora de UTC — pulado quando o runner É UTC, que não distingue os dois)',
    () => {
      expect(todayIsoLocal(controlInstant)).toBe(expectedLocalFromOffset(controlInstant).dayIso);
    },
  );
});

describe('monthOptionsUntilNow', () => {
  it('POSITIVO — piso 2026-08 com referência em setembro/2026 devolve [2026-08, 2026-09]', () => {
    expect(monthOptionsUntilNow('2026-08', new Date('2026-09-20T12:00:00Z'))).toEqual(['2026-08', '2026-09']);
  });

  it('POSITIVO — mês novo entra sozinho: referência em outubro/2026 inclui 2026-10', () => {
    expect(monthOptionsUntilNow('2026-08', new Date('2026-10-05T12:00:00Z'))).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('POSITIVO — piso e referência no mesmo mês devolvem lista de um único item', () => {
    expect(monthOptionsUntilNow('2026-08', new Date('2026-08-03T12:00:00Z'))).toEqual(['2026-08']);
  });

  it('POSITIVO — atravessa virada de ano sem quebrar a ordem crescente', () => {
    expect(monthOptionsUntilNow('2026-11', new Date('2027-01-10T12:00:00Z'))).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('NEGATIVO — piso posterior ao mês corrente devolve só o piso, nunca lista vazia', () => {
    expect(monthOptionsUntilNow('2027-01', new Date('2026-09-20T12:00:00Z'))).toEqual(['2027-01']);
  });
});

describe('formatMonthLabel', () => {
  it('POSITIVO — es: mês com nome completo, primeira letra maiúscula, seguido do ano', () => {
    expect(formatMonthLabel('2026-08', 'es')).toBe('Agosto 2026');
    expect(formatMonthLabel('2026-09', 'es')).toBe('Septiembre 2026');
  });

  it('POSITIVO — pt-BR: mesmo formato, nome do mês em português', () => {
    expect(formatMonthLabel('2026-08', 'pt-BR')).toBe('Agosto 2026');
    expect(formatMonthLabel('2026-09', 'pt-BR')).toBe('Setembro 2026');
  });
});
