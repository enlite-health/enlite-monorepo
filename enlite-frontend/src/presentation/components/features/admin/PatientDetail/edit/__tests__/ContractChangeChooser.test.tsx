/** ContractChangeChooser — "¿Qué pasó con la cobertura?": radios de cartão inteiro, só as respostas permitidas. i18n REAL (es). */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ContractChangeChooser, type ChangeAnswer } from '../ContractChangeChooser';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson } }, interpolation: { escapeValue: false }, initImmediate: false });
});

const ALL: ChangeAnswer[] = ['switch', 'correct', 'end', 'newService'];

describe('ContractChangeChooser', () => {
  it('mostra a pergunta e SÓ as respostas recebidas, cada uma com título + subtítulo', () => {
    render(<ContractChangeChooser answers={['correct', 'end']} selected={null} providerName="OSDE" onChoose={vi.fn()} />);
    expect(screen.getByRole('radiogroup').getAttribute('aria-labelledby')).toBe('svc-contract-chooser-title');
    expect(screen.getByText('¿Qué pasó con la cobertura?')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByTestId('svc-contract-switch-open')).toBeNull();
    expect(screen.getByTestId('svc-contract-correct-open').textContent).toContain('Se cargó mal');
    expect(screen.getByTestId('svc-contract-correct-open').textContent).toContain('Única forma de cambiar una obra social cargada por error.');
  });

  it('o título da 1ª resposta leva o nome da obra social do vínculo', () => {
    render(<ContractChangeChooser answers={ALL} selected={null} providerName="Galeno" onChoose={vi.fn()} />);
    expect(screen.getByTestId('svc-contract-switch-open').textContent).toContain('Cambió el contrato, sigue Galeno');
  });

  it('clicar no cartão inteiro chama onChoose com a resposta; só a escolhida fica aria-checked', () => {
    const onChoose = vi.fn();
    const { rerender } = render(<ContractChangeChooser answers={ALL} selected={null} providerName="OSDE" onChoose={onChoose} />);
    fireEvent.click(screen.getByText('Terminó la cobertura'));
    expect(onChoose).toHaveBeenCalledWith('end');
    rerender(<ContractChangeChooser answers={ALL} selected="end" providerName="OSDE" onChoose={onChoose} />);
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
  });

  it('disabled: nenhuma resposta dispara', () => {
    const onChoose = vi.fn();
    render(<ContractChangeChooser answers={ALL} selected={null} providerName="OSDE" onChoose={onChoose} disabled />);
    fireEvent.click(screen.getByTestId('svc-contract-new-service'));
    expect(onChoose).not.toHaveBeenCalled();
  });
});
