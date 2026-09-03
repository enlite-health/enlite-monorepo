/**
 * PatientsTable.test.tsx
 *
 * Cobre as duas mudanças da coluna/linha de pacientes:
 *  - "Servicio" mostra o ALIAS (Acompañante Terapéutico), nunca o ENUM (AT);
 *  - a data do registro entra EMBAIXO do nome (sem coluna nova, sem apertar).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import es from '@infrastructure/i18n/locales/es.json';
import { PatientsTable, type PatientRow } from '../PatientsTable';

/** t() com fallback, como o i18next real: t(key, fallback) → tradução ?? fallback. */
function translate(key: string, fallback?: string): string {
  const value = key
    .split('.')
    .reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), es as Record<string, any>);
  if (typeof value === 'string') return value;
  return fallback ?? key;
}

let language = 'es';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, f?: string) => translate(k, f), i18n: { get language() { return language; } } }),
}));

afterEach(() => {
  language = 'es';
});

const row = (over: Partial<PatientRow> = {}): PatientRow => ({
  id: 'p1',
  firstName: 'Ana',
  lastName: 'Pérez',
  documentType: 'DNI',
  documentNumber: '12345678',
  caseNumber: 7,
  dependencyLevel: 'SEVERE',
  clinicalSpecialty: 'GERIATRIC',
  serviceType: ['AT'],
  needsAttention: false,
  attentionReasons: [],
  createdAt: '2026-08-29T13:45:00.000Z',
  ...over,
});

describe('PatientsTable — coluna Servicio mostra o alias, não o ENUM', () => {
  it('traduz um serviço', () => {
    render(<PatientsTable patients={[row({ serviceType: ['AT'] })]} />);
    expect(screen.getByText('Acompañante Terapéutico')).toBeInTheDocument();
    expect(screen.queryByText('AT')).toBeNull();
  });

  it('traduz composto, mantendo o separador " + "', () => {
    render(<PatientsTable patients={[row({ serviceType: ['AT', 'CAREGIVER'] })]} />);
    expect(screen.getByText('Acompañante Terapéutico + Cuidador')).toBeInTheDocument();
  });

  it('cobre os 5 ENUMs canônicos — nenhum vaza cru', () => {
    const enums = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'];
    render(<PatientsTable patients={enums.map((e, i) => row({ id: `p${i}`, serviceType: [e] }))} />);
    for (const e of enums) expect(screen.queryByText(e)).toBeNull();
    expect(screen.getByText('Enfermería')).toBeInTheDocument();
    expect(screen.getByText('Kinesiólogo')).toBeInTheDocument();
    expect(screen.getByText('Psicólogo')).toBeInTheDocument();
  });

  it('ENUM desconhecido cai no próprio valor, em vez de sumir', () => {
    render(<PatientsTable patients={[row({ serviceType: ['FISIO'] })]} />);
    expect(screen.getByText('FISIO')).toBeInTheDocument();
  });

  it('sem serviço: traço', () => {
    const { container } = render(<PatientsTable patients={[row({ serviceType: [] })]} />);
    expect(container.textContent).toContain('—');
  });
});

