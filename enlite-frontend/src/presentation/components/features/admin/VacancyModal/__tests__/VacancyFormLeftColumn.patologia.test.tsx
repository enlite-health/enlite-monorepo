/**
 * VacancyFormLeftColumn — patología do paciente no modal de criar/editar vaga.
 *
 * O campo é READ-ONLY e fica FORA do payload: a vaga nunca persiste diagnóstico
 * (a coluna saiu de `job_postings` na migration 039, de propósito). Aqui só se prova
 * que a tela mostra o que a API do paciente devolveu, e que os três estados não se
 * confundem — "não carregou" jamais pode aparecer como "não tem".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { VacancyFormLeftColumn } from '../VacancyFormLeftColumn';
import { DEFAULT_FORM_VALUES, type VacancyFormData } from '../../vacancy-form-schema';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getCasesForSelect: vi.fn().mockResolvedValue([]) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const dx = (over: Partial<PatientDiagnosisDetail> = {}): PatientDiagnosisDetail => ({
  id: 'dx-1',
  uri: 'http://id.who.int/icd/entity/333333',
  title: 'Diabetes mellitus tipo 2',
  isPrimary: true,
  source: 'PANEL',
  active: true,
  ...over,
});

function Harness(props: { diagnoses: PatientDiagnosisDetail[] | null; diagnosesUnavailable?: boolean }) {
  const { register, control, formState: { errors } } = useForm<VacancyFormData>({
    defaultValues: DEFAULT_FORM_VALUES,
  });
  return (
    <VacancyFormLeftColumn
      mode="create"
      register={register}
      control={control}
      errors={errors}
      patientSelected
      diagnoses={props.diagnoses}
      diagnosesUnavailable={props.diagnosesUnavailable ?? false}
      patientName="Paciente QA"
      selectedCaseNumber={1234}
      selectedPatientId="p-1"
      dependencyLevel={null}
      selectCase={vi.fn()}
      setValue={vi.fn()}
    />
  );
}

describe('VacancyFormLeftColumn — patología', () => {
  it('lista os títulos das patologías', () => {
    render(<Harness diagnoses={[dx(), dx({ id: 'dx-2', title: 'Asma', isPrimary: false })]} />);
    expect(screen.getByTestId('vacancy-form-patologias')).toHaveTextContent('Diabetes mellitus tipo 2');
    expect(screen.getByTestId('vacancy-form-patologias')).toHaveTextContent('Asma');
  });

  it('NUNCA mostra o código/URI do CID (REQ-21)', () => {
    render(<Harness diagnoses={[dx()]} />);
    expect(screen.queryByText(/id\.who\.int/)).toBeNull();
    expect(screen.queryByText(/6A02/)).toBeNull();
  });

  it('ator SEM permissão clínica vê o aviso, NUNCA "—"', () => {
    render(<Harness diagnoses={null} />);
    expect(screen.getByTestId('vacancy-form-patologia-no-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-form-patologia-empty')).toBeNull();
  });

  it('sem diagnóstico mostra "—"', () => {
    render(<Harness diagnoses={[]} />);
    expect(screen.getByTestId('vacancy-form-patologia-empty')).toHaveTextContent('—');
  });

  it('falha de leitura avisa, em vez de fingir ausência', () => {
    render(<Harness diagnoses={[]} diagnosesUnavailable />);
    expect(screen.getByTestId('vacancy-form-patologia-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-form-patologia-empty')).toBeNull();
  });
});
