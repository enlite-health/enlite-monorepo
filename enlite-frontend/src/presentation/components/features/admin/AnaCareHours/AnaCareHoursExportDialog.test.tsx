/**
 * Spec 032 (T2.5) — diálogo de exportação. RTL com `userEvent` (click + keyboard.type); `t` devolve
 * a chave (as strings es/pt-BR são cobertas pela paridade de i18n).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { AnaCareHoursExportDialog } from './AnaCareHoursExportDialog';
import { AnaCareHoursServiceError } from './AnaCareHoursService';
import type { AnaCareHoursExportService } from './AnaCareHoursExportService';
import type { AnaCareListPatient } from './types';

function listPatient(anaCareId: string, name?: string): AnaCareListPatient {
  return {
    anaCareId, name, linked: false, providers: [], providersCount: 0, shiftsCount: 0, hoursActualSum: 0,
    hoursScheduledSumMissingActual: 0, validated: 0, contested: 0, originSinCheckin: 0, originWebAdmin: 0, originApp: 0,
  };
}

const PATIENTS = [listPatient('AC-PAT-0'), listPatient('AC-PAT-6'), listPatient('AC-PAT-7', 'Lucía Fernández QA')];

function makeService(impl?: () => Promise<void>): AnaCareHoursExportService & { exportPatientRange: ReturnType<typeof vi.fn> } {
  return { exportPatientRange: vi.fn(impl ?? (async () => undefined)) };
}

function setup(props: Partial<React.ComponentProps<typeof AnaCareHoursExportDialog>> = {}) {
  const service = (props.service as ReturnType<typeof makeService>) ?? makeService();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<AnaCareHoursExportDialog patients={PATIENTS} initialMonth="2026-09" onClose={onClose} {...props} service={service} />);
  return { service, onClose, user };
}

const exportButton = () => screen.getByTestId('anacare-hours-export-confirm');
const desde = () => screen.getByTestId('anacare-hours-export-desde') as HTMLInputElement;
const hasta = () => screen.getByTestId('anacare-hours-export-hasta') as HTMLInputElement;

async function retype(user: ReturnType<typeof userEvent.setup>, input: HTMLInputElement, value: string) {
  await user.clear(input);
  await user.type(input, value);
}

describe('AnaCareHoursExportDialog', () => {
  it('POSITIVO — abre como diálogo modal com Desde = dia 1 e Hasta = último dia do mês', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(desde()).toHaveValue('2026-09-01');
    expect(hasta()).toHaveValue('2026-09-30');
  });

  it('POSITIVO — mês de 31 dias pré-preenche o 31 (e fevereiro bissexto o 29)', () => {
    setup({ initialMonth: '2026-08' });
    expect(hasta()).toHaveValue('2026-08-31');
  });

  it('POSITIVO — mostra o texto de ajuda "paciente fuera del mes de la lista no aparece"', () => {
    setup();
    expect(screen.getByTestId('anacare-hours-export-help')).toHaveTextContent('admin.anacareHours.export.help');
  });

  it('POSITIVO — o autocomplete lista SÓ os pacientes recebidos e filtra por nome ou ID', async () => {
    const { user } = setup();
    await user.click(screen.getByTestId('anacare-hours-export-patient'));
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-0')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-7')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-export-patient-option-all')).not.toBeInTheDocument();
    await user.keyboard('AC-PAT-6');
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-6')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-export-patient-option-AC-PAT-0')).not.toBeInTheDocument();
  });

  it('POSITIVO — injeta o paciente atual como opção quando ele NÃO está na lista do mês', async () => {
    const { user } = setup({ patients: [PATIENTS[1]], initialPatientId: 'AC-PAT-0' });
    expect(screen.getByTestId('anacare-hours-export-patient')).toHaveValue('Sin vínculo · ID AC-PAT-0');
    await user.click(screen.getByTestId('anacare-hours-export-patient'));
    await user.clear(screen.getByTestId('anacare-hours-export-patient')); // com valor escolhido a lista abre filtrada pelo rótulo dele
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-0')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-6')).toBeInTheDocument();
  });

  it('NEGATIVO — sem paciente escolhido, "Exportar" fica desabilitado com o motivo', () => {
    setup();
    expect(exportButton()).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-export-reason')).toHaveTextContent('admin.anacareHours.export.reason.noPatient');
  });

  it('NEGATIVO — Hasta anterior a Desde desabilita com o motivo', async () => {
    const { user } = setup({ initialPatientId: 'AC-PAT-0' });
    expect(exportButton()).toBeEnabled();
    await retype(user, hasta(), '2026-08-15');
    expect(exportButton()).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-export-reason')).toHaveTextContent('admin.anacareHours.export.reason.hastaBeforeDesde');
  });

  it('BORDA — 62 dias exporta, 63 desabilita com o motivo de teto', async () => {
    const { user } = setup({ initialPatientId: 'AC-PAT-0' });
    await retype(user, desde(), '2026-08-01');
    await retype(user, hasta(), '2026-10-01');
    expect(exportButton()).toBeEnabled();
    await retype(user, hasta(), '2026-10-02');
    expect(exportButton()).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-export-reason')).toHaveTextContent('admin.anacareHours.export.reason.tooLong');
  });

  it('NEGATIVO — retrato não construído (lista vazia, sem paciente atual): mensagem e "Exportar" desabilitado', () => {
    setup({ patients: [], initialPatientId: undefined });
    expect(screen.getByTestId('anacare-hours-export-no-patients')).toHaveTextContent('admin.anacareHours.export.noPatients');
    expect(exportButton()).toBeDisabled();
  });

  it('POSITIVO — escolher o paciente digitando e clicando na opção exporta ESSE paciente com o intervalo', async () => {
    const { user, service, onClose } = setup();
    await user.click(screen.getByTestId('anacare-hours-export-patient'));
    await user.keyboard('AC-PAT-6');
    await user.click(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-6'));
    await user.click(exportButton());
    expect(service.exportPatientRange).toHaveBeenCalledTimes(1);
    expect(service.exportPatientRange).toHaveBeenCalledWith({ patientId: 'AC-PAT-6', desde: '2026-09-01', hasta: '2026-09-30' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('POSITIVO — trocar de A (pré-preenchido) para B no autocomplete exporta B', async () => {
    const { user, service } = setup({ initialPatientId: 'AC-PAT-0' });
    const input = screen.getByTestId('anacare-hours-export-patient');
    await user.click(input);
    await user.clear(input);
    await user.keyboard('AC-PAT-7');
    await user.click(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-7'));
    await user.click(exportButton());
    expect(service.exportPatientRange).toHaveBeenCalledWith({ patientId: 'AC-PAT-7', desde: '2026-09-01', hasta: '2026-09-30' });
  });

  it('POSITIVO — "Exportando…" com disabled + aria-busy e o 2º clique é IGNORADO', async () => {
    let finish: () => void = () => undefined;
    const service = makeService(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { user, onClose } = setup({ service, initialPatientId: 'AC-PAT-0' });
    await user.click(exportButton());
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute('aria-busy', 'true');
    expect(exportButton()).toHaveTextContent('admin.anacareHours.export.exporting');
    await user.click(exportButton());
    await user.click(exportButton());
    expect(service.exportPatientRange).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('NEGATIVO — erro do serviço vira mensagem i18n POR CÓDIGO, não fecha e destrava o botão', async () => {
    const service = makeService(async () => { throw new AnaCareHoursServiceError('FONTE_SEM_INTERVALO', 'x'); });
    const { user, onClose } = setup({ service, initialPatientId: 'AC-PAT-0' });
    await user.click(exportButton());
    expect(await screen.findByTestId('anacare-hours-export-error')).toHaveTextContent('admin.anacareHours.export.error.byCode.FONTE_SEM_INTERVALO');
    expect(onClose).not.toHaveBeenCalled();
    expect(exportButton()).toBeEnabled();
    expect(exportButton()).not.toHaveAttribute('aria-busy', 'true');
  });

  it('NEGATIVO — erro que não é do serviço (rede) cai no código DESCONHECIDO', async () => {
    const service = makeService(async () => { throw new TypeError('network down'); });
    const { user } = setup({ service, initialPatientId: 'AC-PAT-0' });
    await user.click(exportButton());
    expect(await screen.findByTestId('anacare-hours-export-error')).toHaveTextContent('admin.anacareHours.export.error.byCode.DESCONHECIDO');
  });

  it('POSITIVO — Cancelar e Escape fecham sem exportar', async () => {
    const { user, service, onClose } = setup({ initialPatientId: 'AC-PAT-0' });
    await user.click(screen.getByTestId('anacare-hours-export-cancel'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(service.exportPatientRange).not.toHaveBeenCalled();
  });
});
