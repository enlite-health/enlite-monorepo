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

// Catálogo de motivos de saída (Fase 2): o diálogo de motivo lê `useServiceExitReasonOptions`; aqui um catálogo fixo.
vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({
    options: [
      { code: 'OTHER', label: 'Otro' },
      { code: 'NOVO_DO_ADMIN', label: 'Cambio de disponibilidad' },
    ],
    status: 'ok',
  }),
}));


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

function reasonSelect(): HTMLSelectElement {
  return screen.getByTestId('substitution-reason') as HTMLSelectElement;
}

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
    expect(confirm.disabled).toBe(true); // ainda falta o motivo (Fase 2)

    fireEvent.change(reasonSelect(), { target: { value: 'OTHER' } });
    expect(confirm.disabled).toBe(false);
  });

  it('motivo: lista os motivos do catálogo; sem motivo, Confirmar fica desabilitado e onSubmit não sai', () => {
    const onSubmit = vi.fn();
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const values = Array.from(reasonSelect().options).map((o) => o.value).filter(Boolean);
    expect(values).toEqual(['OTHER', 'NOVO_DO_ADMIN']);
    fireEvent.change(dateSelect(), { target: { value: nextDatesOfWeekday(ASOF, 1, 8)[0] } });
    const confirm = screen.getByTestId('substitution-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('modo Entero mostra o campo de motivo e o de destino', () => {
    render(
      <SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onSubmitPermanent={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('substitution-reason')).toBeTruthy();
    expect(screen.queryByTestId('substitution-destination')).toBeNull();
    fireEvent.click(screen.getByTestId('substitution-mode-permanent'));
    expect(screen.getByTestId('substitution-reason')).toBeTruthy();
    expect(screen.getByTestId('substitution-destination')).toBeTruthy();
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
    fireEvent.change(reasonSelect(), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('substitution-confirm'));
    expect(onSubmit).toHaveBeenCalledWith('alloc-1', firstDate, null, 'OTHER');
  });

  it('escolher um substituto e confirmar chama onSubmit com o workerId', () => {
    const onSubmit = vi.fn();
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const firstDate = nextDatesOfWeekday(ASOF, 1, 8)[0];
    fireEvent.change(dateSelect(), { target: { value: firstDate } });

    fireEvent.click(screen.getByTestId('substitution-worker'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));
    fireEvent.change(reasonSelect(), { target: { value: 'NOVO_DO_ADMIN' } });

    fireEvent.click(screen.getByTestId('substitution-confirm'));
    expect(onSubmit).toHaveBeenCalledWith('alloc-1', firstDate, 'w-sel-1', 'NOVO_DO_ADMIN');
  });

  it('"substitution-cancel" chama onCancel', () => {
    const onCancel = vi.fn();
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('substitution-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('aviso Ana Care sempre visível (padrão D445)', () => {
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('substitution-anacare-notice')).toBeTruthy();
  });

  it('sem onSubmitPermanent: nenhum toggle de modo aparece (comportamento intocado do ServiceTeamBoard)', () => {
    render(<SubstitutionDayModal allocations={ONE_SLOT} selected={SELECTED} asOf={ASOF} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('substitution-mode')).toBeNull();
  });
});

