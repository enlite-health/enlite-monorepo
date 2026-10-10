/**
 * PatientResponsibleEditDrawer — UM familiar por vez (molde: PatientProfessionalEditDrawer).
 * Herda do antigo drawer da lista inteira: documento por linha (lex C1.1/C1.2), mensagem de erro que
 * nunca ecoa o documento (C1.3), confirmação ao fechar com mudança (US-D4) e a regra do TITULAR:
 * no máximo um ativo (índice único), o backend NÃO despromove sozinho (409) → o drawer despromove o
 * antigo ANTES de gravar este.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientResponsibleDetail } from '@domain/entities/PatientDetail';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

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

const createResponsible = vi.fn();
const updateResponsible = vi.fn();
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    createResponsible: (...a: unknown[]) => createResponsible(...a),
    updateResponsible: (...a: unknown[]) => updateResponsible(...a),
  },
}));

import { PatientResponsibleEditDrawer } from '../PatientResponsibleEditDrawer';

const PATIENT_ID = 'a0000000-0000-0000-0000-000000000001';
const DOC_NUMBER = '987.654.321-00';

const titular: PatientResponsibleDetail = {
  id: 'r1', firstName: 'Luciana', lastName: 'Soto', relationship: 'MOM', phone: '(11) 99852-0481',
  email: 'luciana.soto@example.com', documentType: 'CPF', documentNumber: DOC_NUMBER, isPrimary: true, displayOrder: 1, source: 'web_form',
};
const outro: PatientResponsibleDetail = { ...titular, id: 'r2', firstName: 'Pedro', isPrimary: false, displayOrder: 2 };

function renderDrawer(responsible: PatientResponsibleDetail | null, responsibles: PatientResponsibleDetail[], cb: { onClose?: () => void; onSaved?: () => void } = {}) {
  return render(
    <PatientResponsibleEditDrawer patientId={PATIENT_ID} responsible={responsible} responsibles={responsibles} onClose={cb.onClose ?? vi.fn()} onSaved={cb.onSaved ?? vi.fn()} />,
  );
}
const fill = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(() => {
  createResponsible.mockReset().mockResolvedValue({ id: 'novo' });
  updateResponsible.mockReset().mockResolvedValue({ id: 'r1' });
});

describe('PatientResponsibleEditDrawer — criar × editar', () => {
  it('editar: título "Editar familiar", campos preenchidos com a linha, só SEU PATCH (documento intacto)', async () => {
    renderDrawer(titular, [titular, outro]);
    expect(screen.getByTestId('responsible-edit-drawer')).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.editTitle'));
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('Luciana');
    expect(screen.getByTestId('responsible-documentType')).toHaveValue('CPF');
    expect(screen.getByTestId('responsible-documentNumber')).toHaveValue(DOC_NUMBER);
    fill('responsible-phone', '(11) 90000-0000');
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    expect(createResponsible).not.toHaveBeenCalled();
    expect(updateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'r1', {
      firstName: 'Luciana', lastName: 'Soto', relationship: 'MOM', phone: '(11) 90000-0000',
      email: 'luciana.soto@example.com', documentType: 'CPF', documentNumber: DOC_NUMBER, isPrimary: true,
    });
  });

  it('criar: título "Novo familiar", campos vazios, POST sem id/source/displayOrder; limpar vira null', async () => {
    renderDrawer(null, [titular]);
    expect(screen.getByTestId('responsible-edit-drawer')).toHaveAttribute('aria-label', t('admin.patients.detail.familyCard.newTitle'));
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('');
    fill('responsible-firstName', 'Nuevo');
    fill('responsible-lastName', 'Familiar');
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(createResponsible).toHaveBeenCalledTimes(1));
    expect(updateResponsible).not.toHaveBeenCalled();
    const [pid, payload] = createResponsible.mock.calls[0] as [string, Record<string, unknown>];
    expect(pid).toBe(PATIENT_ID);
    expect(payload).toMatchObject({ firstName: 'Nuevo', lastName: 'Familiar', phone: null, documentType: null, documentNumber: null, isPrimary: false });
    expect(payload).not.toHaveProperty('source');
    expect(payload).not.toHaveProperty('id');
  });

  it('trocar tipo de documento e limpar o número (espaços) vai no PATCH como DNI / null', async () => {
    renderDrawer(titular, [titular]);
    fill('responsible-documentType', 'DNI');
    fill('responsible-documentNumber', '   ');
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    expect(updateResponsible.mock.calls[0][2]).toMatchObject({ documentType: 'DNI', documentNumber: null });
  });

  it('campos nulos carregam vazio', () => {
    renderDrawer({ ...titular, id: 'r0', firstName: null, lastName: null, relationship: null, phone: null, email: null, documentType: null, documentNumber: null, isPrimary: false }, [titular]);
    for (const id of ['responsible-firstName', 'responsible-lastName', 'responsible-rel', 'responsible-phone', 'responsible-email', 'responsible-documentType', 'responsible-documentNumber']) {
      expect(screen.getByTestId(id)).toHaveValue('');
    }
  });

  it('sucesso: onSaved e fecha (onClose)', async () => {
    const onSaved = vi.fn(); const onClose = vi.fn();
    renderDrawer(titular, [titular], { onSaved, onClose });
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1500 });
  });

  it('nome/sobrenome vazios e e-mail inválido: erros traduzidos na tela, sem chamar a API', async () => {
    renderDrawer(titular, [titular]);
    fill('responsible-firstName', '');
    fill('responsible-lastName', ' ');
    fill('responsible-email', 'invalido');
    fireEvent.click(screen.getByTestId('responsible-save'));
    expect((await screen.findAllByText(t('admin.patients.editDrawer.requiredField'))).length).toBe(2);
    expect(screen.getByText(/Invalid email/)).toBeInTheDocument();
    expect(updateResponsible).not.toHaveBeenCalled();
    expect(createResponsible).not.toHaveBeenCalled();
  });

  it('C1.3 — a mensagem de erro NUNCA ecoa o número do documento (mesmo que a API o devolva); drawer continua aberto', async () => {
    updateResponsible.mockRejectedValueOnce(new Error(`Validation failed for documentNumber ${DOC_NUMBER}`));
    const onClose = vi.fn();
    renderDrawer(titular, [titular], { onClose });
    fireEvent.click(screen.getByTestId('responsible-save'));
    const err = await screen.findByTestId('responsible-error');
    expect(err.textContent).not.toContain(DOC_NUMBER);
    expect(err.textContent).toBe('Erro ao salvar');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PatientResponsibleEditDrawer — TITULAR (índice único: 1 ativo; backend não despromove sozinho)', () => {
  it('(a) marcar este como titular com OUTRO titular ativo → despromove o antigo ANTES, grava este DEPOIS', async () => {
    const ordem: string[] = [];
    updateResponsible.mockImplementation(async (_p: string, id: string, patch: { isPrimary?: boolean }) => { ordem.push(`${id}:${patch.isPrimary}`); return { id }; });
    renderDrawer(outro, [titular, outro]);
    expect(screen.getByTestId('responsible-primary')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('responsible-primary'));
    expect(screen.getByTestId('responsible-primary')).toBeChecked();
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(2));
    expect(ordem).toEqual(['r1:false', 'r2:true']);
    expect(updateResponsible.mock.calls[0][2]).toEqual({ isPrimary: false }); // só despromove, não reescreve o resto
  });

  it('(a) criar um familiar NOVO já como titular com outro titular ativo → despromove o antigo, depois POST com isPrimary true', async () => {
    renderDrawer(null, [titular]);
    fill('responsible-firstName', 'Nuevo');
    fill('responsible-lastName', 'Titular');
    fireEvent.click(screen.getByTestId('responsible-primary'));
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(createResponsible).toHaveBeenCalledTimes(1));
    expect(updateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'r1', { isPrimary: false });
    expect(updateResponsible.mock.invocationCallOrder[0]).toBeLessThan(createResponsible.mock.invocationCallOrder[0]);
    expect(createResponsible.mock.calls[0][1]).toMatchObject({ isPrimary: true });
  });

  it('(a) sem marcar: editar um não-titular NÃO toca no titular', async () => {
    renderDrawer(outro, [titular, outro]);
    fill('responsible-phone', '123');
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    expect(updateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'r2', expect.objectContaining({ isPrimary: false }));
  });

  it('(b) o PRIMEIRO familiar nasce titular: caixa marcada e travada, POST com isPrimary true', async () => {
    renderDrawer(null, []);
    expect(screen.getByTestId('responsible-primary')).toBeChecked();
    expect(screen.getByTestId('responsible-primary')).toBeDisabled();
    fill('responsible-firstName', 'Ana');
    fill('responsible-lastName', 'Diaz');
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(createResponsible).toHaveBeenCalledTimes(1));
    expect(createResponsible.mock.calls[0][1]).toMatchObject({ isPrimary: true });
    expect(updateResponsible).not.toHaveBeenCalled();
  });

  it('(c) o único titular não pode ser desmarcado (como o radio antigo): caixa travada, PATCH mantém isPrimary true e não toca em ninguém', async () => {
    renderDrawer(titular, [titular, outro]);
    expect(screen.getByTestId('responsible-primary')).toBeChecked();
    expect(screen.getByTestId('responsible-primary')).toBeDisabled();
    fireEvent.click(screen.getByTestId('responsible-primary'));
    fireEvent.click(screen.getByTestId('responsible-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    expect(updateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'r1', expect.objectContaining({ isPrimary: true }));
  });

  it('falha ao gravar DEPOIS de despromover o antigo: relê a lista (onSaved), mostra erro e não fecha', async () => {
    updateResponsible.mockResolvedValueOnce({ id: 'r1' }).mockRejectedValueOnce(new Error('boom'));
    const onSaved = vi.fn(); const onClose = vi.fn();
    renderDrawer(outro, [titular, outro], { onSaved, onClose });
    fireEvent.click(screen.getByTestId('responsible-primary'));
    fireEvent.click(screen.getByTestId('responsible-save'));
    await screen.findByTestId('responsible-error');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falha ANTES de mudar qualquer coisa (nada despromovido): não relê a lista', async () => {
    updateResponsible.mockRejectedValueOnce(new Error('boom'));
    const onSaved = vi.fn();
    renderDrawer(titular, [titular], { onSaved });
    fireEvent.click(screen.getByTestId('responsible-save'));
    await screen.findByTestId('responsible-error');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('quem só tem patient_family:create não consegue despromover o titular alheio → caixa travada', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['patient_family:create'], countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
    try {
      renderDrawer(null, [titular]);
      expect(screen.getByTestId('responsible-primary')).toBeDisabled();
    } finally {
      useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    }
  });
});

describe('PatientResponsibleEditDrawer — fechar', () => {
  it('Escape e clique no backdrop fecham sem mudança; outra tecla não', async () => {
    const onClose = vi.fn();
    renderDrawer(titular, [titular], { onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('responsible-edit-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2), { timeout: 2000 });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('COM mudança → Escape abre o DiscardChangesConfirm; "continuar" mantém o valor; "descartar" fecha', async () => {
    const onClose = vi.fn();
    renderDrawer(titular, [titular], { onClose });
    fill('responsible-firstName', 'Otro Nombre');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
    expect(screen.getByTestId('responsible-firstName')).toHaveValue('Otro Nombre');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('discard-changes-discard'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1500 });
  });
});
