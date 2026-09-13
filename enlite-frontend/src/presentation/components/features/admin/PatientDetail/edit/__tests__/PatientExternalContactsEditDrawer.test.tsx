/**
 * PatientExternalContactsEditDrawer — spec 018, PR-2, US-12, `lex` #4. Molde:
 * PatientSupportNetworkEditDrawer.test.tsx (escrita por linha, ADR-1): cada linha nasce
 * (create)/muda (update)/desaparece (deactivate, NUNCA DELETE) por conta própria.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientExternalContactDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, optsOrDefault?: any): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  if (typeof current === 'string') return current;
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  if (typeof optsOrDefault === 'object' && typeof optsOrDefault?.defaultValue === 'string') return optsOrDefault.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const createExternalContact = vi.fn();
const updateExternalContact = vi.fn();
const deactivateExternalContact = vi.fn();
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    createExternalContact: (...a: unknown[]) => createExternalContact(...a),
    updateExternalContact: (...a: unknown[]) => updateExternalContact(...a),
    deactivateExternalContact: (...a: unknown[]) => deactivateExternalContact(...a),
  },
}));

import { PatientExternalContactsEditDrawer } from '../PatientExternalContactsEditDrawer';

const PATIENT_ID = 'a0000000-0000-0000-0000-000000000001';

const contact: PatientExternalContactDetail = {
  id: 'x1', relation: 'TEACHER', name: 'Prof. Gómez', phone: '11-5555-0001', active: true,
};

function renderDrawer(rows: PatientExternalContactDetail[] = [contact]) {
  return render(<PatientExternalContactsEditDrawer patientId={PATIENT_ID} externalContacts={rows} onClose={vi.fn()} onSaved={vi.fn()} />);
}

describe('PatientExternalContactsEditDrawer', () => {
  beforeEach(() => {
    createExternalContact.mockReset().mockResolvedValue({ id: 'novo' });
    updateExternalContact.mockReset().mockResolvedValue({ id: 'x1' });
    deactivateExternalContact.mockReset().mockResolvedValue({ id: 'x1', active: false, emergencyMarkCleared: false });
  });

  it('carrega relação/nome/telefone do contato existente', () => {
    renderDrawer();
    expect(screen.getByTestId('pxc-relation-0')).toHaveValue('TEACHER');
    expect(screen.getByTestId('pxc-name-0')).toHaveValue('Prof. Gómez');
    expect(screen.getByTestId('pxc-phone-0')).toHaveValue('11-5555-0001');
  });

  it('editar só o telefone chama updateExternalContact(patientId, id, patch) com relation/name intactos', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('pxc-phone-0'), { target: { value: '11-9999-0000' } });
    fireEvent.click(screen.getByTestId('pxc-save'));
    await waitFor(() => expect(updateExternalContact).toHaveBeenCalledTimes(1));
    expect(createExternalContact).not.toHaveBeenCalled();
    expect(updateExternalContact).toHaveBeenCalledWith(PATIENT_ID, 'x1', {
      relation: 'TEACHER', name: 'Prof. Gómez', phone: '11-9999-0000',
    });
  });

  it('apagar o telefone manda null (apagar é uma edição, não ausência)', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('pxc-phone-0'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pxc-save'));
    await waitFor(() => expect(updateExternalContact).toHaveBeenCalledTimes(1));
    const patch = updateExternalContact.mock.calls[0][2] as { phone: string | null };
    expect(patch.phone).toBeNull();
  });

  it('contato NOVO chama createExternalContact (sem id)', async () => {
    renderDrawer([]);
    fireEvent.click(screen.getByTestId('pxc-add'));
    fireEvent.change(screen.getByTestId('pxc-relation-0'), { target: { value: 'NEIGHBOR' } });
    fireEvent.change(screen.getByTestId('pxc-name-0'), { target: { value: 'Vecina' } });
    fireEvent.click(screen.getByTestId('pxc-save'));
    await waitFor(() => expect(createExternalContact).toHaveBeenCalledTimes(1));
    expect(updateExternalContact).not.toHaveBeenCalled();
    expect(createExternalContact).toHaveBeenCalledWith(PATIENT_ID, { relation: 'NEIGHBOR', name: 'Vecina', phone: null });
  });

  it('a mensagem de erro NUNCA ecoa nome/telefone do terceiro', async () => {
    updateExternalContact.mockRejectedValueOnce(new Error('Validation failed for phone 11-5555-0001'));
    renderDrawer();
    fireEvent.click(screen.getByTestId('pxc-save'));
    const err = await screen.findByTestId('pxc-error');
    expect(err.textContent).not.toContain('11-5555-0001');
    expect(err.textContent).toBe(t('admin.patients.editDrawer.saveError'));
  });

  it('remover um contato EXISTENTE chama deactivateExternalContact com o id; some da tela na hora', async () => {
    renderDrawer([contact, { ...contact, id: 'x2', name: 'Otro' }]);
    fireEvent.click(screen.getByTestId('pxc-remove-1'));
    expect(screen.queryByTestId('pxc-row-1')).toBeNull();
    fireEvent.click(screen.getByTestId('pxc-save'));
    await waitFor(() => expect(deactivateExternalContact).toHaveBeenCalledWith(PATIENT_ID, 'x2'));
    expect(updateExternalContact).toHaveBeenCalledTimes(1); // só a linha que ficou
  });

  it('remover uma linha NOVA (sem id) NÃO chama deactivate — só some do formulário', async () => {
    renderDrawer([]);
    fireEvent.click(screen.getByTestId('pxc-add'));
    fireEvent.click(screen.getByTestId('pxc-remove-0'));
    expect(screen.getByTestId('pxc-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pxc-save'));
    await waitFor(() => expect(screen.queryByTestId('patient-external-contacts-edit-drawer')).not.toBeNull());
    expect(deactivateExternalContact).not.toHaveBeenCalled();
    expect(createExternalContact).not.toHaveBeenCalled();
  });

  it('nome vazio: erro na tela, sem chamar a API', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('pxc-name-0'), { target: { value: ' ' } });
    fireEvent.click(screen.getByTestId('pxc-save'));
    expect(await screen.findByText(t('admin.patients.editDrawer.requiredField'))).toBeInTheDocument();
    expect(updateExternalContact).not.toHaveBeenCalled();
  });

  it('lex C10: aviso do dever de informar aparece no drawer', () => {
    renderDrawer();
    expect(screen.getByTestId('pxc-notice')).toHaveTextContent(t('admin.patients.editDrawer.externalContactsNotice'));
  });

  it('data-clarity-mask na linha inteira (nome/telefone de terceiro)', () => {
    renderDrawer();
    expect(screen.getByTestId('pxc-row-0').getAttribute('data-clarity-mask')).toBe('True');
  });

  it('Escape e clique no backdrop fecham; sem mudança não pede confirmação', async () => {
    const onClose = vi.fn();
    render(<PatientExternalContactsEditDrawer patientId={PATIENT_ID} externalContacts={[contact]} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('patient-external-contacts-edit-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('COM mudança → Escape pede confirmação de descarte', () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('pxc-name-0'), { target: { value: 'Outro Nome' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
    expect(screen.getByTestId('pxc-name-0')).toHaveValue('Outro Nome');
  });

  it('sem contatos: estado vazio', () => {
    renderDrawer([]);
    expect(screen.getByTestId('pxc-empty')).toBeInTheDocument();
  });

  it('externalContacts ausente (prop undefined) cai no fallback `?? []`, sem estourar', () => {
    render(<PatientExternalContactsEditDrawer patientId={PATIENT_ID} externalContacts={undefined as unknown as PatientExternalContactDetail[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('pxc-empty')).toBeInTheDocument();
  });

  it('contato sem telefone (null) carrega o campo vazio, não "null"', () => {
    renderDrawer([{ ...contact, phone: null }]);
    expect(screen.getByTestId('pxc-phone-0')).toHaveValue('');
  });
});
