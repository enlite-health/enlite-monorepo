/**
 * CompletenessChecklist — spec 014, US-D1 (lex D1.1/D1.2) + D255/QA-caça rodada 1, item conserto 2.
 *
 * QA-caça defeito 2 (reproduzido): a cópia antiga afirmava bloqueio ("Para activar falta:
 * Cobertura, Servicio contratado, Consentimiento") para códigos que `POST /activate` NUNCA
 * bloqueou (só ADDRESS bloqueia — D255). Este arquivo trava o contrato: a seção "Para activar
 * falta:" só pode listar `blocking`; o resto de `missing` vai para "Pendiente para la admisión
 * completa:" (recomendação, não bloqueio). i18n REAL (molde `ServicosContratadosCard.test.tsx`)
 * — sem isso o código cru (ADDRESS/CONSENT/…) escaparia sem o teste notar.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { CompletenessChecklist } from '../CompletenessChecklist';
import type { PatientCompleteness } from '@domain/entities/PatientCompleteness';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

function completeness(overrides: Partial<PatientCompleteness>): PatientCompleteness {
  return { missing: [], blocking: [], ready: true, canActivate: true, ...overrides };
}

describe('CompletenessChecklist (spec 014 US-D1, lex D1.1/D1.2, D255)', () => {
  it('ready:true (missing:[]) → "Admisión completa", nenhum item, nenhuma seção de bloqueio/pendência', () => {
    const { container } = render(
      <CompletenessChecklist completeness={completeness({})} onFocusItem={vi.fn()} />,
    );
    expect(screen.getByText('Admisión completa')).toBeInTheDocument();
    expect(screen.queryByTestId('completeness-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('completeness-pending-item')).not.toBeInTheDocument();
    expect(screen.queryByText('Para activar falta:')).not.toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  // ── QA-caça defeito 2, RED original: missing=[COVERAGE], blocking=[] → NÃO afirma bloqueio ──
  it('missing=[COVERAGE], blocking=[] (canActivate) → NÃO mostra "Para activar falta:"; mostra "Listo para activar" + pendência', () => {
    const { container } = render(
      <CompletenessChecklist
        completeness={completeness({ missing: ['COVERAGE'], blocking: [], ready: false, canActivate: true })}
        onFocusItem={vi.fn()}
      />,
    );
    expect(screen.queryByText('Para activar falta:')).not.toBeInTheDocument();
    expect(screen.getByText('Listo para activar')).toBeInTheDocument();
    expect(screen.getByText('Pendiente para la admisión completa:')).toBeInTheDocument();
    const pending = screen.getAllByTestId('completeness-pending-item');
    expect(pending).toHaveLength(1);
    expect(screen.getByText('Cobertura')).toBeInTheDocument();
    // Nenhuma pílula de BLOQUEIO — a única pílula é a de pendência.
    expect(screen.queryByTestId('completeness-item')).not.toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('blocking=[ADDRESS], missing=[ADDRESS] (só o bloqueante falta) → "Para activar falta: Domicilio", SEM seção de pendência', () => {
    render(
      <CompletenessChecklist
        completeness={completeness({ missing: ['ADDRESS'], blocking: ['ADDRESS'], ready: false, canActivate: false })}
        onFocusItem={vi.fn()}
      />,
    );
    expect(screen.getByText('Para activar falta:')).toBeInTheDocument();
    expect(screen.getAllByTestId('completeness-item')).toHaveLength(1);
    expect(screen.getByText('Domicilio')).toBeInTheDocument();
    expect(screen.queryByText('Pendiente para la admisión completa:')).not.toBeInTheDocument();
    expect(screen.queryByTestId('completeness-pending-item')).not.toBeInTheDocument();
    expect(screen.queryByText('Listo para activar')).not.toBeInTheDocument();
  });

  it('blocking=[ADDRESS] + pendência (COVERAGE, CONSENT) → as DUAS seções aparecem, cada código na lista certa', () => {
    render(
      <CompletenessChecklist
        completeness={completeness({
          missing: ['ADDRESS', 'COVERAGE', 'CONSENT'],
          blocking: ['ADDRESS'],
          ready: false,
          canActivate: false,
        })}
        onFocusItem={vi.fn()}
      />,
    );
    expect(screen.getByText('Para activar falta:')).toBeInTheDocument();
    expect(screen.getByText('Pendiente para la admisión completa:')).toBeInTheDocument();
    expect(screen.getAllByTestId('completeness-item')).toHaveLength(1); // só ADDRESS
    expect(screen.getAllByTestId('completeness-pending-item')).toHaveLength(2); // COVERAGE + CONSENT
  });

  it('clicar num item de BLOQUEIO chama onFocusItem com o código certo', async () => {
    const user = userEvent.setup();
    const onFocusItem = vi.fn();
    render(
      <CompletenessChecklist
        completeness={completeness({ missing: ['ADDRESS'], blocking: ['ADDRESS'], ready: false, canActivate: false })}
        onFocusItem={onFocusItem}
      />,
    );
    await user.click(screen.getByText('Domicilio'));
    expect(onFocusItem).toHaveBeenCalledWith('ADDRESS');
  });

  it('clicar num item de PENDÊNCIA também chama onFocusItem com o código certo', async () => {
    const user = userEvent.setup();
    const onFocusItem = vi.fn();
    render(
      <CompletenessChecklist
        completeness={completeness({ missing: ['COVERAGE'], blocking: [], ready: false, canActivate: true })}
        onFocusItem={onFocusItem}
      />,
    );
    await user.click(screen.getByText('Cobertura'));
    expect(onFocusItem).toHaveBeenCalledWith('COVERAGE');
  });

  it('todos os 5 códigos possíveis têm rótulo — nenhum aparece cru mesmo distribuídos entre bloqueio/pendência', () => {
    render(
      <CompletenessChecklist
        completeness={completeness({
          missing: ['ADDRESS', 'RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT'],
          blocking: ['ADDRESS'],
          ready: false,
          canActivate: false,
        })}
        onFocusItem={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('completeness-item')).toHaveLength(1);
    expect(screen.getAllByTestId('completeness-pending-item')).toHaveLength(4);
    for (const raw of ['ADDRESS', 'RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT']) {
      expect(screen.queryByText(raw)).not.toBeInTheDocument();
    }
  });

  it('D255: nunca afirma bloqueio para código fora de `blocking` — mesmo com os 4 não-ADDRESS faltando juntos', () => {
    render(
      <CompletenessChecklist
        completeness={completeness({
          missing: ['RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT'],
          blocking: [],
          ready: false,
          canActivate: true,
        })}
        onFocusItem={vi.fn()}
      />,
    );
    expect(screen.queryByText('Para activar falta:')).not.toBeInTheDocument();
    expect(screen.getByText('Listo para activar')).toBeInTheDocument();
    expect(screen.getAllByTestId('completeness-pending-item')).toHaveLength(4);
  });
});
