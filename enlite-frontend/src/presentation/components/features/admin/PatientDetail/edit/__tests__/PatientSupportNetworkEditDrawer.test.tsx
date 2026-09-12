/**
 * PatientSupportNetworkEditDrawer — spec 018, PR-1, ADR-1 (SUP-37); lex C1.1 / C1.2 / C1.3.
 *
 * A seção passou a ser gravada POR LINHA: `PATCH /support-network` (a lista inteira) é 410. Estes
 * testes travam que cada linha nasce/muda/desaparece pela própria chamada (create/update/deactivate),
 * que editar uma linha NÃO chama a API das outras, que o titular é demovido ANTES de promover
 * outro (evita o 409 do índice único), e que o número do documento nunca é ecoado no erro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientResponsibleDetail } from '@domain/entities/PatientDetail';

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
const deactivateResponsible = vi.fn();
vi.mock('@infrastructure/http/AdminPatientContactRowsApiService', () => ({
  AdminPatientContactRowsApiService: {
    createResponsible: (...a: unknown[]) => createResponsible(...a),
    updateResponsible: (...a: unknown[]) => updateResponsible(...a),
    deactivateResponsible: (...a: unknown[]) => deactivateResponsible(...a),
  },
}));

import { PatientSupportNetworkEditDrawer } from '../PatientSupportNetworkEditDrawer';

const PATIENT_ID = 'a0000000-0000-0000-0000-000000000001';
const DOC_NUMBER = '987.654.321-00';

const responsible: PatientResponsibleDetail = {
  id: 'r1',
  firstName: 'Luciana',
  lastName: 'Soto',
  relationship: 'MOM',
  phone: '(11) 99852-0481',
  email: 'luciana.soto@example.com',
  documentType: 'CPF',
  documentNumber: DOC_NUMBER,
  isPrimary: true,
  displayOrder: 1,
  source: 'web_form',
};

function renderDrawer(rows: PatientResponsibleDetail[] = [responsible]) {
  return render(<PatientSupportNetworkEditDrawer patientId={PATIENT_ID} responsibles={rows} onClose={vi.fn()} onSaved={vi.fn()} />);
}

describe('PatientSupportNetworkEditDrawer — documento (A1) por LINHA', () => {
  beforeEach(() => {
    createResponsible.mockReset().mockResolvedValue({ id: 'novo' });
    updateResponsible.mockReset().mockResolvedValue({ id: 'r1' });
    deactivateResponsible.mockReset().mockResolvedValue({ id: 'r1', active: false });
  });

  it('C1.1 — carrega tipo e número do documento do responsável nos campos do drawer', () => {
    renderDrawer();
    expect(screen.getByTestId('psn-documentType-0')).toHaveValue('CPF');
    expect(screen.getByTestId('psn-documentNumber-0')).toHaveValue(DOC_NUMBER);
  });

  it('C1.1 — editar SÓ o telefone chama updateResponsible(patientId, id, patch) com o documento intacto', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('psn-phone-0'), { target: { value: '(11) 90000-0000' } });
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    expect(createResponsible).not.toHaveBeenCalled();
    expect(deactivateResponsible).not.toHaveBeenCalled();
    expect(updateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'r1', {
      firstName: 'Luciana',
      lastName: 'Soto',
      relationship: 'MOM',
      phone: '(11) 90000-0000',
      email: 'luciana.soto@example.com',
      documentType: 'CPF',
      documentNumber: DOC_NUMBER,
      isPrimary: true,
    });
  });

  it('limpar o número do documento manda null (limpar é uma edição, não um esquecimento)', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('psn-documentNumber-0'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    const patch = updateResponsible.mock.calls[0][2] as { documentNumber: string | null; documentType: string | null };
    expect(patch.documentNumber).toBeNull();
    expect(patch.documentType).toBe('CPF');
  });

  it('trocar o tipo de documento pelo select vai no PATCH', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('psn-documentType-0'), { target: { value: 'DNI' } });
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(1));
    const patch = updateResponsible.mock.calls[0][2] as { documentType: string | null };
    expect(patch.documentType).toBe('DNI');
  });

  it('C1.2 — familiar NOVO chama createResponsible (sem id), nunca herda origem', async () => {
    renderDrawer([]);
    fireEvent.click(screen.getByTestId('psn-add'));
    fireEvent.change(screen.getByTestId('psn-firstName-0'), { target: { value: 'Nuevo' } });
    fireEvent.change(screen.getByTestId('psn-lastName-0'), { target: { value: 'Familiar' } });
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(createResponsible).toHaveBeenCalledTimes(1));
    expect(updateResponsible).not.toHaveBeenCalled();
    const [pid, payload] = createResponsible.mock.calls[0] as [string, Record<string, unknown>];
    expect(pid).toBe(PATIENT_ID);
    expect(payload).toMatchObject({ firstName: 'Nuevo', lastName: 'Familiar', documentType: null, documentNumber: null, isPrimary: true });
    expect(payload).not.toHaveProperty('source');
    expect(payload).not.toHaveProperty('displayOrder');
  });

  it('C1.3 — a mensagem de erro NUNCA ecoa o número do documento (mesmo que a API o devolva)', async () => {
    updateResponsible.mockRejectedValueOnce(new Error(`Validation failed for documentNumber ${DOC_NUMBER}`));
    renderDrawer();
    fireEvent.click(screen.getByTestId('psn-save'));
    const err = await screen.findByTestId('psn-error');
    expect(err.textContent).not.toContain(DOC_NUMBER);
    expect(err.textContent).toBe('Erro ao salvar');
  });

  // Achado do gate `revisao-pr`: a escrita por linha é uma sequência de chamadas sem transação
  // única — se a 2ª falhar, a 1ª já foi gravada no servidor. Sem reler a lista, o card por trás
  // do drawer continuava mostrando o snapshot de ANTES do submit, mentindo sobre o que já salvou.
  it('quando UMA chamada falha no meio da sequência, o drawer RELÊ a lista (onSaved) sem fechar — a tela não mente sobre o que já foi gravado', async () => {
    createResponsible.mockResolvedValueOnce({ id: 'novo-1' }).mockRejectedValueOnce(new Error('boom'));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<PatientSupportNetworkEditDrawer patientId={PATIENT_ID} responsibles={[]} onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('psn-add'));
    fireEvent.change(screen.getByTestId('psn-firstName-0'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByTestId('psn-lastName-0'), { target: { value: 'Diaz' } });
    fireEvent.click(screen.getByTestId('psn-add'));
    fireEvent.change(screen.getByTestId('psn-firstName-1'), { target: { value: 'Beatriz' } });
    fireEvent.change(screen.getByTestId('psn-lastName-1'), { target: { value: 'Diaz' } });
    fireEvent.click(screen.getByTestId('psn-save'));

    await screen.findByTestId('psn-error');
    expect(createResponsible).toHaveBeenCalledTimes(2); // a 1ª foi, a 2ª morreu
    expect(onSaved).toHaveBeenCalledTimes(1); // relê a lista MESMO no erro
    expect(onClose).not.toHaveBeenCalled(); // mas o drawer continua aberto — a pessoa vê o erro
  });
});

// ── Cobertura 100 % do arquivo (D200): nulos, primário, remover, validação, fechar ──

describe('PatientSupportNetworkEditDrawer — todos os ramos', () => {
  beforeEach(() => {
    createResponsible.mockReset().mockResolvedValue({ id: 'novo' });
    updateResponsible.mockReset().mockResolvedValue({ id: 'r1' });
    deactivateResponsible.mockReset().mockResolvedValue({ id: 'r1', active: false });
  });

  it('responsável com campos nulos carrega vazio; lista ausente vira vazia', () => {
    const nulls: PatientResponsibleDetail = { id: 'r0', firstName: null, lastName: null, relationship: null, phone: null, email: null, documentType: null, documentNumber: null, isPrimary: false, displayOrder: 1, source: 'clickup' };
    const { unmount } = renderDrawer([nulls]);
    for (const id of ['psn-firstName-0', 'psn-lastName-0', 'psn-rel-0', 'psn-phone-0', 'psn-email-0', 'psn-documentNumber-0']) {
      expect(screen.getByTestId(id)).toHaveValue('');
    }
    expect(screen.getByTestId('psn-documentType-0')).toHaveValue('');
    expect(screen.getByTestId('psn-primary-0')).not.toBeChecked();
    unmount();
    render(<PatientSupportNetworkEditDrawer patientId={PATIENT_ID} responsibles={undefined as unknown as []} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('psn-empty')).toBeInTheDocument();
  });

  it('ninguém marcado como principal → o primeiro vira principal ao salvar; marcar outro DEMOVE o antigo titular ANTES de promover (evita 409 do índice único)', async () => {
    const chamadasEmOrdem: string[] = [];
    updateResponsible.mockImplementation(async (_pid: string, id: string, patch: { isPrimary: boolean }) => {
      chamadasEmOrdem.push(`${id}:${patch.isPrimary}`);
      return { id };
    });
    const second: PatientResponsibleDetail = { ...responsible, id: 'r2', firstName: 'Pedro', isPrimary: false };
    renderDrawer([{ ...responsible, isPrimary: false }, second]);
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(2));
    // r1 vira titular (só ele existia sem marcação): a linha titular (r1) é a ÚLTIMA chamada.
    expect(chamadasEmOrdem).toEqual(['r2:false', 'r1:true']);

    chamadasEmOrdem.length = 0;
    fireEvent.click(screen.getByTestId('psn-primary-1'));
    expect(screen.getByTestId('psn-primary-1')).toBeChecked();
    expect(screen.getByTestId('psn-primary-0')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(updateResponsible).toHaveBeenCalledTimes(4));
    // Agora r2 é o titular novo: r1 (que estava titular) é demovido PRIMEIRO, r2 promovido por ÚLTIMO.
    expect(chamadasEmOrdem).toEqual(['r1:false', 'r2:true']);
  });

  it('remover um familiar EXISTENTE chama deactivateResponsible com o id dele; a linha some da tela na hora', async () => {
    renderDrawer([responsible, { ...responsible, id: 'r2', firstName: 'Pedro', isPrimary: false }]);
    fireEvent.click(screen.getByTestId('psn-remove-1'));
    expect(screen.queryByTestId('psn-row-1')).toBeNull();
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(deactivateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'r2'));
    expect(updateResponsible).toHaveBeenCalledTimes(1); // só a linha que ficou (r1)
    expect(updateResponsible).not.toHaveBeenCalledWith(PATIENT_ID, 'r2', expect.anything());
  });

  it('remover uma linha NOVA (sem id, ainda não salva) NÃO chama deactivate — ela só some do formulário', async () => {
    renderDrawer([]);
    fireEvent.click(screen.getByTestId('psn-add'));
    fireEvent.click(screen.getByTestId('psn-remove-0'));
    expect(screen.getByTestId('psn-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(screen.queryByTestId('patient-support-edit-drawer')).not.toBeNull());
    expect(deactivateResponsible).not.toHaveBeenCalled();
    expect(createResponsible).not.toHaveBeenCalled();
  });

  it('nome/sobrenome vazios e e-mail inválido: erros na tela, sem chamar a API', async () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('psn-firstName-0'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('psn-lastName-0'), { target: { value: ' ' } });
    fireEvent.change(screen.getByTestId('psn-email-0'), { target: { value: 'invalido' } });
    fireEvent.click(screen.getByTestId('psn-save'));
    // Spec 014 (US-D4): a mensagem do zod é a CHAVE i18n, traduzida no render (`terr`) — nunca
    // mais o default em inglês do zod ("String must contain at least 1 character(s)").
    expect((await screen.findAllByText(t('admin.patients.editDrawer.requiredField'))).length).toBe(2);
    expect(screen.getByText(/Invalid email/)).toBeInTheDocument();
    expect(updateResponsible).not.toHaveBeenCalled();
    expect(createResponsible).not.toHaveBeenCalled();
  });

  it('Escape e clique no backdrop fecham; outra tecla não', async () => {
    const onClose = vi.fn();
    render(<PatientSupportNetworkEditDrawer patientId={PATIENT_ID} responsibles={[responsible]} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2000 });
    fireEvent.click(screen.getByTestId('patient-support-edit-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2), { timeout: 2000 });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): drawer não perde trabalho ──────────────────────
  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('COM mudança (editar um nome) → Escape abre confirmação em vez de fechar', () => {
      renderDrawer();
      fireEvent.change(screen.getByTestId('psn-firstName-0'), { target: { value: 'Otro Nombre' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(screen.getByTestId('psn-firstName-0')).toHaveValue('Otro Nombre');
    });

    it('adicionar uma linha (useFieldArray) também conta como dirty', () => {
      renderDrawer();
      fireEvent.click(screen.getByTestId('psn-add'));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    });

    it('"Descartar cambios" fecha de verdade', async () => {
      const onClose = vi.fn();
      render(<PatientSupportNetworkEditDrawer patientId={PATIENT_ID} responsibles={[responsible]} onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('psn-firstName-0'), { target: { value: 'Otro Nombre' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1500 });
    });
  });
});
