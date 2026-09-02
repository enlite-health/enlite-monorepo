/**
 * PatientsTable.responsible.test.tsx — D249
 *
 * Na lista, o lead "para otra persona" mostra o traço onde iria o nome do
 * paciente e, embaixo, quem responde por ele. Sem a segunda linha o traço
 * sozinho não identificaria nada — que é o defeito que a mudança conserta.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PatientsTable, type PatientRow } from '../PatientsTable';

function linha(overrides: Partial<PatientRow> = {}): PatientRow {
  return {
    id: 'p-1',
    firstName: '',
    lastName: '',
    documentType: null,
    documentNumber: null,
    caseNumber: null,
    dependencyLevel: null,
    clinicalSpecialty: null,
    serviceType: [],
    needsAttention: false,
    attentionReasons: [],
    responsibleName: null,
    ...overrides,
  } as PatientRow;
}

describe('PatientsTable — os ramos que a tabela já tinha', () => {
  it('lista vazia mostra a frase, não uma tabela oca', () => {
    render(<PatientsTable patients={[]} />);
    expect(screen.getByText('admin.patients.noPatients')).toBeInTheDocument();
  });

  it('patients undefined não quebra (o safePatients existe por isto)', () => {
    render(<PatientsTable patients={undefined as never} />);
    expect(screen.getByText('admin.patients.noPatients')).toBeInTheDocument();
  });

  it('código do caso e especialidade aparecem quando existem, e viram traço quando não', () => {
    const { rerender } = render(
      <PatientsTable patients={[linha({ caseNumber: 766, clinicalSpecialty: 'ASD' })]} />,
    );
    expect(screen.getByText(/766/)).toBeInTheDocument();

    rerender(<PatientsTable patients={[linha({ caseNumber: null, clinicalSpecialty: null })]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(1);
  });

  it('badge de atenção: com motivos lista os motivos, sem motivos usa o rótulo genérico', () => {
    const { rerender } = render(
      <PatientsTable
        patients={[linha({ needsAttention: true, attentionReasons: ['NO_ADDRESS', 'NO_CONTACT'] })]}
      />,
    );
    expect(screen.getByTitle(/NO_ADDRESS/)).toBeInTheDocument();

    rerender(<PatientsTable patients={[linha({ needsAttention: true, attentionReasons: [] })]} />);
    expect(screen.getByTitle('admin.patients.statusBadge.needsAttention')).toBeInTheDocument();
  });

  it('serviço e nível de dependência: preenchidos aparecem, vazios viram traço', () => {
    const { rerender } = render(
      <PatientsTable patients={[linha({ serviceType: ['AT', 'CAREGIVER'], dependencyLevel: 'MODERATE' })]} />,
    );
    expect(screen.getByText('AT + CAREGIVER')).toBeInTheDocument();
    // `t(chave, fallback)` devolve o FALLBACK quando a chave não existe no
    // bundle de teste — por isso 'MODERATE' e não a chave.
    expect(screen.getByText('MODERATE')).toBeInTheDocument();

    rerender(<PatientsTable patients={[linha({ serviceType: [], dependencyLevel: null })]} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(1);
  });

  it('documento: só tipo, só número, os dois, ou nenhum', () => {
    const { rerender } = render(
      <PatientsTable patients={[linha({ documentType: 'DNI', documentNumber: '12345678' })]} />,
    );
    expect(screen.getByText('DNI 12345678')).toBeInTheDocument();

    rerender(<PatientsTable patients={[linha({ documentType: null, documentNumber: '12345678' })]} />);
    expect(screen.getByText('12345678')).toBeInTheDocument();

    rerender(<PatientsTable patients={[linha({ documentType: 'DNI', documentNumber: null })]} />);
    expect(screen.getByText('DNI')).toBeInTheDocument();
  });

  it('clicar na linha chama onRowClick com o id', () => {
    const onRowClick = vi.fn();
    render(<PatientsTable patients={[linha()]} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByTestId('patient-row-p-1-name'));
    expect(onRowClick).toHaveBeenCalledWith('p-1');
  });
});

describe('PatientsTable — nome do responsável (D249)', () => {
  it('paciente sem nome: traço em cima, responsável embaixo', () => {
    render(<PatientsTable patients={[linha({ responsibleName: 'flavia villagra' })]} />);

    expect(screen.getByTestId('patient-row-p-1-responsible')).toHaveTextContent('flavia villagra');
    // A célula de NOME, não qualquer '—' da linha (código e documento também usam).
    expect(screen.getByTestId('patient-row-p-1-name')).toHaveTextContent('—');
  });

  it('paciente COM nome: nenhuma linha de responsável aparece', () => {
    render(
      <PatientsTable
        patients={[linha({ firstName: 'joaquín', lastName: 'benítez', responsibleName: 'flavia villagra' })]}
      />,
    );

    expect(screen.queryByTestId('patient-row-p-1-responsible')).toBeNull();
    expect(screen.getByText('benítez, joaquín')).toBeInTheDocument();
  });

  it('sem nome e sem responsável: o traço sozinho, nunca célula vazia', () => {
    render(<PatientsTable patients={[linha()]} />);

    expect(screen.getByTestId('patient-row-p-1-name')).toHaveTextContent('—');
    expect(screen.queryByTestId('patient-row-p-1-responsible')).toBeNull();
  });
});
