import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from './i18nSetup';
import { ConflictBadge, ConflictNote, type ConflictBadgeState } from '../ConflictParts';

beforeAll(async () => {
  await initI18n('es');
});

describe('ConflictParts', () => {
  it.each([
    ['free', 'Libre'],
    ['conflict', 'Conflicto'],
    ['unknown', 'No se pudo verificar'],
    ['checking', 'Verificando…'],
  ] as Array<[ConflictBadgeState, string]>)('o estado %s tem o texto "%s" (a cor nunca é o único sinal)', (state, text) => {
    render(<ConflictBadge state={state} testId="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent(text);
    expect(screen.getByTestId('b')).toHaveAttribute('data-state', state);
  });

  it('a nota do conflito leva o nome, o dia e o horário que colide (início + duração); sem detalhe de horário não desenha nada', () => {
    const conflict = { workerId: 'w', date: '2026-11-09', slotId: 's', state: 'conflict' as const, overlaps: [{ weekday: 1, startTime: '10:00', durationMinutes: 240, sameAddress: true }] };
    const a = render(<ConflictNote conflict={conflict} name="Martín Gómez" testId="n" />);
    expect(screen.getByTestId('n')).toHaveTextContent('Martín ya atiende a otro paciente el lunes de 10:00 a 14:00.');
    expect(screen.getByTestId('n')).toHaveAttribute('role', 'alert');
    a.unmount();
    const { container } = render(<ConflictNote conflict={{ ...conflict, overlaps: [] }} name="Martín Gómez" testId="n" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('conflito com turno de 24 h diz todo el día', () => {
    const conflict = { workerId: 'w', date: '2026-11-09', slotId: 's', state: 'conflict' as const, overlaps: [{ weekday: 1, startTime: '08:00', durationMinutes: 1440, sameAddress: true }] };
    render(<ConflictNote conflict={conflict} name="Martín Gómez" testId="n" />);
    expect(screen.getByTestId('n')).toHaveTextContent('Martín ya atiende a otro paciente el lunes todo el día.');
    expect(screen.getByTestId('n')).not.toHaveTextContent('de 08:00 a 08:00');
  });
});
