/**
 * DiagnosisChipList — spec 016 F3. REQ-21: cada chip mostra só o título, nunca URI/código.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { DiagnosisChipList } from '../DiagnosisChipList';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  return typeof current === 'string' ? current : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const ESQUIZOFRENIA_URI = 'http://id.who.int/icd/release/11/2026-01/mms/1683919430';
const CODE_6A20 = '6A20';

function chip(over: Partial<PatientDiagnosisDetail> = {}): PatientDiagnosisDetail {
  return {
    id: 'd1',
    uri: ESQUIZOFRENIA_URI,
    title: 'Esquizofrenia',
    isPrimary: false,
    source: 'PANEL',
    active: true,
    ...over,
  };
}

describe('DiagnosisChipList', () => {
  it('lista vazia: mostra a mensagem de "nenhum diagnóstico"', () => {
    render(<DiagnosisChipList diagnoses={[]} onPromote={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByTestId('diagnosis-chips-empty')).toHaveTextContent('Nenhum diagnóstico adicionado ainda.');
    expect(screen.queryByTestId('diagnosis-chips')).not.toBeInTheDocument();
  });

  it('REQ-21: mostra só o título — a URI/código NUNCA aparece no DOM', () => {
    render(<DiagnosisChipList diagnoses={[chip()]} onPromote={vi.fn()} onRemove={vi.fn()} />);
    const chipEl = screen.getByTestId('diagnosis-chip-d1');
    expect(chipEl).toHaveTextContent('Esquizofrenia');
    expect(chipEl.innerHTML).not.toContain(ESQUIZOFRENIA_URI);
    expect(chipEl.innerHTML).not.toContain(CODE_6A20);
    expect(chipEl.innerHTML).not.toContain('1683919430');
  });

  it('não-principal: mostra botão de promover, sem o badge "Principal"', () => {
    render(<DiagnosisChipList diagnoses={[chip({ isPrimary: false })]} onPromote={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByTestId('diagnosis-chip-promote-d1')).toBeInTheDocument();
    expect(screen.queryByTestId('diagnosis-chip-primary-badge-d1')).not.toBeInTheDocument();
  });

  it('principal: mostra o badge "Principal", sem o botão de promover', () => {
    render(<DiagnosisChipList diagnoses={[chip({ isPrimary: true })]} onPromote={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByTestId('diagnosis-chip-primary-badge-d1')).toHaveTextContent('Principal');
    expect(screen.queryByTestId('diagnosis-chip-promote-d1')).not.toBeInTheDocument();
  });

  it('clicar em promover chama onPromote(id)', () => {
    const onPromote = vi.fn();
    render(<DiagnosisChipList diagnoses={[chip()]} onPromote={onPromote} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('diagnosis-chip-promote-d1'));
    expect(onPromote).toHaveBeenCalledWith('d1');
  });

  it('clicar em remover chama onRemove(id)', () => {
    const onRemove = vi.fn();
    render(<DiagnosisChipList diagnoses={[chip()]} onPromote={vi.fn()} onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId('diagnosis-chip-remove-d1'));
    expect(onRemove).toHaveBeenCalledWith('d1');
  });

  it('busyId desabilita os botões daquele chip', () => {
    render(<DiagnosisChipList diagnoses={[chip()]} busyId="d1" onPromote={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByTestId('diagnosis-chip-promote-d1')).toBeDisabled();
    expect(screen.getByTestId('diagnosis-chip-remove-d1')).toBeDisabled();
  });

  it('busyId de OUTRO diagnóstico não desabilita este', () => {
    render(<DiagnosisChipList diagnoses={[chip()]} busyId="outro-id" onPromote={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByTestId('diagnosis-chip-promote-d1')).not.toBeDisabled();
    expect(screen.getByTestId('diagnosis-chip-remove-d1')).not.toBeDisabled();
  });

  it('renderiza múltiplos chips', () => {
    render(
      <DiagnosisChipList
        diagnoses={[chip({ id: 'd1', title: 'Esquizofrenia' }), chip({ id: 'd2', title: 'Trastorno esquizoafectivo', isPrimary: true })]}
        onPromote={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId('diagnosis-chip-d1')).toBeInTheDocument();
    expect(screen.getByTestId('diagnosis-chip-d2')).toBeInTheDocument();
  });
});
