/**
 * CaseSelectStep — seleção de caso (spec 027 T068).
 *
 * `handleCaseChange` comparava `cases.find(c => c.caseNumber === Number(val))`.
 * `val` já era o valor CRU (nunca formatado), então hoje não quebra — mas o
 * `Number()` fica frágil pra sempre que o `value` deixar de ser garantidamente
 * numérico. O fix compara por STRING (`String(c.caseNumber) === val`), sem o
 * parse. Este teste prova que selecionar um caso nativo (>= 1000, exibido como
 * `EN1234` no label) ainda dispara `selectCase` com o `caseNumber` certo.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaseSelectStep } from '../CaseSelectStep';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getCasesForSelect: vi.fn().mockResolvedValue([
      { caseNumber: 1234, patientId: 'p-native', dependencyLevel: 'SEVERE' },
      { caseNumber: 729, patientId: 'p-legacy', dependencyLevel: 'MODERATE' },
    ]),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'admin.vacancyModal.caseSelectStep.caseOptionLabel') {
        return `CASO ${opts?.caseNumber}`;
      }
      return key;
    },
  }),
}));

describe('CaseSelectStep — seleção', () => {
  it('seleciona um caso NATIVO (>= 1000, label com prefixo EN) e chama selectCase com o número certo', async () => {
    const selectCase = vi.fn();
    const selectAddress = vi.fn();

    render(
      <CaseSelectStep
        selectedCaseNumber={null}
        selectedPatientId={null}
        dependencyLevel={null}
        addresses={[]}
        selectedAddressId={null}
        isLoadingPatient={false}
        patientError={null}
        selectCase={selectCase}
        selectAddress={selectAddress}
      />
    );

    const select = await screen.findByTestId('case-select');
    // Label do caso nativo aparece formatado com o prefixo EN.
    expect(await screen.findByText('CASO EN1234')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: '1234' } });

    expect(selectCase).toHaveBeenCalledWith(1234, 'p-native');
  });

  it('seleciona um caso LEGADO (< 1000, sem prefixo) e chama selectCase', async () => {
    const selectCase = vi.fn();
    const selectAddress = vi.fn();

    render(
      <CaseSelectStep
        selectedCaseNumber={null}
        selectedPatientId={null}
        dependencyLevel={null}
        addresses={[]}
        selectedAddressId={null}
        isLoadingPatient={false}
        patientError={null}
        selectCase={selectCase}
        selectAddress={selectAddress}
      />
    );

    const select = await screen.findByTestId('case-select');
    expect(await screen.findByText('CASO 729')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: '729' } });

    expect(selectCase).toHaveBeenCalledWith(729, 'p-legacy');
  });
});
