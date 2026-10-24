import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DayScheduleEditor, type DayScheduleSlot } from '../index';

function Harness({ initial, spy }: { initial: DayScheduleSlot[]; spy: { last: DayScheduleSlot[] } }) {
  const [v, setV] = useState(initial);
  spy.last = v;
  return <DayScheduleEditor value={v} onChange={setV} />;
}

const mon = { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };

describe('DayScheduleEditor — copiar para dias', () => {
  it('"Copiar a… > Lun–Vie > Aplicar" marca 5 dias e entrega o payload com os dias', () => {
    const spy = { last: [] as DayScheduleSlot[] };
    render(<Harness initial={[mon]} spy={spy} />);
    fireEvent.click(screen.getByTestId('day-schedule-copy-monday'));
    fireEvent.click(screen.getByTestId('day-schedule-copy-weekdays'));
    fireEvent.click(screen.getByTestId('day-schedule-copy-apply'));
    expect(spy.last.map((s) => s.dayOfWeek).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(screen.getByTestId('day-schedule-remove-friday-0')).toBeTruthy();
    expect(screen.queryByTestId('day-schedule-remove-saturday-0')).toBeNull();
  });

  it('Aplicar fica desabilitado sem dia marcado', () => {
    render(<Harness initial={[mon]} spy={{ last: [] }} />);
    fireEvent.click(screen.getByTestId('day-schedule-copy-monday'));
    expect((screen.getByTestId('day-schedule-copy-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('destino com faixa sobreposta mantém a existente e mostra o aviso', () => {
    const spy = { last: [] as DayScheduleSlot[] };
    const existing = { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' };
    render(<Harness initial={[mon, existing]} spy={spy} />);
    fireEvent.click(screen.getByTestId('day-schedule-copy-monday'));
    fireEvent.click(screen.getByTestId('day-schedule-copy-target-tuesday'));
    fireEvent.click(screen.getByTestId('day-schedule-copy-apply'));
    expect(spy.last.filter((s) => s.dayOfWeek === 2)).toEqual([existing]);
    expect(screen.getByTestId('day-schedule-conflict-tuesday')).toBeTruthy();
  });

  it('sem faixa não há "Copiar a…"; faixa com fim <= início mostra erro inline e bloqueia a cópia', () => {
    const { rerender } = render(<DayScheduleEditor value={[]} onChange={() => {}} />);
    expect(screen.queryByTestId('day-schedule-copy-monday')).toBeNull();
    rerender(<DayScheduleEditor value={[{ dayOfWeek: 1, startTime: '17:00', endTime: '09:00' }]} onChange={() => {}} />);
    expect(screen.getByTestId('day-schedule-invalid-monday')).toBeTruthy();
    expect((screen.getByTestId('day-schedule-copy-monday') as HTMLButtonElement).disabled).toBe(true);
  });
});
