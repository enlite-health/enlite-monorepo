/**
 * PatientSupportNetworkEditDrawer — spec 018, PR-1, ADR-1 (SUP-37); lex C1.1 / C1.2 / C1.3.
 *
 * A seção passou a ser gravada POR LINHA: `PATCH /support-network` (a lista inteira) é 410. Estes
 * testes travam que cada linha nasce/muda/desaparece pela própria chamada (create/update/deactivate),
 * que editar uma linha NÃO chama a API das outras, que o titular é demovido ANTES de promover
 * outro (evita o 409 do índice único), e que o número do documento nunca é ecoado no erro.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  // ACHADO 2 (018/PR-1, PR #359): sem gravar o id REAL devolvido de volta no form, um retry
  // após a falha de UMA linha reenviava as linhas JÁ CRIADAS com sucesso como POST de novo —
  // duplicando-as no servidor a cada tentativa de Guardar. O laço aborta na 1ª falha (política
  // antiga); a linha seguinte à que falhou nunca chega a ser tentada na 1ª rodada.
  it('ACHADO 2 — 1º Guardar cria as linhas até a falha; 2º Guardar NÃO recria a que já tinha sido salva', async () => {
    createResponsible.mockReset()
      .mockResolvedValueOnce({ id: 'novo-0' }) // linha 0 (Ana): sucesso
      .mockRejectedValueOnce(new Error('boom')) // linha 1 (Beatriz): falha — aborta o laço
      .mockResolvedValueOnce({ id: 'novo-1' }) // linha 1 no reenvio: sucesso
      .mockResolvedValueOnce({ id: 'novo-2' }); // linha 2 (Carla), só tentada no reenvio: sucesso
    updateResponsible.mockReset().mockResolvedValue({ id: 'ok' });

    render(<PatientSupportNetworkEditDrawer patientId={PATIENT_ID} responsibles={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const [i, nome] of ['Ana', 'Beatriz', 'Carla'].entries()) {
      fireEvent.click(screen.getByTestId('psn-add'));
      fireEvent.change(screen.getByTestId(`psn-firstName-${i}`), { target: { value: nome } });
      fireEvent.change(screen.getByTestId(`psn-lastName-${i}`), { target: { value: 'Diaz' } });
    }
    // Marca a ÚLTIMA linha como titular explicitamente — preserva a ordem de chamada 0,1,2
    // (senão o "ninguém marcado → o primeiro vira titular" reordenaria a linha 0 pro final).
    fireEvent.click(screen.getByTestId('psn-primary-2'));

    fireEvent.click(screen.getByTestId('psn-save'));
    await screen.findByTestId('psn-error');
    // Aborta na falha da linha 1: a linha 2 (Carla) nunca chega a ser tentada nesta rodada.
    expect(createResponsible).toHaveBeenCalledTimes(2);
    expect(createResponsible.mock.calls.map((c) => (c[1] as { firstName: string }).firstName)).toEqual(['Ana', 'Beatriz']);
    expect(updateResponsible).not.toHaveBeenCalled();

    // Reenvio: linha 0 (Ana) já tem id real — vira UPDATE. Linha 1 (Beatriz) e linha 2 (Carla,
    // pela 1ª vez) continuam sem id — ambas chamam createResponsible.
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(createResponsible).toHaveBeenCalledTimes(4));
    expect(updateResponsible).toHaveBeenCalledTimes(1);
    expect(updateResponsible).toHaveBeenCalledWith(PATIENT_ID, 'novo-0', expect.objectContaining({ firstName: 'Ana' }));
    // As 3ª/4ª chamadas de createResponsible são Beatriz (retry) e Carla (1ª tentativa) — nenhuma
    // duplica Ana, que já saiu do laço de criação.
    expect(createResponsible.mock.calls[2][1]).toMatchObject({ firstName: 'Beatriz' });
    expect(createResponsible.mock.calls[3][1]).toMatchObject({ firstName: 'Carla' });
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

  // CR-1 (achado do gate revisao-pr): antes, `toDeactivateRef` só era limpo DEPOIS do laço
  // inteiro — se a 2ª de 3 desativações falhasse, a 1ª (já desativada no servidor) continuava
  // no ref, e o reenvio tentava desativá-la de novo (409 already_inactive) para sempre.
  it('CR-1 — falha na 2ª de 2 desativações: reenviar tenta SÓ a que faltou, nunca a que já desativou', async () => {
    deactivateResponsible.mockReset()
      .mockResolvedValueOnce({ id: 'r2', active: false }) // 1ª chamada: sucesso
      .mockRejectedValueOnce(new Error('boom')) // 2ª chamada: falha
      .mockResolvedValueOnce({ id: 'r3', active: false }); // no reenvio: sucesso
    renderDrawer([
      responsible,
      { ...responsible, id: 'r2', firstName: 'Pedro', isPrimary: false },
      { ...responsible, id: 'r3', firstName: 'Rita', isPrimary: false },
    ]);
    fireEvent.click(screen.getByTestId('psn-remove-1')); // remove Pedro (r2) — 1º no ref
    fireEvent.click(screen.getByTestId('psn-remove-1')); // (era o índice 2/Rita, reindexado após a remoção acima) remove Rita (r3) — 2º no ref
    fireEvent.click(screen.getByTestId('psn-save'));

    await screen.findByTestId('psn-error');
    expect(deactivateResponsible).toHaveBeenCalledTimes(2);
    expect(deactivateResponsible).toHaveBeenNthCalledWith(1, PATIENT_ID, 'r2');
    expect(deactivateResponsible).toHaveBeenNthCalledWith(2, PATIENT_ID, 'r3');

    // Reenvio: só 'r3' deveria ser tentado de novo — 'r2' já saiu do ref (sucesso anterior).
    fireEvent.click(screen.getByTestId('psn-save'));
    await waitFor(() => expect(deactivateResponsible).toHaveBeenCalledTimes(3));
    expect(deactivateResponsible).toHaveBeenNthCalledWith(3, PATIENT_ID, 'r3');
    // 'r2' só apareceu UMA vez em todas as chamadas (a 1ª) — nunca repetiu, nunca levaria 409.
    const chamadasComR2 = (deactivateResponsible.mock.calls as unknown as Array<[string, string]>).filter(([, id]) => id === 'r2');
    expect(chamadasComR2).toHaveLength(1);
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

// ── Conserto rodada B (Gabriel 15/09): adicionar linha exige `create`, editar linha EXISTENTE
// exige `update` — o drawer faz POST E PATCH, quem só tem uma das duas não pode fazer a outra. ──
function comEnforcement(permissions: string[]) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
}

describe('PatientSupportNetworkEditDrawer — gate create×update por linha (PR-8b rodada B)', () => {
  afterEach(() => { useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }); });

  it('só create: "Adicionar" existe; linha EXISTENTE fica somente-leitura (sem remover, sem editar)', () => {
    comEnforcement(['patient_family:create']);
    renderDrawer([responsible]);
    expect(screen.getByTestId('psn-add')).toBeInTheDocument();
    expect(screen.getByTestId('psn-firstName-0')).toBeDisabled();
    expect(screen.queryByTestId('psn-remove-0')).not.toBeInTheDocument();
  });

  it('só update: "Adicionar" some; linha EXISTENTE é editável e removível', () => {
    comEnforcement(['patient_family:update']);
    renderDrawer([responsible]);
    expect(screen.queryByTestId('psn-add')).not.toBeInTheDocument();
    expect(screen.getByTestId('psn-firstName-0')).not.toBeDisabled();
    expect(screen.getByTestId('psn-remove-0')).toBeInTheDocument();
  });

  it('as duas: comportamento de hoje — adiciona E edita linha existente', () => {
    comEnforcement(['patient_family:create', 'patient_family:update']);
    renderDrawer([responsible]);
    expect(screen.getByTestId('psn-add')).toBeInTheDocument();
    expect(screen.getByTestId('psn-firstName-0')).not.toBeDisabled();
    expect(screen.getByTestId('psn-remove-0')).toBeInTheDocument();
  });

  it('nenhuma: sem "Adicionar"; linha existente somente-leitura', () => {
    comEnforcement([]);
    renderDrawer([responsible]);
    expect(screen.queryByTestId('psn-add')).not.toBeInTheDocument();
    expect(screen.getByTestId('psn-firstName-0')).toBeDisabled();
    expect(screen.queryByTestId('psn-remove-0')).not.toBeInTheDocument();
  });

  it('só create: linha NOVA (recém-adicionada) fica editável e removível — a permissão de criar cobre a linha que ela mesma criou', () => {
    comEnforcement(['patient_family:create']);
    renderDrawer([]);
    fireEvent.click(screen.getByTestId('psn-add'));
    expect(screen.getByTestId('psn-firstName-0')).not.toBeDisabled();
    expect(screen.getByTestId('psn-remove-0')).toBeInTheDocument();
  });
});
