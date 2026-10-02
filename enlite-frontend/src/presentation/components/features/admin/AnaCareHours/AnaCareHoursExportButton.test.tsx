/**
 * Spec 032 (T2.6) — botão "Exportar" + gate de célula `anacare_hours:export`. O store de auth é o
 * REAL (nada de mock do gate): com enforcement ligado e a célula ausente o botão nasce desabilitado.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { AnaCareHoursExportButton } from './AnaCareHoursExportButton';
import type { AnaCareHoursExportService } from './AnaCareHoursExportService';

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

const service: AnaCareHoursExportService = { exportPatientRange: vi.fn(async () => undefined) };
const trigger = () => screen.getByTestId('anacare-hours-export-button');

function renderButton(props: Partial<React.ComponentProps<typeof AnaCareHoursExportButton>> = {}) {
  return render(<AnaCareHoursExportButton service={service} patients={[]} initialMonth="2026-09" {...props} />);
}

afterEach(() => {
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

describe('AnaCareHoursExportButton', () => {
  it('POSITIVO — sem enforcement (engine desligado) o botão está habilitado e abre o diálogo ao clicar', async () => {
    const user = userEvent.setup();
    renderButton();
    expect(trigger()).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(trigger());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('POSITIVO — com enforcement e a célula `anacare_hours:export`, habilita', () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:export'], 'on');
    renderButton();
    expect(trigger()).toBeEnabled();
    expect(screen.queryByTestId('anacare-hours-export-disabled-reason')).not.toBeInTheDocument();
  });

  it('NEGATIVO — com enforcement e SEM a célula: desabilitado com o motivo `export.noCell` visível, e o clique não abre nada', async () => {
    const user = userEvent.setup();
    comEnforcement(['anacare_hours:read'], 'on');
    renderButton();
    expect(trigger()).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-export-disabled-reason')).toHaveTextContent('admin.anacareHours.export.noCell');
    await user.click(trigger());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('BORDA — enforcement desligado ("off") ignora a ausência da célula', () => {
    comEnforcement([], 'off');
    renderButton();
    expect(trigger()).toBeEnabled();
  });

  it('NEGATIVO — `disabledReason` (ex.: awaitingRetrato) desabilita com o motivo visível', async () => {
    const user = userEvent.setup();
    renderButton({ disabledReason: 'Acciones deshabilitadas hasta cargar 2026-09.' });
    expect(trigger()).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-export-disabled-reason')).toHaveTextContent('Acciones deshabilitadas hasta cargar 2026-09.');
    await user.click(trigger());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('NEGATIVO — sem a célula, o motivo da célula vence o `disabledReason`', () => {
    comEnforcement([], 'on');
    renderButton({ disabledReason: 'outro motivo' });
    expect(screen.getByTestId('anacare-hours-export-disabled-reason')).toHaveTextContent('admin.anacareHours.export.noCell');
  });

  it('POSITIVO — repassa ao diálogo o paciente atual, o mês e os pacientes do retrato', async () => {
    const user = userEvent.setup();
    renderButton({ patients: [{ anaCareId: 'AC-PAT-6', linked: false, providers: [], providersCount: 0, shiftsCount: 0, hoursActualSum: 0, hoursScheduledSumMissingActual: 0, validated: 0, contested: 0, originSinCheckin: 0, originWebAdmin: 0, originApp: 0 }], initialPatientId: 'AC-PAT-0', initialMonth: '2026-08' });
    await user.click(trigger());
    expect(screen.getByTestId('anacare-hours-export-patient')).toHaveValue('Sin vínculo · ID AC-PAT-0');
    expect(screen.getByTestId('anacare-hours-export-desde')).toHaveValue('2026-08-01');
    expect(screen.getByTestId('anacare-hours-export-hasta')).toHaveValue('2026-08-31');
  });

  it('POSITIVO — Cancelar fecha o diálogo e o botão continua lá', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(trigger());
    await user.click(screen.getByTestId('anacare-hours-export-cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger()).toBeEnabled();
  });
});
