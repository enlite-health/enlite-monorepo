/**
 * CoverageMatchNotice — os 6 estados da divergência pagador × cobertura + REDACTED (spec 058 §D, §4.5).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { COVERAGE_MATCH_STATES } from '@domain/entities/PatientContractedService';
import { CoverageMatchNotice } from '../CoverageMatchNotice';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson } }, interpolation: { escapeValue: false }, initImmediate: false });
});

describe('CoverageMatchNotice', () => {
  it.each(COVERAGE_MATCH_STATES)('estado %s: frase traduzida (não o enum cru) e data-state', (state) => {
    render(<CoverageMatchNotice state={state} />);
    const el = screen.getByTestId('svc-coverage-match');
    expect(el.getAttribute('data-state')).toBe(state);
    expect(el.textContent).not.toBe('');
    expect(el.textContent).not.toBe(state);
    expect(el.textContent).not.toContain('admin.patients');
  });

  it('só MISMATCH pede atenção (âmbar); MATCH e REDACTED não', () => {
    const { rerender } = render(<CoverageMatchNotice state="MISMATCH" />);
    expect(screen.getByTestId('svc-coverage-match').className).toContain('amber');
    rerender(<CoverageMatchNotice state="MATCH" />);
    expect(screen.getByTestId('svc-coverage-match').className).not.toContain('amber');
    rerender(<CoverageMatchNotice state="REDACTED" />);
    expect(screen.getByTestId('svc-coverage-match').className).not.toContain('amber');
  });

  it('REDACTED diz "não visível com a sua permissão" — nunca "coincide"', () => {
    render(<CoverageMatchNotice state="REDACTED" />);
    expect(screen.getByTestId('svc-coverage-match').textContent).toContain('No visible');
  });

  it('testId customizável (o detalhe usa o seu)', () => {
    render(<CoverageMatchNotice state="NO_PAYER" testId="svc-detail-coverage-match" />);
    expect(screen.getByTestId('svc-detail-coverage-match')).toBeTruthy();
  });
});