describe('PatientsTable — data do registro na linha', () => {
  it('aparece sob o nome, sem coluna nova (8 cabeçalhos, como antes)', () => {
    render(<PatientsTable patients={[row()]} />);
    expect(screen.getByText('29/08/2026')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(8);
  });

  it('nome e data dividem a MESMA célula', () => {
    render(<PatientsTable patients={[row()]} />);
    const cell = screen.getByText('Pérez, Ana').closest('td');
    expect(cell?.textContent).toContain('29/08/2026');
  });

  it('tem title com o rótulo, para a data não ficar ambígua', () => {
    render(<PatientsTable patients={[row()]} />);
    expect(screen.getByTitle('Fecha de registro: 29/08/2026')).toBeInTheDocument();
  });

  /**
   * ⚠️ Não dá para provar o locale pela SAÍDA: es-AR e pt-BR formatam igual
   * (dd/mm/aaaa). Um teste que só lesse a tela ficaria verde com o ternário
   * invertido ou apagado — instrumento morto. Por isso o espião lê o argumento
   * que chega ao `toLocaleDateString`.
   */
  it.each([
    ['es', 'es-AR'],
    ['pt-BR', 'pt-BR'],
  ])('idioma %s entrega o locale %s ao formatador', (lang, esperado) => {
    language = lang;
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString');
    render(<PatientsTable patients={[row()]} />);
    expect(spy).toHaveBeenCalledWith(esperado, { day: '2-digit', month: '2-digit', year: 'numeric' });
    spy.mockRestore();
  });

  it('createdAt nulo ou inválido: linha sem a data, sem quebrar', () => {
    render(<PatientsTable patients={[row({ createdAt: null }), row({ id: 'p2', createdAt: 'nao-e-data' })]} />);
    expect(screen.queryByText(/\d{2}\/\d{2}\/\d{4}/)).toBeNull();
    expect(screen.getAllByText('Pérez, Ana')).toHaveLength(2);
  });
});

describe('PatientsTable — o que já existia continua', () => {
  it('lista vazia: mensagem cobrindo as 8 colunas', () => {
    render(<PatientsTable patients={[]} />);
    const cell = screen.getByText(es.admin.patients.noPatients).closest('td');
    expect(cell?.getAttribute('colspan')).toBe('8');
  });

  it('patients undefined não quebra', () => {
    render(<PatientsTable patients={undefined as unknown as PatientRow[]} />);
    expect(screen.getByText(es.admin.patients.noPatients)).toBeInTheDocument();
  });

  it('documento, dependência, especialidade, código e badges', () => {
    render(<PatientsTable patients={[row(), row({ id: 'p2', documentType: null, documentNumber: null, caseNumber: null, dependencyLevel: null, clinicalSpecialty: null, needsAttention: true, attentionReasons: ['MISSING_INFO'] })]} />);
    expect(screen.getByText('DNI 12345678')).toBeInTheDocument();
    expect(screen.getByText(es.admin.patients.dependencyOptions.SEVERE)).toBeInTheDocument();
    expect(screen.getByText(es.admin.patients.specialtyOptions.GERIATRIC)).toBeInTheDocument();
    expect(screen.getByText(es.admin.patients.statusBadge.complete)).toBeInTheDocument();
    expect(screen.getByText(es.admin.patients.statusBadge.needsAttention)).toBeInTheDocument();
    expect(screen.getByTitle(es.admin.patients.reasonOptions.MISSING_INFO)).toBeInTheDocument();
  });

  it('documento parcial: só tipo, ou só número', () => {
    render(<PatientsTable patients={[row({ documentNumber: null }), row({ id: 'p2', documentType: null })]} />);
    expect(screen.getByText('DNI')).toBeInTheDocument();
    expect(screen.getByText('12345678')).toBeInTheDocument();
  });

  it('needsAttention sem razões: title cai no rótulo genérico', () => {
    render(<PatientsTable patients={[row({ needsAttention: true, attentionReasons: [] })]} />);
    expect(screen.getByTitle(es.admin.patients.statusBadge.needsAttention)).toBeInTheDocument();
  });

  it('clique na linha devolve o id', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const onRowClick = vi.fn();
    render(<PatientsTable patients={[row()]} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('Pérez, Ana'));
    expect(onRowClick).toHaveBeenCalledWith('p1');
  });

  it('nome longo trunca e guarda o inteiro no title, em vez de alargar a tabela', () => {
    const longo = 'Rodríguez de la Fuente';
    render(<PatientsTable patients={[row({ lastName: longo, firstName: 'María Guadalupe' })]} />);
    const nome = screen.getByTitle(`${longo}, María Guadalupe`);
    expect(nome).toHaveClass('truncate');
  });

  /**
   * ⚠️ `getByLabelText` casa TAMBÉM com `title` — medido: apagar o `aria-label`
   * mantinha o teste verde. Por isso a asserção lê o atributo direto.
   */
  it('a data do registro tem aria-label, não só title', () => {
    render(<PatientsTable patients={[row()]} />);
    const alvo = screen.getByTitle('Fecha de registro: 29/08/2026');
    expect(alvo).toHaveAttribute('aria-label', 'Fecha de registro: 29/08/2026');
  });

  /**
   * Reconciliação com a D249 (PR #288): a linha do responsável é FALLBACK — só
   * aparece quando o paciente não tem nome. Nesse caso a célula fica com 3
   * linhas (traço + responsável + data); com nome, fica com 2.
   */
  it('sem nome: traço, linha do responsável E data convivem na mesma célula', () => {
    render(<PatientsTable patients={[row({ firstName: '', lastName: '', responsibleName: 'Marta Gómez' })]} />);
    const cell = screen.getByTestId('patient-row-p1-name').closest('td');
    expect(cell?.textContent).toContain('—');
    expect(screen.getByTestId('patient-row-p1-responsible').textContent).toContain('Marta Gómez');
    expect(cell?.textContent).toContain('29/08/2026');
  });

  it('com nome, a linha do responsável NÃO aparece — só nome e data', () => {
    render(<PatientsTable patients={[row({ responsibleName: 'Marta Gómez' })]} />);
    expect(screen.queryByTestId('patient-row-p1-responsible')).toBeNull();
    expect(screen.getByText('29/08/2026')).toBeInTheDocument();
  });

  it('sem nome nenhum: traço', () => {
    const { container } = render(<PatientsTable patients={[row({ firstName: '', lastName: '' })]} />);
    expect(container.textContent).toContain('—');
  });
});
