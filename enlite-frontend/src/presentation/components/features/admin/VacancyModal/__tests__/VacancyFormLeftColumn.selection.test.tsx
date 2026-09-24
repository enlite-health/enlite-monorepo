/**
 * VacancyFormLeftColumn — seleção de caso no dropdown de criação (spec 027 T068).
 *
 * Mesma classe de defeito do `CaseSelectStep` (ver `CaseSelectStep.selection.test.tsx`):
 * `handleCaseChange` comparava `cases.find(c => c.caseNumber === Number(val))`. O fix
 * compara por STRING (`String(c.caseNumber) === val`). Este teste prova que escolher um
 * caso NATIVO (label formatado `EN1234`) na `SearchableSelect` ainda dispara `selectCase`
 * com o `caseNumber` numérico certo.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { VacancyFormLeftColumn } from '../VacancyFormLeftColumn';
import { DEFAULT_FORM_VALUES, type VacancyFormData } from '../../vacancy-form-schema';

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

function Harness({ selectCase }: { selectCase: (caseNumber: number, patientId: string) => void }) {
  const { register, control, formState: { errors } } = useForm<VacancyFormData>({
    defaultValues: DEFAULT_FORM_VALUES,
  });
  return (
    <VacancyFormLeftColumn
      mode="create"
      register={register}
      control={control}
      errors={errors}
      patientSelected={false}
      diagnosis={null}
      patientName={null}
      selectedCaseNumber={null}
      selectedPatientId={null}
      dependencyLevel={null}
      selectCase={selectCase}
      setValue={vi.fn()}
    />
  );
}

describe('VacancyFormLeftColumn — seleção de caso', () => {
  it('seleciona um caso NATIVO (label EN1234) na SearchableSelect e chama selectCase com o número certo', async () => {
    const selectCase = vi.fn();
    render(<Harness selectCase={selectCase} />);

    const caseSelect = await screen.findByTestId('case-select');
    const openButton = caseSelect.querySelector('button');
    expect(openButton).not.toBeNull();
    fireEvent.click(openButton as HTMLButtonElement);

    const option = await screen.findByText('CASO EN1234');
    fireEvent.click(option);

    expect(selectCase).toHaveBeenCalledWith(1234, 'p-native');
  });
});
