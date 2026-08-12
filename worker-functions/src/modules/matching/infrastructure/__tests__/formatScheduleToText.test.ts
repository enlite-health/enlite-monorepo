/**
 * formatScheduleToText.test.ts
 *
 * Deriva um texto legível em espanhol (ex: "Lunes 09:00-12:00, ...") a partir
 * do JSONB `job_postings.schedule`, usado como fallback público quando a
 * coluna legada `schedule_days_hours` está NULL (vagas novas — não vieram do
 * import ClickUp).
 *
 * Scenarios:
 *   1. Vaga real 797-2208: lun-vie 09:00-12:00, miércoles com turno extendido
 *      até 14:00, sábado/domingo 12:00-16:00 → texto ordenado lunes..domingo
 *   2. Schedule vazio (null) → null
 *   3. Schedule array vazio → null
 *   4. Schedule já normalizado (formato legado objeto por dia) → formata igual
 *   5. Formato inesperado (string solta) → null, sem crash
 *   6. Formato inesperado (número) → null, sem crash
 *   7. Formato inesperado (array de objetos sem dayOfWeek válido) → null
 *   8. Entrada com slot faltando startTime/endTime → ignora o slot inválido, mantém os válidos
 */

import { formatScheduleToText } from '../formatScheduleToText';

describe('formatScheduleToText', () => {
  it('formats the real 797-2208 schedule (lun-vie 9-12, mié extendido a 14, sáb/dom 12-16)', () => {
    const schedule = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }, // lunes
      { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' }, // martes
      { dayOfWeek: 3, startTime: '09:00', endTime: '14:00' }, // miercoles (extendido)
      { dayOfWeek: 4, startTime: '09:00', endTime: '12:00' }, // jueves
      { dayOfWeek: 5, startTime: '09:00', endTime: '12:00' }, // viernes
      { dayOfWeek: 6, startTime: '12:00', endTime: '16:00' }, // sabado
      { dayOfWeek: 0, startTime: '12:00', endTime: '16:00' }, // domingo
    ];

    expect(formatScheduleToText(schedule)).toBe(
      'Lunes 09:00-12:00, Martes 09:00-12:00, Miércoles 09:00-14:00, ' +
        'Jueves 09:00-12:00, Viernes 09:00-12:00, Sábado 12:00-16:00, Domingo 12:00-16:00',
    );
  });

  it('returns null for null schedule', () => {
    expect(formatScheduleToText(null)).toBeNull();
  });

  it('returns null for empty array schedule', () => {
    expect(formatScheduleToText([])).toBeNull();
  });

  it('formats legacy object-by-day format the same way', () => {
    const schedule = {
      lunes: [{ start: '08:00', end: '12:00' }],
      miercoles: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '17:00' }],
    };

    expect(formatScheduleToText(schedule)).toBe(
      'Lunes 08:00-12:00, Miércoles 08:00-12:00, Miércoles 14:00-17:00',
    );
  });

  it('returns null for an unexpected string payload without crashing', () => {
    expect(formatScheduleToText('not-a-schedule')).toBeNull();
  });

  it('returns null for an unexpected number payload without crashing', () => {
    expect(formatScheduleToText(42)).toBeNull();
  });

  it('returns null when array entries have no valid dayOfWeek', () => {
    const schedule = [{ dayOfWeek: 99, startTime: '09:00', endTime: '12:00' }];
    expect(formatScheduleToText(schedule)).toBeNull();
  });

  it('ignores slots missing startTime/endTime and keeps the valid ones', () => {
    const schedule = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: undefined, endTime: '12:00' },
    ];
    expect(formatScheduleToText(schedule)).toBe('Lunes 09:00-12:00');
  });
});
