import { describe, it, expect } from 'vitest';
import { contractedServiceScheduleText } from '../contractedServiceScheduleText';

describe('contractedServiceScheduleText — o MESMO texto que a vaga mostra', () => {
  it('null / [] → null (quem chama decide o rótulo por i18n)', () => {
    expect(contractedServiceScheduleText(null)).toBeNull();
    expect(contractedServiceScheduleText([])).toBeNull();
  });

  it('agrupa dias com a mesma faixa, como a vaga', () => {
    expect(contractedServiceScheduleText([
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 5, startTime: '14:00', endTime: '18:00' },
    ])).toBe('Lunes, Miércoles 08:00-12:00 | Viernes 14:00-18:00');
  });

  it('slot sem hora (dado corrompido) serializa vazio → null, nunca string vazia na tela', () => {
    expect(contractedServiceScheduleText([{ dayOfWeek: 1, startTime: '', endTime: '' }])).toBeNull();
  });
});
