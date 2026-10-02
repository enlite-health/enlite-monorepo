/**
 * PatientDocumentsSection — spec 031 (P1, P3, P4, P5): vazio, lista, subir, ver, renomear, excluir
 * com confirmação e os gates por célula. O serviço HTTP é o único mock (borda de rede).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { i18nMock, setCells, syntheticDoc } from './documentsTestKit';

vi.mock('react-i18next', () => i18nMock);

const svc = vi.hoisted(() => ({
  listPatientDocuments: vi.fn(),
  uploadPatientDocument: vi.fn(),
  renamePatientDocument: vi.fn(),
  deletePatientDocument: vi.fn(),
  getPatientDocumentUrl: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminPatientDocumentsApiService', () => ({ AdminPatientDocumentsApiService: svc }));

import { PatientDocumentsSection } from '../PatientDocumentsSection';

const ALL = ['patient_document:read', 'patient_document:create', 'patient_document:update', 'patient_document:delete'];

const first = syntheticDoc({ id: 'd1', label: 'DNI frente' });
const second = syntheticDoc({ id: 'd2', label: 'Resumen', origin: 'chat' });

async function renderLoaded(docs = [first, second]) {
  svc.listPatientDocuments.mockResolvedValue(docs);
  render(<PatientDocumentsSection patientId="p1" />);
  await screen.findByTestId(docs.length ? 'patient-documents-list' : 'patient-documents-empty');
}

beforeEach(() => {
  Object.values(svc).forEach((m) => m.mockReset());
  setCells(ALL);
});
afterEach(() => { setCells(null); vi.unstubAllGlobals(); });

describe('PatientDocumentsSection — lista', () => {
  it('carregando mostra "Cargando...", depois a lista na ordem do servidor, pedida para o paciente certo', async () => {
    svc.listPatientDocuments.mockResolvedValue([first, second]);
    render(<PatientDocumentsSection patientId="p1" />);
    expect(screen.getByTestId('patient-documents-loading')).toHaveTextContent('Cargando...');
    await screen.findByTestId('patient-documents-list');
    expect(svc.listPatientDocuments).toHaveBeenCalledWith('p1');
    const rows = screen.getAllByTestId(/^patient-document-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['patient-document-row-d1', 'patient-document-row-d2']);
    expect(screen.queryByTestId('patient-documents-loading')).not.toBeInTheDocument();
  });

  it('sem documentos → texto "No hay documentos" (não uma lista muda)', async () => {
    await renderLoaded([]);
    expect(screen.getByTestId('patient-documents-empty')).toHaveTextContent('No hay documentos');
    expect(screen.queryByTestId('patient-documents-list')).not.toBeInTheDocument();
  });

  it('falha ao carregar → alerta, sem "No hay documentos" (erro não é vazio)', async () => {
    svc.listPatientDocuments.mockRejectedValue(new Error('rede'));
    render(<PatientDocumentsSection patientId="p1" />);
    expect(await screen.findByTestId('patient-documents-load-error')).toHaveTextContent('No pudimos cargar los documentos');
    expect(screen.queryByTestId('patient-documents-empty')).not.toBeInTheDocument();
  });
});

describe('PatientDocumentsSection — subir', () => {
  it('subir põe o item novo no TOPO e limpa o formulário', async () => {
    await renderLoaded();
    const created = syntheticDoc({ id: 'd3', label: 'Nuevo' });
    svc.uploadPatientDocument.mockResolvedValue(created);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    await userEvent.type(screen.getByTestId('patient-document-label-input'), 'Nuevo');
    await userEvent.upload(screen.getByTestId('patient-document-file-input'), file);
    await userEvent.click(screen.getByTestId('patient-document-upload'));
    expect(svc.uploadPatientDocument).toHaveBeenCalledWith('p1', 'Nuevo', file);
    const rows = await screen.findAllByTestId(/^patient-document-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'patient-document-row-d3');
    expect(rows).toHaveLength(3);
  });

  it('o primeiro documento sai do estado vazio para a lista', async () => {
    await renderLoaded([]);
    svc.uploadPatientDocument.mockResolvedValue(first);
    await userEvent.type(screen.getByTestId('patient-document-label-input'), 'DNI frente');
    await userEvent.upload(screen.getByTestId('patient-document-file-input'), new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    await userEvent.click(screen.getByTestId('patient-document-upload'));
    expect(await screen.findByTestId('patient-document-row-d1')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-documents-empty')).not.toBeInTheDocument();
  });
});

describe('PatientDocumentsSection — renomear', () => {
  it('lápis → novo nome → Enter: a lista mostra o nome novo', async () => {
    await renderLoaded();
    svc.renamePatientDocument.mockResolvedValue({ ...first, label: 'DNI dorso' });
    await userEvent.click(within(screen.getByTestId('patient-document-row-d1')).getByRole('button', { name: 'Renombrar' }));
    const input = screen.getByTestId('patient-document-rename-input-d1');
    await userEvent.clear(input);
    await userEvent.type(input, 'DNI dorso{Enter}');
    expect(svc.renamePatientDocument).toHaveBeenCalledWith('p1', 'd1', 'DNI dorso');
    expect(await screen.findByTestId('patient-document-name-d1')).toHaveTextContent('DNI dorso');
    expect(screen.getByTestId('patient-document-name-d2')).toHaveTextContent('Resumen');
  });
});

describe('PatientDocumentsSection — excluir com confirmação', () => {
  const openDialog = async (id = 'd1') => {
    await userEvent.click(within(screen.getByTestId(`patient-document-row-${id}`)).getByRole('button', { name: 'Eliminar' }));
    return screen.getByRole('dialog');
  };

  it('o ícone abre o diálogo com o nome; Cancelar e Esc deixam o item e não chamam o servidor', async () => {
    await renderLoaded();
    const dialog = await openDialog();
    expect(dialog).toHaveAccessibleName(/^¿Eliminar «\s*DNI frente\s*»\?$/);
    expect(screen.getByTestId('patient-document-delete-cancel')).toHaveFocus();
    await userEvent.click(screen.getByTestId('patient-document-delete-cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openDialog();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(svc.deletePatientDocument).not.toHaveBeenCalled();
    expect(screen.getByTestId('patient-document-row-d1')).toBeInTheDocument();
  });

  it('Eliminar exclui, fecha o diálogo e tira a linha', async () => {
    await renderLoaded();
    svc.deletePatientDocument.mockResolvedValue(undefined);
    await openDialog();
    await userEvent.click(screen.getByTestId('patient-document-delete-yes'));
    expect(svc.deletePatientDocument).toHaveBeenCalledWith('p1', 'd1');
    await vi.waitFor(() => expect(screen.queryByTestId('patient-document-row-d1')).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('patient-document-row-d2')).toBeInTheDocument();
  });

  it('falha ao excluir: o diálogo fica com a mensagem, o item continua e dá para cancelar', async () => {
    await renderLoaded();
    svc.deletePatientDocument.mockRejectedValue(new Error('rede'));
    await openDialog();
    await userEvent.click(screen.getByTestId('patient-document-delete-yes'));
    expect(await screen.findByTestId('patient-document-delete-error')).toHaveTextContent('No pudimos eliminar el documento');
    expect(screen.getByTestId('patient-document-row-d1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('patient-document-delete-cancel'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // reabrir não mostra o erro velho
    await openDialog();
    expect(screen.queryByTestId('patient-document-delete-error')).not.toBeInTheDocument();
  });

  it('documento sem nome decifrado: o diálogo usa o rótulo genérico', async () => {
    await renderLoaded([syntheticDoc({ id: 'd9', label: null })]);
    const dialog = await openDialog('d9');
    expect(dialog).toHaveAccessibleName(/^¿Eliminar «\s*Documento sin nombre\s*»\?$/);
  });
});

describe('PatientDocumentsSection — ver', () => {
  const popup = () => ({ opener: 'x' as unknown, closed: false, close: vi.fn(), location: { href: '' } });

  it('pede a URL a cada clique e abre em nova aba', async () => {
    await renderLoaded();
    const p = popup();
    vi.stubGlobal('open', vi.fn().mockReturnValue(p));
    svc.getPatientDocumentUrl.mockResolvedValue({ url: 'https://signed.example/doc', expiresInSeconds: 300 });
    const view = within(screen.getByTestId('patient-document-row-d2')).getByRole('button', { name: 'Ver' });
    await userEvent.click(view);
    await userEvent.click(view);
    expect(svc.getPatientDocumentUrl).toHaveBeenCalledTimes(2);
    expect(svc.getPatientDocumentUrl).toHaveBeenCalledWith('p1', 'd2');
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(p.location.href).toBe('https://signed.example/doc');
    expect(p.opener).toBeNull();
  });

  it('pop-up bloqueado → alerta es-AR e nenhuma URL é pedida', async () => {
    await renderLoaded();
    vi.stubGlobal('open', vi.fn().mockReturnValue(null));
    await userEvent.click(within(screen.getByTestId('patient-document-row-d1')).getByRole('button', { name: 'Ver' }));
    expect(screen.getByTestId('patient-documents-view-error')).toHaveTextContent('bloqueó la ventana emergente');
    expect(svc.getPatientDocumentUrl).not.toHaveBeenCalled();
  });

  it('URL falha → fecha a aba em branco e mostra o erro; o próximo clique limpa o erro', async () => {
    await renderLoaded();
    const p = popup();
    vi.stubGlobal('open', vi.fn().mockReturnValue(p));
    svc.getPatientDocumentUrl.mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ url: 'https://s/x', expiresInSeconds: 300 });
    const view = within(screen.getByTestId('patient-document-row-d1')).getByRole('button', { name: 'Ver' });
    await userEvent.click(view);
    expect(await screen.findByTestId('patient-documents-view-error')).toHaveTextContent('No pudimos abrir el documento');
    expect(p.close).toHaveBeenCalledTimes(1);
    await userEvent.click(view);
    expect(screen.queryByTestId('patient-documents-view-error')).not.toBeInTheDocument();
  });
});

describe('PatientDocumentsSection — gates por célula (engine ligado)', () => {
  it('só read: sem formulário, sem lápis, sem excluir; a lista e o "Ver" continuam', async () => {
    setCells(['patient_document:read']);
    await renderLoaded();
    expect(screen.queryByTestId('patient-document-upload-form')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Renombrar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Ver' })).toHaveLength(2);
  });

  it('só create → formulário, sem lápis nem excluir', async () => {
    setCells(['patient_document:read', 'patient_document:create']);
    await renderLoaded();
    expect(screen.getByTestId('patient-document-upload-form')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Renombrar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
  });

  it('só update → lápis; só delete → excluir', async () => {
    setCells(['patient_document:read', 'patient_document:update']);
    await renderLoaded();
    expect(screen.getAllByRole('button', { name: 'Renombrar' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-document-upload-form')).not.toBeInTheDocument();
  });

  it('só delete → excluir, sem lápis nem formulário', async () => {
    setCells(['patient_document:read', 'patient_document:delete']);
    await renderLoaded();
    expect(screen.getAllByRole('button', { name: 'Eliminar' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Renombrar' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-document-upload-form')).not.toBeInTheDocument();
  });

  it('engine desligado (sem authz): tudo liberado, como o resto da ficha', async () => {
    setCells(null);
    await renderLoaded();
    expect(screen.getByTestId('patient-document-upload-form')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Renombrar' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Eliminar' })).toHaveLength(2);
  });
});