describe('SubstitutionDayModal — modo Entero (D445.5, reemplazo permanente)', () => {
  it('com onSubmitPermanent: o toggle aparece, começa em Complementar', () => {
    render(
      <SubstitutionDayModal
        allocations={ONE_SLOT}
        selected={SELECTED}
        asOf={ASOF}
        onSubmit={vi.fn()}
        onSubmitPermanent={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((screen.getByTestId('substitution-mode-complementary') as HTMLInputElement).checked).toBe(true);
  });

  it('no modo Entero, "sin reemplazo" some da lista de substitutos', () => {
    render(
      <SubstitutionDayModal
        allocations={ONE_SLOT}
        selected={SELECTED}
        asOf={ASOF}
        onSubmit={vi.fn()}
        onSubmitPermanent={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('substitution-mode-permanent'));
    fireEvent.click(screen.getByTestId('substitution-worker'));
    const listbox = within(screen.getByRole('listbox'));
    expect(listbox.queryByText('Sin reemplazo (día sin cobertura)')).toBeNull();
    expect(listbox.getByText('Dana Fixture')).toBeTruthy();
  });

  it('confirmar no modo Entero chama onSubmitPermanent(allocationId, workerId, fromDate, motivo, destino)', () => {
    const onSubmit = vi.fn();
    const onSubmitPermanent = vi.fn();
    render(
      <SubstitutionDayModal
        allocations={ONE_SLOT}
        selected={SELECTED}
        asOf={ASOF}
        onSubmit={onSubmit}
        onSubmitPermanent={onSubmitPermanent}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('substitution-mode-permanent'));

    fireEvent.click(screen.getByTestId('substitution-worker'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));
    fireEvent.change(reasonSelect(), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('substitution-destination-RESERVE'));

    fireEvent.click(screen.getByTestId('substitution-confirm'));
    expect(onSubmitPermanent).toHaveBeenCalledWith('alloc-1', 'w-sel-1', ASOF, 'OTHER', 'RESERVE');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('modo Entero sem substituto escolhido: confirmar fica desabilitado', () => {
    render(
      <SubstitutionDayModal
        allocations={ONE_SLOT}
        selected={SELECTED}
        asOf={ASOF}
        onSubmit={vi.fn()}
        onSubmitPermanent={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('substitution-mode-permanent'));
    expect((screen.getByTestId('substitution-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  function renderPermanent(onSubmitPermanent = vi.fn()) {
    render(
      <SubstitutionDayModal
        allocations={ONE_SLOT}
        selected={SELECTED}
        asOf={ASOF}
        onSubmit={vi.fn()}
        onSubmitPermanent={onSubmitPermanent}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('substitution-mode-permanent'));
    return onSubmitPermanent;
  }

  it('Entero: o select de data do modo complementar não aparece; aparecem "Ahora" e "Programada"', () => {
    renderPermanent();
    expect(screen.queryByTestId('substitution-date')).toBeNull();
    expect(screen.getByTestId('substitution-start-now')).toBeChecked();
    expect(screen.getByTestId('substitution-start')).toHaveTextContent('Ahora');
    expect(screen.getByTestId('substitution-start')).toHaveTextContent('Programada');
    expect(screen.queryByTestId('substitution-start-date')).toBeNull();
  });

  it('Programada exige data posterior a hoje: sem data ou com a data de hoje o Confirmar fica desabilitado; com amanhã habilita e envia essa data', () => {
    const onSubmitPermanent = renderPermanent();
    fireEvent.click(screen.getByTestId('substitution-worker'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));
    const confirm = screen.getByTestId('substitution-confirm') as HTMLButtonElement;
    fireEvent.click(screen.getByTestId('substitution-start-scheduled'));
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('substitution-start-date'), { target: { value: ASOF } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('substitution-start-date'), { target: { value: '2026-09-29' } });
    fireEvent.change(reasonSelect(), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('substitution-destination-RESERVE'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onSubmitPermanent).toHaveBeenCalledWith('alloc-1', 'w-sel-1', '2026-09-29', 'OTHER', 'RESERVE');
  });

  it('Entero: sem motivo ou sem destino o Confirmar fica desabilitado', () => {
    renderPermanent();
    fireEvent.click(screen.getByTestId('substitution-worker'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));
    const confirm = screen.getByTestId('substitution-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(reasonSelect(), { target: { value: 'OTHER' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('substitution-destination-RESERVE'));
    expect(confirm.disabled).toBe(false);
  });

  it('Programada: LEAVE_SERVICE fica desabilitado e a frase da reserva aparece com a data; Ahora: LEAVE_SERVICE habilitado', () => {
    renderPermanent();
    expect(screen.getByTestId('substitution-destination-LEAVE_SERVICE')).not.toBeDisabled();
    expect(screen.queryByTestId('substitution-reserve-only')).toBeNull();
    fireEvent.click(screen.getByTestId('substitution-start-scheduled'));
    fireEvent.change(screen.getByTestId('substitution-start-date'), { target: { value: '2026-09-29' } });
    expect(screen.getByTestId('substitution-destination-LEAVE_SERVICE')).toBeDisabled();
    expect(screen.getByTestId('substitution-reserve-only')).toHaveTextContent('desde el 29/09');
    fireEvent.click(screen.getByTestId('substitution-start-now'));
    expect(screen.getByTestId('substitution-destination-LEAVE_SERVICE')).not.toBeDisabled();
  });

  it('trocar para Programada com LEAVE_SERVICE já escolhido limpa o destino', () => {
    renderPermanent();
    fireEvent.click(screen.getByTestId('substitution-destination-LEAVE_SERVICE'));
    expect(screen.getByTestId('substitution-destination-LEAVE_SERVICE')).toBeChecked();
    fireEvent.click(screen.getByTestId('substitution-start-scheduled'));
    expect(screen.getByTestId('substitution-destination-LEAVE_SERVICE')).not.toBeChecked();
    expect(screen.getByTestId('substitution-destination-RESERVE')).not.toBeChecked();
  });
});
