/**
 * ExitReasonSelect — campo de motivo de uma troca (Fase 2). Lê o catálogo por `useServiceExitReasonOptions`
 * (mockado); o valor é o `code`; falha do GET mostra aviso; lista ausente (null) não derruba a tela.
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { chooseCombo, comboLabels } from '@presentation/components/atoms/Combobox/testUtils';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { ExitReasonSelect } from '../ExitReasonSelect';

const mockHook = vi.fn();
vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({ useServiceExitReasonOptions: () => mockHook() }));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => mockHook.mockReset());

describe('ExitReasonSelect', () => {
  it('lista os motivos do catálogo (value = code, texto = label) e devolve o code escolhido', () => {
    mockHook.mockReturnValue({
      options: [
        { code: 'OTHER', label: 'Otro' },
        { code: 'abc-123', label: 'Cambio de disponibilidad' },
      ],
      status: 'ok',
    });
    const onChange = vi.fn();
    render(<ExitReasonSelect value="" onChange={onChange} data-testid="r" />);
    const select = screen.getByTestId('r');
    expect(select).toHaveTextContent('Motivo del cambio'); // placeholder
    expect(comboLabels(select)).toEqual(['Otro', 'Cambio de disponibilidad']);
    chooseCombo(select, 'Cambio de disponibilidad'); // abc-123
    expect(onChange).toHaveBeenCalledWith('abc-123');
    expect(screen.queryByTestId('r-erro')).toBeNull();
  });

  it('GET falhou: aviso visível e nenhuma opção (quem usa mantém Confirmar desabilitado)', () => {
    mockHook.mockReturnValue({ options: [], status: 'error' });
    render(<ExitReasonSelect value="" onChange={vi.fn()} data-testid="r" />);
    expect(screen.getByTestId('r-erro').textContent).toContain('No se pudieron cargar los motivos');
    expect(comboLabels(screen.getByTestId('r'))).toEqual([]);
  });

  it('options null/undefined (resposta sem a lista) não quebra a tela', () => {
    mockHook.mockReturnValue({ options: null, status: 'ok' });
    render(<ExitReasonSelect value="" onChange={vi.fn()} data-testid="r" />);
    expect(comboLabels(screen.getByTestId('r'))).toEqual([]);
  });
});
