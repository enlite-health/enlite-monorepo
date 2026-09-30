/**
 * RemoveFromItineraryPanel — "Quitar del itinerario" (Fase 4): Confirmar desabilitado sem motivo OU sem destino;
 * confirmar entrega (motivo, destino); erro do envio aparece e o painel continua aberto.
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});
import { RemoveFromItineraryPanel } from '../RemoveFromItineraryPanel';

vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({
    options: [
      { code: 'OTHER', label: 'Otro' },
      { code: 'DESISTENCIA_DO_PRESTADOR', label: 'Desistencia del prestador' },
    ],
    status: 'ok',
  }),
}));

function renderPanel(over: Partial<Parameters<typeof RemoveFromItineraryPanel>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<RemoveFromItineraryPanel workerLabel="Ana Fixture" onConfirm={onConfirm} onCancel={onCancel} {...over} />);
  return { onConfirm, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RemoveFromItineraryPanel', () => {
  it('abre como diálogo lateral com o testid do contrato e o nome do prestador', () => {
    renderPanel();
    expect(screen.getByTestId('itinerario-quitar-painel')).toHaveAttribute('role', 'dialog');
    expect(screen.getByTestId('itinerario-quitar-prestador')).toHaveTextContent('Prestador: Ana Fixture');
  });

  it('Confirmar fica desabilitado: sem nada, só com motivo, só com destino', () => {
    const { onConfirm } = renderPanel();
    const confirm = screen.getByTestId('itinerario-quitar-confirmar');
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: 'OTHER' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: '' } });

    fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('com motivo E destino habilita; Confirmar entrega (motivo, destino)', () => {
    const { onConfirm } = renderPanel();
    fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: 'DESISTENCIA_DO_PRESTADOR' } });
    fireEvent.click(screen.getByTestId('itinerario-quitar-destino-LEAVE_SERVICE'));
    const confirm = screen.getByTestId('itinerario-quitar-confirmar');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('DESISTENCIA_DO_PRESTADOR', 'LEAVE_SERVICE');
  });

  it('enviando (submitting) desabilita o Confirmar mesmo com os dois campos', () => {
    renderPanel({ submitting: true });
    fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
    expect(screen.getByTestId('itinerario-quitar-confirmar')).toBeDisabled();
  });

  it('errorMessage aparece como alerta; sem ele não há alerta', () => {
    renderPanel({ errorMessage: 'Este prestador tiene atenciones agendadas; cancele antes.' });
    expect(screen.getByTestId('itinerario-quitar-erro')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('itinerario-quitar-erro')).toHaveTextContent('tiene atenciones agendadas; cancele antes');
  });

  it('sem errorMessage não há alerta', () => {
    renderPanel();
    expect(screen.queryByTestId('itinerario-quitar-erro')).toBeNull();
  });
});
