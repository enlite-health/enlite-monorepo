/**
 * NewSubstitutionModal — o "Nuevo +" repassa ao pai o que o modo Entero escolheu (motivo e destino). i18n real (es).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { NewSubstitutionModal } from '../NewSubstitutionModal';

vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({ options: [{ code: 'OTHER', label: 'Otro' }], status: 'ok' }),
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

describe('NewSubstitutionModal', () => {
  it('Entero: confirmar chama onSubmitPermanent(serviceId, allocationId, workerId, fromDate, motivo, destino)', async () => {
    const onSubmitPermanent = vi.fn();
    const loadOptions = vi.fn().mockResolvedValue({ status: 'ok', options: [{ workerId: 'w-sel-1', displayName: 'Dana Fixture', vacancyId: null }] });
    render(
      <NewSubstitutionModal
        services={[{ serviceId: 'svc-1', label: 'AT', allocations: [{ allocationId: 'alloc-1', weekday: 1, startTime: '08:00', endTime: '10:00' }] }]}
        asOf="2026-09-28"
        loadOptions={loadOptions}
        onSubmitComplementary={vi.fn()}
        onSubmitPermanent={onSubmitPermanent}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(loadOptions).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('substitution-mode-permanent'));
    fireEvent.click(screen.getByTestId('substitution-worker'));
    fireEvent.click(within(await screen.findByRole('listbox')).getByText('Dana Fixture'));
    fireEvent.change(screen.getByTestId('substitution-reason'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('substitution-destination-RESERVE'));
    fireEvent.click(screen.getByTestId('substitution-confirm'));
    expect(onSubmitPermanent).toHaveBeenCalledWith('svc-1', 'alloc-1', 'w-sel-1', '2026-09-28', 'OTHER', 'RESERVE');
  });
});
