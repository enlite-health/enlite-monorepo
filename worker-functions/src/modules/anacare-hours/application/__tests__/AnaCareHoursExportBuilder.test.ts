import * as XLSX from 'xlsx';
import { buildAnaCareHoursWorkbook, NO_SHIFTS_MESSAGE } from '../AnaCareHoursExportBuilder';
import type { AnaCarePatient, AnaCareShift } from '../../domain/AnaCareShift';

const NOW = new Date('2026-10-02T15:30:00.000Z'); // 12:30 em Buenos Aires

function shift(over: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 'S-1',
    anaCareShiftId: 'S-1',
    date: '2026-09-10',
    scheduledStart: '2026-09-10T08:00:00-06:00',
    scheduledEnd: '2026-09-10T12:00:00-06:00',
    actualStart: '2026-09-10T08:05:00-06:00',
    actualEnd: '2026-09-10T11:50:00-06:00',
    hoursActual: 3.75,
    hoursScheduled: 4,
    origin: 'app',
    status: 'pendiente',
    ...over,
  } as AnaCareShift;
}

function patient(providers: Array<{ id: string; name?: string; shifts: AnaCareShift[] }>): AnaCarePatient {
  return {
    anaCareId: 'AC-PAT-0',
    linked: false,
    providers: providers.map((p) => ({ anaCareId: p.id, linked: false, name: p.name, shifts: p.shifts })),
  };
}

function build(p: AnaCarePatient | null, label = 'Paciente Sintetico QA') {
  const buf = buildAnaCareHoursWorkbook({ patient: p, patientLabel: label, desde: '2026-09-01', hasta: '2026-09-30', now: NOW });
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = (name: string) => XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[name], { header: 1, defval: '' });
  return { wb, sintetico: rows('Sintético'), analitico: rows('Analítico') };
}

const HEADER_ROWS = 6; // 5 linhas de cabeçalho + título da aba; a linha 7 é o cabeçalho da tabela
const bodyOf = (rows: (string | number)[][]) => rows.slice(HEADER_ROWS + 1);

