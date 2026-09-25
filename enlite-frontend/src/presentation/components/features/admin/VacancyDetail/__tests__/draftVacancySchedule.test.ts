import { describe, it, expect } from 'vitest';
import {
  buildScheduleGrid,
  daysWithAttendanceCount,
  formatScheduleTime,
  weeklyHoursFromSchedule,
  type NormalizedSchedule,
} from '../draftVacancySchedule';

describe('draftVacancySchedule — a grade de 7 dias (F24/F28)', () => {
  it('schedule null/undefined → os 7 dias, todos sem bloco (sin atención)', () => {
    expect(buildScheduleGrid(null)).toHaveLength(7);
    expect(buildScheduleGrid(null).every((d) => d.blocks.length === 0)).toBe(true);
    expect(buildScheduleGrid(undefined)).toHaveLength(7);
  });

  it('ordem de exibição é Lun→Dom (semana comercial), não a ordem de getDay() do backend', () => {
    const grid = buildScheduleGrid(null);
    expect(grid.map((d) => d.key)).toEqual(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']);
    expect(grid.map((d) => d.short)).toEqual(['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']);
  });

  it('F28: dia com MAIS de um bloco chega intacto — nenhum se perde nem funde', () => {
    const schedule: NormalizedSchedule = {
      sabado: [
        { start: '08:00', end: '12:00' },
        { start: '16:00', end: '20:00' },
      ],
    };
    const grid = buildScheduleGrid(schedule);
    const sabado = grid.find((d) => d.key === 'sabado')!;
    expect(sabado.blocks).toHaveLength(2);
    expect(sabado.blocks).toEqual([
      { start: '08:00', end: '12:00' },
      { start: '16:00', end: '20:00' },
    ]);

    const domingo = grid.find((d) => d.key === 'domingo')!;
    expect(domingo.blocks).toHaveLength(0);
  });

  it('weeklyHoursFromSchedule soma todos os blocos de todos os dias', () => {
    const schedule: NormalizedSchedule = {
      lunes: [{ start: '08:00', end: '14:00' }], // 6h
      martes: [{ start: '14:00', end: '20:00' }], // 6h
      miercoles: [{ start: '08:00', end: '14:00' }], // 6h
      viernes: [{ start: '14:00', end: '20:00' }], // 6h
      sabado: [
        { start: '08:00', end: '12:00' }, // 4h
        { start: '16:00', end: '20:00' }, // 4h
      ],
    };
    expect(weeklyHoursFromSchedule(schedule)).toBe(32);
  });

  it('weeklyHoursFromSchedule trata virada de meia-noite (end < start)', () => {
    const schedule: NormalizedSchedule = { sabado: [{ start: '22:00', end: '02:00' }] };
    expect(weeklyHoursFromSchedule(schedule)).toBe(4);
  });

  it('weeklyHoursFromSchedule(null) é 0', () => {
    expect(weeklyHoursFromSchedule(null)).toBe(0);
  });

  it('formatScheduleTime: sem zero à esquerda na hora, minutos só quando ≠ :00 (protótipo v3)', () => {
    expect(formatScheduleTime('08:00')).toBe('8');
    expect(formatScheduleTime('14:00')).toBe('14');
    expect(formatScheduleTime('08:30')).toBe('8:30');
    expect(formatScheduleTime('00:00')).toBe('0');
  });

  it('formatScheduleTime: valor fora do formato HH:MM volta como veio, sem lançar', () => {
    expect(formatScheduleTime('')).toBe('');
    expect(formatScheduleTime('garbage')).toBe('garbage');
  });

  it('daysWithAttendanceCount conta dias com ao menos 1 bloco — não conta blocos', () => {
    const schedule: NormalizedSchedule = {
      lunes: [{ start: '08:00', end: '12:00' }],
      sabado: [
        { start: '08:00', end: '12:00' },
        { start: '16:00', end: '20:00' },
      ],
    };
    expect(daysWithAttendanceCount(schedule)).toBe(2);
    expect(daysWithAttendanceCount(null)).toBe(0);
  });
});
