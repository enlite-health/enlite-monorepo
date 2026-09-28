/**
 * SubstitutionDayModal.test.tsx — Fase 13, DX-13.13. Modal "Sustituir un día": faixa → data →
 * substituto, em cascata. Molde de i18n real: `ServiceTeamBoard.test.tsx`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { SubstitutionDayModal } from '../SubstitutionDayModal';
import { nextDatesOfWeekday } from '../substitutionDates';
import type { ServiceTeamAllocation, ServiceTeamMember } from '@domain/entities/ServiceTeam';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const ASOF = '2026-09-28';

const ONE_SLOT: ServiceTeamAllocation[] = [{ allocationId: 'alloc-1', weekday: 1, startTime: '08:00', endTime: '10:00' }];

const TWO_SLOTS: ServiceTeamAllocation[] = [
  { allocationId: 'alloc-1', weekday: 1, startTime: '08:00', endTime: '10:00' },
  { allocationId: 'alloc-2', weekday: 3, startTime: '14:00', endTime: '16:00' },
];

const SELECTED: ServiceTeamMember[] = [
  { workerId: 'w-sel-1', displayName: 'Dana Fixture', vacancyId: null },
  { workerId: 'w-sel-2', displayName: 'Elio Fixture', vacancyId: null },
];

function slotSelect(): HTMLSelectElement {
  return screen.getByTestId('substitution-slot') as HTMLSelectElement;
}
function dateSelect(): HTMLSelectElement {
  return screen.getByTestId('substitution-date') as HTMLSelectElement;
}
function dateOptionValues(): string[] {
  return Array.from(dateSelect().querySelectorAll('option'))
    .map((o) => o.getAttribute('value'))
    .filter((v): v is string => Boolean(v));
}

describe('SubstitutionDayModal — faixa, data e substituto em cascata', () => {
  it('1 faixa: já vem pré-selecionada', () => {
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(slotSelect().value).toBe('alloc-1');
  });

  it('2 faixas: confirmar desabilitado até escolher faixa e data', () => {
    render(<SubstitutionDayModal allocations={TWO_SLOTS} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(slotSelect().value).toBe('');
    const confirm = screen.getByTestId('substitution-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(slotSelect(), { target: { value: 'alloc-1' } });
    expect(confirm.disabled).toBe(true); // ainda falta a data

    fireEvent.change(dateSelect(), { target: { value: nextDatesOfWeekday(ASOF, 1, 8)[0] } });
    expect(confirm.disabled).toBe(false);
  });

  it('as 8 datas do Select batem com nextDatesOfWeekday', () => {
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(dateOptionValues()).toEqual(nextDatesOfWeekday(ASOF, 1, 8));
  });

  it('trocar a faixa troca as datas oferecidas', () => {
    render(<SubstitutionDayModal allocations={TWO_SLOTS} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(slotSelect(), { target: { value: 'alloc-1' } });
    const firstDates = dateOptionValues();
    expect(firstDates).toEqual(nextDatesOfWeekday(ASOF, 1, 8));

    fireEvent.change(slotSelect(), { target: { value: 'alloc-2' } });
    const secondDates = dateOptionValues();
    expect(secondDates).toEqual(nextDatesOfWeekday(ASOF, 3, 8));
    expect(secondDates).not.toEqual(firstDates);
  });

  it('o SearchableSelect lista SÓ os `selected` + "sin reemplazo"', () => {
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('substitution-worker'));

    const listbox = within(screen.getByRole('listbox'));
    expect(listbox.getByText('Dana Fixture')).toBeTruthy();
    expect(listbox.getByText('Elio Fixture')).toBeTruthy();
    expect(listbox.getByText('Sin reemplazo (día sin cobertura)')).toBeTruthy();
    // 2 `selected` + "sin reemplazo" + o "Todos" nativo do SearchableSelect (fora do escopo — o
    // átomo sempre o renderiza; a régua é que NENHUM outro nome apareça).
    expect(listbox.getAllByRole('option').length).toBe(4);
  });

  it('confirmar chama onSubmit com `null` quando "sin reemplazo" (padrão)', () => {
    const onSubmit = vi.fn();
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const firstDate = nextDatesOfWeekday(ASOF, 1, 8)[0];
    fireEvent.change(dateSelect(), { target: { value: firstDate } });
    fireEvent.click(screen.getByTestId('substitution-confirm'));
    expect(onSubmit).toHaveBeenCalledWith('alloc-1', firstDate, null);
  });

  it('escolher um substituto e confirmar chama onSubmit com o workerId', () => {
    const onSubmit = vi.fn();
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const firstDate = nextDatesOfWeekday(ASOF, 1, 8)[0];
    fireEvent.change(dateSelect(), { target: { value: firstDate } });

    fireEvent.click(screen.getByTestId('substitution-worker'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));

    fireEvent.click(screen.getByTestId('substitution-confirm'));
    expect(onSubmit).toHaveBeenCalledWith('alloc-1', firstDate, 'w-sel-1');
  });

  it('"substitution-cancel" chama onCancel', () => {
    const onCancel = vi.fn();
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('substitution-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