describe('buildAnaCareHoursWorkbook (spec 032)', () => {
  it('gera 2 abas, na ordem Sintético / Analítico', () => {
    const { wb } = build(patient([{ id: 'N1', shifts: [shift()] }]));
    expect(wb.SheetNames).toEqual(['Sintético', 'Analítico']);
  });

  it('cabeçalho de cada aba: paciente, período, emissão em Buenos Aires, reloj de la fuente e confidencial', () => {
    const { sintetico, analitico } = build(patient([{ id: 'N1', shifts: [shift()] }]));
    for (const rows of [sintetico, analitico]) {
      expect(rows[0].slice(0, 2)).toEqual(['Paciente', 'Paciente Sintetico QA']);
      expect(rows[1].slice(0, 2)).toEqual(['Período', '01/09/2026 → 30/09/2026']);
      expect(rows[2].slice(0, 2)).toEqual(['Emitido (Buenos Aires)', '02/10/2026 12:30']);
      expect(rows[3][0]).toBe('Horarios en el reloj de la fuente (UTC−06:00)');
      expect(rows[4][0]).toBe('Documento confidencial');
    }
  });

  it('não vaza documento, nota nem nome de quem exportou', () => {
    const p = patient([{ id: 'N1', shifts: [shift({ status: 'contestado', contestNote: 'NOTA-SECRETA' })] }]);
    p.documentNumber = '30999888';
    p.documentType = 'DNI';
    const { sintetico, analitico } = build(p);
    const text = JSON.stringify([sintetico, analitico]);
    expect(text).not.toContain('NOTA-SECRETA');
    expect(text).not.toContain('30999888');
    expect(text).not.toContain('DNI');
    expect(text).not.toMatch(/Exportado por|Usuario/i);
  });

  it('Sintético: colunas, uma linha por prestador e linha Total', () => {
    const { sintetico } = build(
      patient([
        { id: 'N2', name: 'Prestador B', shifts: [shift({ id: 'b1', hoursActual: 2 })] },
        { id: 'N1', name: 'Prestador A', shifts: [shift({ id: 'a1', hoursActual: 3.75 }), shift({ id: 'a2', hoursActual: 1.25, status: 'validado' })] },
      ]),
    );
    expect(sintetico[HEADER_ROWS]).toEqual(['Prestador', 'Turnos', 'Horas totales', 'Horas validadas', 'Horas no validadas']);
    expect(bodyOf(sintetico)).toEqual([
      ['Prestador A', 2, 5, 1.25, 3.75],
      ['Prestador B', 1, 2, 0, 2],
      ['Total', 3, 7, 1.25, 5.75],
    ]);
  });

  it('Sintético: validadas + no validadas = totales em cada linha', () => {
    const { sintetico } = build(
      patient([{ id: 'N1', shifts: [shift({ id: 'a', hoursActual: 3.1, status: 'validado' }), shift({ id: 'b', hoursActual: 2.2 }), shift({ id: 'c', hoursActual: null, origin: 'sin_checkin', actualStart: null, actualEnd: null })] }]),
    );
    for (const r of bodyOf(sintetico)) expect(Number(r[3]) + Number(r[4])).toBeCloseTo(Number(r[2]), 9);
  });

  it('Analítico: 9 colunas e TODOS os turnos', () => {
    const { analitico } = build(patient([{ id: 'N1', shifts: [shift({ id: 'a' }), shift({ id: 'b' }), shift({ id: 'c' })] }]));
    expect(analitico[HEADER_ROWS]).toEqual(['Fecha', 'Prestador', 'Inicio previsto', 'Fin previsto', 'Check-in', 'Check-out', 'Origen', 'Horas', 'Estado']);
    expect(bodyOf(analitico).filter((r) => r[0] !== 'Total')).toHaveLength(3);
  });

  it('Analítico: ordem dia → prestador → início previsto', () => {
    const { analitico } = build(
      patient([
        { id: 'N2', name: 'B', shifts: [shift({ id: 'b-d1', date: '2026-09-01', scheduledStart: '2026-09-01T09:00:00-06:00' })] },
        {
          id: 'N1',
          name: 'A',
          shifts: [
            shift({ id: 'a-d2', date: '2026-09-02', scheduledStart: '2026-09-02T08:00:00-06:00' }),
            shift({ id: 'a-d1-tarde', date: '2026-09-01', scheduledStart: '2026-09-01T14:00:00-06:00' }),
            shift({ id: 'a-d1-cedo', date: '2026-09-01', scheduledStart: '2026-09-01T06:00:00-06:00' }),
          ],
        },
      ]),
    );
    const body = bodyOf(analitico).filter((r) => r[0] !== 'Total');
    expect(body.map((r) => `${r[0]}|${r[1]}|${r[2]}`)).toEqual([
      '01/09/2026|A|06:00',
      '01/09/2026|A|14:00',
      '01/09/2026|B|09:00',
      '02/09/2026|A|08:00',
    ]);
  });

  it('Estado pela precedência: validado > contestado > sin check-in > pendiente', () => {
    const semCheckin = { origin: 'sin_checkin' as const, actualStart: null, actualEnd: null, hoursActual: null };
    const { analitico } = build(
      patient([
        {
          id: 'N1',
          shifts: [
            shift({ id: '1', date: '2026-09-01', status: 'validado', ...semCheckin }),
            shift({ id: '2', date: '2026-09-02', status: 'contestado', ...semCheckin }),
            shift({ id: '3', date: '2026-09-03', status: 'pendiente', ...semCheckin }),
            shift({ id: '4', date: '2026-09-04', status: 'pendiente' }),
          ],
        },
      ]),
    );
    expect(bodyOf(analitico).filter((r) => r[0] !== 'Total').map((r) => r[8])).toEqual(['Validado', 'Contestado', 'Sin check-in', 'Pendiente']);
  });

  it('horários HH:MM no relógio da fonte (Etc/GMT+6), não o do instante UTC', () => {
    const { analitico } = build(patient([{ id: 'N1', shifts: [shift({ scheduledStart: '2026-09-10T14:00:00.000Z', scheduledEnd: '2026-09-10T18:00:00.000Z', actualStart: '2026-09-10T14:05:00.000Z', actualEnd: '2026-09-10T17:50:00.000Z' })] }]));
    const row = bodyOf(analitico)[0];
    expect(row.slice(2, 6)).toEqual(['08:00', '12:00', '08:05', '11:50']);
  });

  it('turno 22:00→10:00 mostra o fim no dia seguinte e fica no dia em que começa', () => {
    const { analitico } = build(
      patient([{ id: 'N1', shifts: [shift({ date: '2026-09-30', scheduledStart: '2026-09-30T22:00:00-06:00', scheduledEnd: '2026-10-01T10:00:00-06:00', actualStart: '2026-09-30T22:00:00-06:00', actualEnd: '2026-10-01T10:00:00-06:00', hoursActual: 12 })] }]),
    );
    const row = bodyOf(analitico)[0];
    expect(row[0]).toBe('30/09/2026');
    expect(row.slice(2, 6)).toEqual(['22:00', '10:00 (+1 día)', '22:00', '10:00 (+1 día)']);
  });

  it('período vazio: as duas abas trazem "Sin turnos en el período" e total 0', () => {
    const { sintetico, analitico } = build(null, 'Sin vínculo · ID AC-PAT-0');
    expect(bodyOf(sintetico)[0][0]).toBe(NO_SHIFTS_MESSAGE);
    expect(bodyOf(analitico)[0][0]).toBe(NO_SHIFTS_MESSAGE);
    expect(bodyOf(sintetico).at(-1)).toEqual(['Total', 0, 0, 0, 0]);
    expect(bodyOf(analitico).at(-1)![7]).toBe(0);
    expect(sintetico[0].slice(0, 2)).toEqual(['Paciente', 'Sin vínculo · ID AC-PAT-0']);
  });

  it('Horas = horas REAIS (hoursActual), nunca as previstas; sem check-in soma 0 (D344)', () => {
    const { sintetico, analitico } = build(
      patient([{ id: 'N1', shifts: [shift({ id: 'a', hoursActual: 3.75, hoursScheduled: 4 }), shift({ id: 'b', hoursActual: null, hoursScheduled: 4, origin: 'sin_checkin', actualStart: null, actualEnd: null })] }]),
    );
    expect(bodyOf(sintetico).at(-1)![2]).toBe(3.75);
    expect(bodyOf(analitico).filter((r) => r[0] !== 'Total').map((r) => r[7])).toEqual([3.75, 0]);
  });

  it('soma do Sintético = soma do Analítico', () => {
    const { sintetico, analitico } = build(
      patient([
        { id: 'N1', shifts: [shift({ id: 'a', hoursActual: 3.1 }), shift({ id: 'b', hoursActual: 2.2 })] },
        { id: 'N2', shifts: [shift({ id: 'c', hoursActual: 0.7, status: 'validado' })] },
      ]),
    );
    const somaSint = bodyOf(sintetico).filter((r) => r[0] !== 'Total').reduce((a, r) => a + Number(r[2]), 0);
    const somaAnal = bodyOf(analitico).filter((r) => r[0] !== 'Total').reduce((a, r) => a + Number(r[7]), 0);
    expect(somaSint).toBeCloseTo(somaAnal, 9);
    expect(somaAnal).toBeCloseTo(6, 9);
  });

  it('prestador sem nome sai como "Sin vínculo · ID <id>" nas duas abas', () => {
    const { sintetico, analitico } = build(patient([{ id: 'N77', shifts: [shift()] }]));
    expect(bodyOf(sintetico)[0][0]).toBe('Sin vínculo · ID N77');
    expect(bodyOf(analitico)[0][1]).toBe('Sin vínculo · ID N77');
  });

  it('Origen traduzido: App / Web admin / Sin check-in', () => {
    const { analitico } = build(
      patient([{ id: 'N1', shifts: [shift({ id: '1', date: '2026-09-01', origin: 'app' }), shift({ id: '2', date: '2026-09-02', origin: 'web_admin' }), shift({ id: '3', date: '2026-09-03', origin: 'sin_checkin', actualStart: null, actualEnd: null, hoursActual: null })] }]),
    );
    expect(bodyOf(analitico).filter((r) => r[0] !== 'Total').map((r) => r[6])).toEqual(['App', 'Web admin', 'Sin check-in']);
  });

  it('horário ausente ou inválido vira célula vazia (nunca "Invalid Date" nem NaN)', () => {
    const { analitico } = build(patient([{ id: 'N1', shifts: [shift({ scheduledStart: '', scheduledEnd: 'lixo', actualStart: null, actualEnd: null })] }]));
    expect(bodyOf(analitico)[0].slice(2, 6)).toEqual(['', '', '', '']);
  });
});
