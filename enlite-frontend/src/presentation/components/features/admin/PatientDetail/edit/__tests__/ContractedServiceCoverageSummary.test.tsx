/** ContractedServiceCoverageSummary — o cartão "vigente hoy" (opção A). i18n REAL (es). */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { CONTRACT_058_DEFAULTS, LINKED_058 } from '@domain/entities/__tests__/fixtures/contractedService058';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { ContractedServiceCoverageSummary } from '../ContractedServiceCoverageSummary';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson } }, interpolation: { escapeValue: false }, initImmediate: false });
});

const BASE = { id: 's1', active: true, country: 'AR' };
const LINKED = { ...BASE, ...LINKED_058 } as unknown as PatientContractedServiceDetail;
const UNLINKED = { ...BASE, ...CONTRACT_058_DEFAULTS } as unknown as PatientContractedServiceDetail;
const linkedOf = (s: PatientContractedServiceDetail) => (s.payer.state === 'LINKED' ? s.payer : null);

describe('ContractedServiceCoverageSummary', () => {
  it('vinculado: eyebrow com o asOf, obra social e contrato, vigência, selo MATCH e os pares Valor/Impuesto/Tipo', () => {
    render(<ContractedServiceCoverageSummary service={LINKED} linked={linkedOf(LINKED)} scheduled={null} actions={<button>acao</button>} />);
    expect(screen.getByText('Vigente hoy · 19/10/2026')).toBeTruthy();
    expect(screen.getByTestId('svc-payer-provider').textContent).toBe('OSDE');
    expect(screen.getByTestId('svc-payer-contract').textContent).toBe('Plan 210');
    expect(screen.getByTestId('svc-payer-validity').textContent).toBe('Desde 1/9/2026 · sin fecha de fin');
    expect(screen.getByTestId('svc-coverage-match').getAttribute('data-state')).toBe('MATCH');
    expect(screen.getByTestId('svc-coverage-match').className).toContain('text-[#14532d]');
    expect(screen.getByTestId('svc-tax').textContent).toBe('21 %');
    expect(screen.getByTestId('svc-payer-kind').textContent).toContain('Prepaga');
    expect(screen.getByText('acao')).toBeTruthy();
  });

  it('o valor monetário NUNCA quebra de linha (whitespace-nowrap)', () => {
    render(<ContractedServiceCoverageSummary service={LINKED} linked={linkedOf(LINKED)} scheduled={null} actions={null} />);
    expect(screen.getByTestId('svc-price').className).toContain('whitespace-nowrap');
    expect(screen.getByTestId('svc-price').textContent).toMatch(/1\.?500,00\s+ARS\s+\/ h/);
  });

  it('com vínculo que termina: "Desde … · hasta …"', () => {
    const s = { ...LINKED, payer: { ...LINKED.payer, validTo: '2026-12-31' } } as PatientContractedServiceDetail;
    render(<ContractedServiceCoverageSummary service={s} linked={linkedOf(s)} scheduled={null} actions={null} />);
    expect(screen.getByTestId('svc-payer-validity').textContent).toBe('Desde 1/9/2026 · hasta 31/12/2026');
  });

  it('MISMATCH usa o tom âmbar; os demais estados, o neutro', () => {
    const { rerender } = render(<ContractedServiceCoverageSummary service={{ ...LINKED, coverageMatch: { state: 'MISMATCH' } } as PatientContractedServiceDetail} linked={linkedOf(LINKED)} scheduled={null} actions={null} />);
    expect(screen.getByTestId('svc-coverage-match').className).toContain('text-[#78350f]');
    rerender(<ContractedServiceCoverageSummary service={{ ...LINKED, coverageMatch: { state: 'NO_COVERAGE' } } as PatientContractedServiceDetail} linked={linkedOf(LINKED)} scheduled={null} actions={null} />);
    expect(screen.getByTestId('svc-coverage-match').className).toContain('text-[#2c2840]');
  });

  it('sem nenhum vínculo: estado vazio, sem preço/imposto, com as ações recebidas', () => {
    render(<ContractedServiceCoverageSummary service={UNLINKED} linked={null} scheduled={null} actions={<button>vincular</button>} />);
    expect(screen.getByText('Este servicio todavía no tiene obra social ni contrato')).toBeTruthy();
    expect(screen.getByText('Hasta vincularlo no hay valor ni impuesto para este servicio.')).toBeTruthy();
    expect(screen.queryByTestId('svc-price')).toBeNull();
    expect(screen.getByText('vincular')).toBeTruthy();
  });
});
