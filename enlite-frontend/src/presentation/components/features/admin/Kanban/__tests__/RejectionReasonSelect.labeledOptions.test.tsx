/**
 * RejectionReasonSelect — `labeledOptions` (Fase 2, D2): opções já rotuladas (catálogo de motivos de saída),
 * sem passar pelo i18n; o `value` é o code. Sem a prop, o comportamento de hoje (lista de chaves + i18n) fica.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { RejectionReasonSelect } from '../RejectionReasonSelect';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

describe('RejectionReasonSelect labeledOptions', () => {
  it('mostra o label do catálogo (sem tradução) e entrega o code ao confirmar', () => {
    const onSubmit = vi.fn();
    render(
      <RejectionReasonSelect
        labeledOptions={[
          { value: 'INDISPONIBILIDADE_DE_HORARIO', label: 'Sin disponibilidad horaria' },
          { value: 'abc-123', label: 'Cambio de disponibilidad' },
        ]}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rejection-option-indisponibilidade-de-horario').textContent).toContain('Sin disponibilidad horaria');
    const confirm = screen.getByTestId('rejection-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('rejection-option-abc-123'));
    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith('abc-123');
  });

  it('labeledOptions vazio: nenhuma opção e Confirmar desabilitado', () => {
    render(<RejectionReasonSelect labeledOptions={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByTestId('rejection-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });

  it('sem labeledOptions: segue a lista por chave + i18n de hoje', () => {
    render(<RejectionReasonSelect options={['OTHER']} optionKeyPrefix="admin.patients.detail.serviceTeam.revertOptions" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('rejection-option-other')).toBeTruthy();
  });
});
