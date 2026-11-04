/**
 * ExitDestinationField — destino de quem sai do itinerário (Fase 4): 2 rádios, sem valor inicial,
 * rótulos de produto ("Sigue como reserva" / "Sale del encuadre de este servicio"), opções desabilitáveis.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
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
import { ExitDestinationField } from '../ExitDestinationField';

describe('ExitDestinationField', () => {
  it('mostra os 2 destinos com o rótulo de produto e nenhum marcado quando o valor é vazio', () => {
    render(<ExitDestinationField value="" onChange={vi.fn()} data-testid="d" />);
    expect(screen.getByText('Sigue como reserva')).toBeInTheDocument();
    expect(screen.getByText('Sale del encuadre de este servicio')).toBeInTheDocument();
    expect((screen.getByTestId('d-RESERVE') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('d-LEAVE_SERVICE') as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('escolher um rádio devolve o código do destino', () => {
    const onChange = vi.fn();
    render(<ExitDestinationField value="" onChange={onChange} data-testid="d" />);
    fireEvent.click(screen.getByTestId('d-LEAVE_SERVICE'));
    expect(onChange).toHaveBeenCalledWith('LEAVE_SERVICE');
    fireEvent.click(screen.getByTestId('d-RESERVE'));
    expect(onChange).toHaveBeenLastCalledWith('RESERVE');
  });

  it('o valor recebido marca só o rádio correspondente', () => {
    render(<ExitDestinationField value="RESERVE" onChange={vi.fn()} data-testid="d" />);
    expect((screen.getByTestId('d-RESERVE') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('d-LEAVE_SERVICE') as HTMLInputElement).checked).toBe(false);
  });

  it('disabledOptions desabilita só o destino indicado (uso da Fase 6)', () => {
    render(<ExitDestinationField value="" onChange={vi.fn()} disabledOptions={['LEAVE_SERVICE']} data-testid="d" />);
    expect(screen.getByTestId('d-LEAVE_SERVICE')).toBeDisabled();
    expect(screen.getByTestId('d-RESERVE')).toBeEnabled();
  });

  it('pt-BR: rótulos traduzidos', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<ExitDestinationField value="" onChange={vi.fn()} data-testid="d" />);
    expect(screen.getByText('Continua como reserva')).toBeInTheDocument();
    expect(screen.getByText('Sai do encuadre deste serviço')).toBeInTheDocument();
    await i18n.changeLanguage('es');
  });
});
