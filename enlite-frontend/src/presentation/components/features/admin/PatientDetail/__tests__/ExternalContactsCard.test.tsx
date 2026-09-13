/**
 * ExternalContactsCard — "Red de contactos" (spec 018, PR-2, US-12, `lex` #4). Molde:
 * FamiliaresCard (describe em PatientDetailCards.test.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientExternalContactDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, fallback?: string): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  return fallback ?? key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('../edit/PatientExternalContactsEditDrawer', () => ({
  PatientExternalContactsEditDrawer: ({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) => (
    <div data-testid="mock-drawer">
      <button onClick={onClose}>fechar</button>
      <button onClick={onSaved}>salvar</button>
    </div>
  ),
}));
const mockMarkEmergencyContact = vi.fn().mockResolvedValue({});
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    markEmergencyContact: (...a: unknown[]) => mockMarkEmergencyContact(...a),
    unmarkEmergencyContact: vi.fn().mockResolvedValue({}),
  },
}));

import { ExternalContactsCard } from '../ExternalContactsCard';

const rows: PatientExternalContactDetail[] = [
  { id: 'x1', relation: 'TEACHER', name: 'Prof. Gómez', phone: '11-5555-0001', active: true },
];

describe('ExternalContactsCard', () => {
  it('título e cabeçalhos da tabela', () => {
    render(<ExternalContactsCard externalContacts={[]} patientId="p1" />);
    expect(screen.getByText(t('admin.patients.detail.externalContactsCard.title'))).toBeInTheDocument();
    expect(screen.getByText(t('admin.patients.detail.externalContactsCard.tableRelation'))).toBeInTheDocument();
    expect(screen.getByText(t('admin.patients.detail.externalContactsCard.tableName'))).toBeInTheDocument();
    expect(screen.getByText(t('admin.patients.detail.externalContactsCard.tablePhone'))).toBeInTheDocument();
    expect(screen.getByText(t('admin.patients.detail.externalContactsCard.tableEmergency'))).toBeInTheDocument();
  });

  it('sem contatos: estado vazio', () => {
    render(<ExternalContactsCard externalContacts={[]} patientId="p1" />);
    expect(screen.getByTestId('external-contacts-empty')).toBeInTheDocument();
  });

  it('renderiza a linha com relação traduzida, nome e telefone; máscara do Clarity na linha inteira', () => {
    render(<ExternalContactsCard externalContacts={rows} patientId="p1" />);
    expect(screen.getByText(t('admin.patients.detail.externalContactRelationOptions.TEACHER'))).toBeInTheDocument();
    expect(screen.getByText('Prof. Gómez')).toBeInTheDocument();
    expect(screen.getByText('11-5555-0001')).toBeInTheDocument();
    expect(screen.getByTestId('external-contact-row-x1').getAttribute('data-clarity-mask')).toBe('True');
  });

  it('relação sem tradução cai no valor cru (fallback do t)', () => {
    render(<ExternalContactsCard externalContacts={[{ id: 'x2', relation: 'DESCONHECIDO', name: 'X', phone: null, active: true }]} patientId="p1" />);
    expect(screen.getByText('DESCONHECIDO')).toBeInTheDocument();
  });

  it('abre o drawer ao clicar em "Novo"; fecha ao chamar onClose', () => {
    render(<ExternalContactsCard externalContacts={[]} patientId="p1" />);
    expect(screen.queryByTestId('mock-drawer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edit-external-contacts-btn'));
    expect(screen.getByTestId('mock-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByText('fechar'));
    expect(screen.queryByTestId('mock-drawer')).not.toBeInTheDocument();
  });

  it('sem patientId: botão "Novo" desabilitado', () => {
    render(<ExternalContactsCard externalContacts={[]} />);
    expect(screen.getByTestId('edit-external-contacts-btn').closest('button')).toBeDisabled();
  });

  it('sem patientId: coluna de emergência mostra "—" em vez do botão', () => {
    render(<ExternalContactsCard externalContacts={rows} />);
    const row = screen.getByTestId('external-contact-row-x1');
    expect(row).toHaveTextContent('—');
  });

  it('marca a linha correspondente ao emergencyContactRef', () => {
    render(<ExternalContactsCard externalContacts={rows} patientId="p1" emergencyContactRef={{ kind: 'EXTERNAL', id: 'x1' }} />);
    expect(screen.getByTestId('emergency-mark-EXTERNAL-x1')).toHaveTextContent(t('admin.patients.editDrawer.unmarkEmergencyContact'));
  });

  it('sem externalContacts (prop ausente): cai no fallback `?? []`, sem estourar', () => {
    render(<ExternalContactsCard externalContacts={undefined as unknown as PatientExternalContactDetail[]} patientId="p1" />);
    expect(screen.getByTestId('external-contacts-empty')).toBeInTheDocument();
  });

  it('nome vazio cai no fallback "—" da célula de nome', () => {
    render(<ExternalContactsCard externalContacts={[{ id: 'x4', relation: 'OTHER', name: '', phone: '1', active: true }]} patientId="p1" />);
    const row = screen.getByTestId('external-contact-row-x4');
    expect(row).toHaveTextContent('—');
  });

  it('telefone ausente (null) cai no fallback "—" da célula de telefone', () => {
    render(<ExternalContactsCard externalContacts={[{ id: 'x3', relation: 'OTHER', name: 'Sem telefone', phone: null, active: true }]} patientId="p1" />);
    const row = screen.getByTestId('external-contact-row-x3');
    expect(row).toHaveTextContent('—');
  });

  it('onSaved do drawer chama o onSaved do card (refetch)', () => {
    const onSaved = vi.fn();
    render(<ExternalContactsCard externalContacts={[]} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('edit-external-contacts-btn'));
    fireEvent.click(screen.getByText('salvar'));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('onChanged do EmergencyMarkButton chama o onSaved do card (refetch)', async () => {
    const onSaved = vi.fn();
    render(<ExternalContactsCard externalContacts={rows} patientId="p1" onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('emergency-mark-EXTERNAL-x1'));
    await waitFor(() => expect(mockMarkEmergencyContact).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
