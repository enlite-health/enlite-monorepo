/**
 * buildScheduleWeek.test.ts
 *
 * Deriva `schedule_week` (tabela semanal estruturada) a partir do JSONB
 * `job_postings.schedule`, pro plugin WordPress renderizar sem re-parsear
 * texto livre. Reusa `normalizeSchedule` (mesma normalização usada por
 * `formatScheduleToText`) e `durationHours` (mesma duração usada por
 * `computeScheduleWeeklyHours`) — nunca duplica a lógica.
 *
 * Scenarios (regra de is_coverage calibrada contra 183 vagas reais de prod):
 *   a. Caso simples Lun-Vie 14-18 → days preenchido, weekly_hours=20, is_coverage=false
 *   b. 3 turnos/dia todos os dias (08-14/14-20/20-08) → is_coverage=true (≥3 turnos/dia), weekly_hours=168
 *   c. Turno noturno único 20-08 x7 dias → is_coverage=false (84h, 1 turno/dia, start≠end)
 *   d. Schedule texto livre / não-array não-estruturável → null
 *   e. Forma objeto-por-dia legada `{lunes:[{start,end}]}` → estruturado corretamente
 *      (prova reuso de normalizeSchedule, não de computeScheduleWeeklyHours)
 *   f. Slot com start===end (convenção "día completo/cama adentro") x7 dias →
 *      is_coverage=true, weekly_hours=168 (24h/dia via durationHours)
 */

import { buildScheduleWeek } from '../buildScheduleWeek';

describe('buildScheduleWeek', () => {
  it('a. caso simples Lun-Vie 14-18: days preenchido, weekly_hours=20, is_coverage=false', () => {
    const schedule = [
      { dayOfWeek: 1, startTime: '14:00', endTime: '18:00' }, // lunes
      { dayOfWeek: 2, startTime: '14:00', endTime: '18:00' }, // martes
      { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' }, // miercoles
      { dayOfWeek: 4, startTime: '14:00', endTime: '18:00' }, // jueves
      { dayOfWeek: 5, startTime: '14:00', endTime: '18:00' }, // viernes
    ];

    const result = buildScheduleWeek(schedule);

    expect(result).not.toBeNull();
    expect(result?.days.lunes).toEqual([{ start: '14:00', end: '18:00' }]);
    expect(result?.days.martes).toEqual([{ start: '14:00', end: '18:00' }]);
    expect(result?.days.miercoles).toEqual([{ start: '14:00', end: '18:00' }]);
    expect(result?.days.jueves).toEqual([{ start: '14:00', end: '18:00' }]);
    expect(result?.days.viernes).toEqual([{ start: '14:00', end: '18:00' }]);
    expect(result?.days.sabado).toEqual([]);
    expect(result?.days.domingo).toEqual([]);
    expect(result?.weekly_hours).toBe(20);
    expect(result?.is_coverage).toBe(false);
  });

  it('b. 3 turnos/dia todos os dias (08-14/14-20/20-08): is_coverage=true, weekly_hours=168', () => {
    const dayNums = [0, 1, 2, 3, 4, 5, 6];
    const schedule = dayNums.flatMap((dayOfWeek) => [
      { dayOfWeek, startTime: '08:00', endTime: '14:00' },
      { dayOfWeek, startTime: '14:00', endTime: '20:00' },
      { dayOfWeek, startTime: '20:00', endTime: '08:00' },
    ]);

    const result = buildScheduleWeek(schedule);

    expect(result).not.toBeNull();
    expect(result?.weekly_hours).toBe(168);
    expect(result?.is_coverage).toBe(true);
    expect(result?.days.lunes).toHaveLength(3);
    expect(result?.days.domingo).toHaveLength(3);
  });

  it('c. turno noturno único 20-08 x7 dias: is_coverage=false (84h, 1 turno/dia)', () => {
    const dayNums = [0, 1, 2, 3, 4, 5, 6];
    const schedule = dayNums.map((dayOfWeek) => ({
      dayOfWeek,
      startTime: '20:00',
      endTime: '08:00',
    }));

    const result = buildScheduleWeek(schedule);

    expect(result).not.toBeNull();
    expect(result?.weekly_hours).toBe(84);
    expect(result?.is_coverage).toBe(false);
    expect(result?.days.lunes).toHaveLength(1);
  });

  it('d. schedule texto livre / não-array não-estruturável → null', () => {
    expect(buildScheduleWeek('Lunes a viernes 9 a 17hs')).toBeNull();
  });

  it('d2. schedule ausente (null/undefined) → null', () => {
    expect(buildScheduleWeek(null)).toBeNull();
    expect(buildScheduleWeek(undefined)).toBeNull();
  });

  it('d3. array vazio → null', () => {
    expect(buildScheduleWeek([])).toBeNull();
  });

  it('d4. array com dayOfWeek inválido → null', () => {
    expect(buildScheduleWeek([{ dayOfWeek: 99, startTime: '09:00', endTime: '12:00' }])).toBeNull();
  });

  it('e. forma objeto-por-dia legada {lunes:[{start,end}]} é estruturada corretamente', () => {
    const schedule = {
      lunes: [{ start: '08:00', end: '12:00' }],
      miercoles: [
        { start: '08:00', end: '12:00' },
        { start: '14:00', end: '17:00' },
      ],
    };

    const result = buildScheduleWeek(schedule);

    expect(result).not.toBeNull();
    expect(result?.days.lunes).toEqual([{ start: '08:00', end: '12:00' }]);
    expect(result?.days.martes).toEqual([]);
    expect(result?.days.miercoles).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '14:00', end: '17:00' },
    ]);
    expect(result?.days.jueves).toEqual([]);
    expect(result?.days.viernes).toEqual([]);
    expect(result?.days.sabado).toEqual([]);
    expect(result?.days.domingo).toEqual([]);
    expect(result?.weekly_hours).toBe(11); // 4h + 4h + 3h
    expect(result?.is_coverage).toBe(false);
  });

  it('f. slot com start===end ("día completo/cama adentro") x7 dias: is_coverage=true, weekly_hours=168', () => {
    const dayNums = [0, 1, 2, 3, 4, 5, 6];
    const schedule = dayNums.map((dayOfWeek) => ({
      dayOfWeek,
      startTime: '08:00',
      endTime: '08:00',
    }));

    const result = buildScheduleWeek(schedule);

    expect(result).not.toBeNull();
    expect(result?.weekly_hours).toBe(168);
    expect(result?.is_coverage).toBe(true);
    expect(result?.days.lunes).toEqual([{ start: '08:00', end: '08:00' }]);
  });

  it('ignores invalid slots (missing start/end) without crashing', () => {
    const schedule = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: undefined, endTime: '12:00' },
    ];

    const result = buildScheduleWeek(schedule);

    expect(result).not.toBeNull();
    expect(result?.days.lunes).toEqual([{ start: '09:00', end: '12:00' }]);
    expect(result?.days.martes).toEqual([]);
    expect(result?.weekly_hours).toBe(3);
  });
});
