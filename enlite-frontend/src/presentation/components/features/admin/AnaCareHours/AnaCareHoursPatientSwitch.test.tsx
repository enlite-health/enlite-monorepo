/**
 * Spec 032 (FR-006 / P2) — trocar de paciente sem sair do detalhe: ícone ao lado do nome + modal com
 * autocomplete. RTL com `userEvent` (click + keyboard.type); `t` devolve a chave (strings es/pt-BR
 * cobertas pela paridade de i18n). Zero GET: o componente nem recebe serviço, só as opções do retrato.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AnaCareHoursPatientSwitch } from './AnaCareHoursPatientSwitch';
import type { AnaCareListPatient } from './types';

function listPatient(anaCareId: string, name?: string): AnaCareListPatient {
  return {
    anaCareId, name, linked: false, providers: [], providersCount: 0, shiftsCount: 0, hoursActualSum: 0,
    hoursScheduledSumMissingActual: 0, validated: 0, contested: 0, originSinCheckin: 0, originWebAdmin: 0, originApp: 0,
  };
}

const PATIENTS = [listPatient('AC-PAT-0'), listPatient('AC-PAT-6'), listPatient('AC-PAT-7', 'Lucía Fernández QA')];

function setup(props: Partial<React.ComponentProps<typeof AnaCareHoursPatientSwitch>> = {}) {
  const onSelect = vi.fn();
  const user = userEvent.setup();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  render(<AnaCareHoursPatientSwitch patients={PATIENTS} currentPatientId="AC-PAT-0" onSelect={onSelect} {...props} />);
  return { onSelect, user, fetchSpy };
}

const icon = () => screen.getByTestId('anacare-hours-patient-switch-button');
const field = () => screen.getByTestId('anacare-hours-patient-switch-combobox');

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(icon());
  await user.click(field());
}

describe('AnaCareHoursPatientSwitch', () => {
  it('POSITIVO — o botão-ícone tem aria-label e title "Cambiar de paciente" (chave) e o modal começa fechado', () => {
    setup();
    expect(icon()).toHaveAttribute('aria-label', 'admin.anacareHours.detail.patientSwitchLabel');
    expect(icon()).toHaveAttribute('title', 'admin.anacareHours.detail.patientSwitchLabel');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('POSITIVO — só o ícone: <button> sem classe de borda/fundo/padding, com SVG currentColor em em, DENTRO do Heading logo após o nome', () => {
    render(<h1 data-testid="titulo">Lucía Fernández QA<AnaCareHoursPatientSwitch patients={PATIENTS} currentPatientId="AC-PAT-0" onSelect={vi.fn()} /></h1>);
    const btn = icon();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn.className).not.toMatch(/(^|\s)(border|bg-|p-|px-|py-|shadow)/);
    const svg = btn.querySelector('svg')!;
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveAttribute('width', '0.8em');
    expect(screen.getByTestId('titulo')).toContainElement(btn);
    expect(screen.getByTestId('titulo').firstChild?.textContent).toBe('Lucía Fernández QA');
    expect(screen.getByTestId('titulo').lastElementChild).toBe(btn);
  });

  it('POSITIVO — clicar no ícone abre o modal com título, ajuda e o campo', async () => {
    const { user } = setup();
    await user.click(icon());
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('admin.anacareHours.detail.patientSwitchTitle')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-patient-switch-help')).toHaveTextContent('admin.anacareHours.export.help');
    expect(field()).toBeInTheDocument();
  });

  it('POSITIVO — as opções EXCLUEM o paciente atual', async () => {
    const { user } = setup();
    await open(user);
    expect(screen.queryByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-0')).toBeNull();
    expect(screen.getByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-6')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-7')).toBeInTheDocument();
  });

  it('POSITIVO — filtra por ID do Ana Care', async () => {
    const { user } = setup();
    await open(user);
    await user.keyboard('PAT-7');
    expect(screen.getByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-7')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-6')).toBeNull();
  });

  it('POSITIVO — filtra por nome, sem acento nem maiúscula', async () => {
    const { user } = setup();
    await open(user);
    await user.keyboard('lucia fern');
    expect(screen.getByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-7')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-6')).toBeNull();
  });

  it('ALTERNATIVO — sem match mostra "Sin resultados" (chave própria) e não navega', async () => {
    const { user, onSelect } = setup();
    await open(user);
    await user.keyboard('zzzz');
    expect(screen.getByTestId('anacare-hours-patient-switch-combobox-no-match')).toHaveTextContent('admin.anacareHours.detail.patientSwitchNoMatch');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('POSITIVO — escolher um paciente chama onSelect com o ID e fecha o modal', async () => {
    const { user, onSelect } = setup();
    await open(user);
    await user.keyboard('PAT-6');
    await user.click(screen.getByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-6'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('AC-PAT-6');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ALTERNATIVO — "Cancelar" fecha sem navegar', async () => {
    const { user, onSelect } = setup();
    await user.click(icon());
    await user.click(screen.getByTestId('anacare-hours-patient-switch-cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ALTERNATIVO — Esc fecha sem navegar', async () => {
    const { user, onSelect } = setup();
    await user.click(icon());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ALTERNATIVO — retrato sem pacientes: mostra a mensagem "ainda não construído" da lista e não oferece opção', async () => {
    const { user } = setup({ patients: [] });
    await user.click(icon());
    expect(screen.getByTestId('anacare-hours-patient-switch-no-patients')).toHaveTextContent('admin.anacareHours.export.noPatients');
  });

  it('POSITIVO — zero GET: abrir, filtrar e escolher não chamam fetch', async () => {
    const { user, fetchSpy } = setup();
    await open(user);
    await user.keyboard('PAT-6');
    await user.click(screen.getByTestId('anacare-hours-patient-switch-combobox-option-AC-PAT-6'));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
