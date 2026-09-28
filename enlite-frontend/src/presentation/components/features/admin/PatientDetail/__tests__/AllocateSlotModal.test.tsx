/**
 * AllocateSlotModal — Fase 12, DX-12.10b. A escolha do prestador para um slot: SÓ as `options`
 * recebidas (as de `allocation-options`), vazio dito, confirmar travado sem escolha. i18n real (es).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { AllocateSlotModal } from '../AllocateSlotModal';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const SLOT = { weekday: 1, startTime: '08:00', endTime: '12:00' };

const OPTIONS: ServiceTeamMember[] = [
  { workerId: 'w-opt-0001', displayName: 'Dana Fixture', vacancyId: 'vac-1' },
  { workerId: 'w-opt-bbbb2222', displayName: null, vacancyId: 'vac-1' },
];

function renderModal(options: ServiceTeamMember[] | null = OPTIONS) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(<AllocateSlotModal slot={SLOT} options={options} onSubmit={onSubmit} onCancel={onCancel} />);
  return { ...utils, onSubmit, onCancel };
}

/** O `SearchableSelect` sempre desenha 1ª linha = placeholder (valor vazio); as opções vêm depois. */
function listedLabels(): string[] {
  const items = within(screen.getByRole('listbox')).getAllByRole('option');
  return items.slice(1).map((li) => li.textContent ?? '');
}

describe('AllocateSlotModal — escolher o prestador do slot', () => {
  it('título com dia e horário do slot', () => {
    renderModal();
    expect(screen.getByTestId('itinerario-alocar-modal')).toHaveTextContent('Asignar prestador · lunes 08:00 - 12:00');
  });

  it('a lista é exatamente as options (2 → 2 itens), sem nome → "Prestador sin nombre"', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();
    await user.click(screen.getByTestId('itinerario-alocar-prestador'));
    expect(listedLabels()).toEqual(['Dana Fixture', 'Prestador sin nombre · bbbb2222']);
    expect(screen.queryByTestId('searchable-select-empty')).toBeNull();
  });

  it('0 options → a mensagem "No hay prestadores en Seleccionado"', async () => {
    const user = userEvent.setup({ delay: null });
    renderModal([]);
    await user.click(screen.getByTestId('itinerario-alocar-prestador'));
    expect(listedLabels()).toEqual([]);
    expect(screen.getByTestId('searchable-select-empty')).toHaveTextContent(
      'No hay prestadores en Seleccionado para este servicio.',
    );
  });

  it('options null (carregando) → o seletor fica desabilitado', () => {
    renderModal(null);
    expect(screen.getByTestId('itinerario-alocar-prestador')).toBeDisabled();
  });

  it('confirmar desabilitado sem escolha; escolher + confirmar → onSubmit(workerId) 1×', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = renderModal();
    const confirm = screen.getByTestId('itinerario-alocar-confirmar');
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('itinerario-alocar-prestador'));
    await user.keyboard('Dana');
    await user.click(screen.getByRole('option', { name: 'Dana Fixture' }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('w-opt-0001');
  });

  it('cancelar → onCancel, sem onSubmit', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit, onCancel } = renderModal();
    await user.click(screen.getByTestId('itinerario-alocar-cancelar'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('o painel é organisms/Card (rounded-2xl do átomo) e o modal não traz cor literal', () => {
    renderModal();
    const overlay = screen.getByTestId('itinerario-alocar-modal');
    const panel = overlay.firstElementChild as HTMLElement;
    expect(panel.className).toContain('rounded-2xl');
    expect(panel.className).toContain('bg-white');
    // Régua só nos elementos DESTE arquivo (overlay, painel, título, botões) — o `SearchableSelect`
    // (molécula intocável do DS) tem cor literal própria, pré-existente.
    const own = [overlay, panel, screen.getByRole('heading'), screen.getByTestId('itinerario-alocar-cancelar'), screen.getByTestId('itinerario-alocar-confirmar')];
    const classes = own.map((el) => el.getAttribute('class') ?? '');
    expect(classes.filter((c) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(c))).toEqual([]);
  });
});
