/**
 * PatientDocumentsCard — spec 018, PR-4 (task 4.10; furo fechado 14/09). Cobre carregar do
 * SERVIDOR no mount (`listPatientDocuments` + `getVigenteImageConsent`), upload de documento,
 * abrir por `blob:`, registrar/revogar consentimento (recarrega do servidor após cada ação) e os
 * gates de célula (D269/D286): sem `patient_consent_documents:read` a lista não existe na árvore;
 * sem `patient_identity:write` nem upload nem consentimento aparecem; sem NENHUMA das duas, o
 * cartão inteiro não renderiza.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const translations = ptBR as Record<string, any>;
function t(key: string): string {
  let current: any = translations;
  for (const part of key.split('.')) current = current?.[part];
  return typeof current === 'string' ? current : key;
}
let currentLang = 'pt-BR';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { get language() { return currentLang; } } }) }));

const uploadPatientDocument = vi.fn();
const getPatientDocumentUrl = vi.fn();
const listPatientDocuments = vi.fn();
const registerImageConsent = vi.fn();
const revokeImageConsent = vi.fn();
const getVigenteImageConsent = vi.fn();
const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(message: string, status = 400) { super(message); this.status = status; }
  },
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    uploadPatientDocument: (...a: unknown[]) => uploadPatientDocument(...a),
    getPatientDocumentUrl: (...a: unknown[]) => getPatientDocumentUrl(...a),
    listPatientDocuments: (...a: unknown[]) => listPatientDocuments(...a),
    registerImageConsent: (...a: unknown[]) => registerImageConsent(...a),
    revokeImageConsent: (...a: unknown[]) => revokeImageConsent(...a),
    getVigenteImageConsent: (...a: unknown[]) => getVigenteImageConsent(...a),
  },
  ApiError: FakeApiError,
}));

const { PatientDocumentsCard } = await import('../PatientDocumentsCard');

function withPermissions(permissions: string[], enforcement: AuthzContract['enforcement'] = 'on') {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

function makeFile(name: string, type: string, sizeBytes: number): File {
  const file = new File([new Uint8Array(Math.min(sizeBytes, 1024))], name, { type });
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
}

const DOC_ROW = { id: 'doc-1', documentType: 'image_consent' as const, contentType: 'application/pdf' as const, sizeBytes: 1024, uploadedAt: '2026-09-14T10:00:00.000Z' };

const originalFetch = global.fetch;
const originalCreateObjectURL = (URL as any).createObjectURL;
const originalOpen = window.open;

describe('PatientDocumentsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentLang = 'pt-BR';
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    listPatientDocuments.mockResolvedValue([]);
    getVigenteImageConsent.mockResolvedValue(null);
    global.fetch = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(['x'])) }) as any;
    (URL as any).createObjectURL = vi.fn().mockReturnValue('blob:fake');
    window.open = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (URL as any).createObjectURL = originalCreateObjectURL;
    window.open = originalOpen;
  });

  it('sem NENHUMA das duas células: o cartão não renderiza (e não chama a API)', async () => {
    withPermissions([]);
    const { container } = render(<PatientDocumentsCard patientId="p1" />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(listPatientDocuments).not.toHaveBeenCalled());
    expect(getVigenteImageConsent).not.toHaveBeenCalled();
  });

  it('só com patient_consent_documents:read: carrega a lista (vazia) do servidor, mas não upload/consentimento', async () => {
    withPermissions(['patient_consent_documents:read']);
    render(<PatientDocumentsCard patientId="p1" />);
    await waitFor(() => expect(listPatientDocuments).toHaveBeenCalledWith('p1'));
    expect(getVigenteImageConsent).not.toHaveBeenCalled();
    expect(await screen.findByTestId('patient-documents-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-document-upload-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-consent-register-btn')).not.toBeInTheDocument();
  });

  it('só com patient_identity:write: mostra upload e consentimento, mas não a lista de documentos (mostra o aviso de permissão no lugar)', async () => {
    withPermissions(['patient_identity:write']);
    render(<PatientDocumentsCard patientId="p1" />);
    await waitFor(() => expect(getVigenteImageConsent).toHaveBeenCalledWith('p1'));
    expect(listPatientDocuments).not.toHaveBeenCalled();
    expect(screen.getByTestId('patient-document-upload-btn')).toBeInTheDocument();
    expect(screen.getByTestId('patient-consent-register-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-documents-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('patient-documents-no-permission')).toBeInTheDocument();
  });

  it('achado 2 (prova da stage 15/09): patient_identity:write sem patient_consent_documents:read — sobe, vê "Documento enviado", nunca chama GET .../documents', async () => {
    withPermissions(['patient_identity:write']);
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    render(<PatientDocumentsCard patientId="p1" />);
    await waitFor(() => expect(getVigenteImageConsent).toHaveBeenCalledWith('p1'));
    expect(screen.getByTestId('patient-documents-no-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-document-upload-success')).not.toBeInTheDocument();

    const file = makeFile('consentimento.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(uploadPatientDocument).toHaveBeenCalledWith('p1', file, 'image_consent'));

    expect(await screen.findByTestId('patient-document-upload-success')).toBeInTheDocument();
    expect(listPatientDocuments).not.toHaveBeenCalled();
    expect(screen.queryByTestId('patient-documents-list')).not.toBeInTheDocument();
  });

  it('achado 2: COM patient_consent_documents:read, comportamento fica igual ao de hoje — sem aviso de permissão, sem banner de sucesso extra', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    listPatientDocuments.mockResolvedValueOnce([]).mockResolvedValueOnce([DOC_ROW]);
    render(<PatientDocumentsCard patientId="p1" />);
    await waitFor(() => expect(listPatientDocuments).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('patient-documents-no-permission')).not.toBeInTheDocument();

    const file = makeFile('consentimento.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(uploadPatientDocument).toHaveBeenCalled());
    expect(await screen.findByTestId('patient-document-row')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-document-upload-success')).not.toBeInTheDocument();
  });

  it('idioma diferente de pt-BR (es-AR): formata a data com o locale espanhol', async () => {
    currentLang = 'es';
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockResolvedValue([DOC_ROW]);
    render(<PatientDocumentsCard patientId="p1" />);
    expect(await screen.findByTestId('patient-document-row')).toBeInTheDocument();
  });

  it('mount com as DUAS células: carrega documento persistido do servidor (sem nenhum upload nesta sessão)', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockResolvedValue([DOC_ROW]);
    render(<PatientDocumentsCard patientId="p1" />);
    expect(await screen.findByTestId('patient-document-row')).toBeInTheDocument();
    expect(screen.getByText(/Consentimento de imagem — /)).toBeInTheDocument();
  });

  it('mount com consentimento vigente já registrado no servidor: mostra o status revogável direto', async () => {
    withPermissions(['patient_identity:write']);
    getVigenteImageConsent.mockResolvedValue({ id: 'consent-1', consenterKind: 'PATIENT', consentedAt: '2026-09-14T10:00:00.000Z' });
    render(<PatientDocumentsCard patientId="p1" />);
    expect(await screen.findByTestId('patient-consent-status')).toBeInTheDocument();
    expect(screen.getByTestId('patient-consent-revoke-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-consent-register-btn')).not.toBeInTheDocument();
  });

  it('upload feliz: recarrega do servidor e o documento aparece na lista; permite abrir por blob:', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    listPatientDocuments.mockResolvedValueOnce([]).mockResolvedValueOnce([DOC_ROW]);
    getPatientDocumentUrl.mockResolvedValue({ url: 'https://signed.example/doc.pdf', expiresInSeconds: 300 });
    render(<PatientDocumentsCard patientId="p1" />);
    await waitFor(() => expect(listPatientDocuments).toHaveBeenCalledTimes(1));
    const file = makeFile('consentimento.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(uploadPatientDocument).toHaveBeenCalledWith('p1', file, 'image_consent'));
    await waitFor(() => expect(listPatientDocuments).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('patient-document-row')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('patient-document-open-btn'));
    await waitFor(() => expect(getPatientDocumentUrl).toHaveBeenCalledWith('p1', 'doc-1'));
    await waitFor(() => expect(window.open).toHaveBeenCalledWith('blob:fake', '_blank', 'noopener,noreferrer'));
  });

  it('clicar no botão "Subir documento" aciona o input de arquivo oculto', async () => {
    withPermissions(['patient_identity:write']);
    render(<PatientDocumentsCard patientId="p1" />);
    await waitFor(() => expect(getVigenteImageConsent).toHaveBeenCalled());
    const input = screen.getByTestId('patient-document-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('patient-document-upload-btn'));
    expect(clickSpy).toHaveBeenCalled();
  });

  it('upload com tipo inválido: mostra erro, nunca chama a API', async () => {
    withPermissions(['patient_identity:write']);
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('foto.png', 'image/png', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-documents-error');
    expect(uploadPatientDocument).not.toHaveBeenCalled();
  });

  it('upload maior que 5MB: mostra erro, nunca chama a API', async () => {
    withPermissions(['patient_identity:write']);
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('grande.pdf', 'application/pdf', 6 * 1024 * 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-documents-error');
    expect(uploadPatientDocument).not.toHaveBeenCalled();
  });

  it('upload que falha na API: mostra a mensagem do erro', async () => {
    withPermissions(['patient_identity:write']);
    uploadPatientDocument.mockRejectedValue(new FakeApiError('Falha no upload'));
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('doc.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Falha no upload');
  });

  it('abrir documento que falha: mostra erro', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockResolvedValueOnce([]).mockResolvedValueOnce([DOC_ROW]);
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    getPatientDocumentUrl.mockRejectedValue(new FakeApiError('Não achei'));
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('doc.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-document-row');
    fireEvent.click(screen.getByTestId('patient-document-open-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Não achei');
  });

  it('recarregar (listPatientDocuments/getVigenteImageConsent falham) mostra erro genérico de carga', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockRejectedValue(new FakeApiError('Falha ao listar'));
    render(<PatientDocumentsCard patientId="p1" />);
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Falha ao listar');
  });

  it('recarregar com erro GENÉRICO (não ApiError): mostra a mensagem padrão de carga', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockRejectedValue(new Error('boom'));
    render(<PatientDocumentsCard patientId="p1" />);
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent(t('admin.patients.detail.identityCard.documents.errorLoadGeneric'));
  });

  it('upload que falha com erro GENÉRICO (não ApiError): mostra a mensagem padrão', async () => {
    withPermissions(['patient_identity:write']);
    uploadPatientDocument.mockRejectedValue(new Error('boom'));
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('doc.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent(t('admin.patients.detail.identityCard.documents.errorUploadGeneric'));
  });

  it('abrir documento que falha com erro GENÉRICO (não ApiError): mostra a mensagem padrão', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockResolvedValueOnce([]).mockResolvedValueOnce([DOC_ROW]);
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    getPatientDocumentUrl.mockRejectedValue(new Error('boom'));
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('doc.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-document-row');
    fireEvent.click(screen.getByTestId('patient-document-open-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent(t('admin.patients.detail.identityCard.documents.errorOpenGeneric'));
  });

  it('registrar consentimento feliz: recarrega do servidor, mostra status vigente e permite revogar', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockResolvedValue({ id: 'consent-1' });
    getVigenteImageConsent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'consent-1', consenterKind: 'PATIENT', consentedAt: '2026-09-14T10:00:00.000Z' })
      .mockResolvedValueOnce(null); // após revogar
    revokeImageConsent.mockResolvedValue(undefined);
    render(<PatientDocumentsCard patientId="p1" />);
    await screen.findByTestId('patient-consent-register-btn');
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    await waitFor(() => expect(registerImageConsent).toHaveBeenCalled());
    expect(await screen.findByTestId('patient-consent-status')).toBeInTheDocument();
    expect(screen.getByTestId('patient-consent-revoke-btn')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('patient-consent-revoke-btn'));
    await waitFor(() => expect(revokeImageConsent).toHaveBeenCalledWith('p1', 'consent-1', { revocationChannel: 'IN_PERSON' }));
    // Depois de revogar, o servidor não devolve mais vigente — a tela volta ao botão de registrar.
    expect(await screen.findByTestId('patient-consent-register-btn')).toBeInTheDocument();
  });

  it('registrar consentimento QUANDO já há documento na lista: manda o documentId do 1º documento', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    listPatientDocuments.mockResolvedValue([DOC_ROW]);
    registerImageConsent.mockResolvedValue({ id: 'consent-1' });
    render(<PatientDocumentsCard patientId="p1" />);
    await screen.findByTestId('patient-document-row');
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    await waitFor(() => expect(registerImageConsent).toHaveBeenCalledWith('p1', expect.objectContaining({ documentId: 'doc-1' })));
  });

  it('registrar consentimento que falha com erro GENÉRICO (não ApiError): mostra a mensagem padrão', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockRejectedValue(new Error('boom'));
    render(<PatientDocumentsCard patientId="p1" />);
    await screen.findByTestId('patient-consent-register-btn');
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent(t('admin.patients.detail.identityCard.documents.errorConsentGeneric'));
  });

  it('revogar consentimento que falha com erro GENÉRICO (não ApiError): mostra a mensagem padrão', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockResolvedValue({ id: 'consent-1' });
    getVigenteImageConsent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'consent-1', consenterKind: 'PATIENT', consentedAt: '2026-09-14T10:00:00.000Z' });
    revokeImageConsent.mockRejectedValue(new Error('boom'));
    render(<PatientDocumentsCard patientId="p1" />);
    await screen.findByTestId('patient-consent-register-btn');
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    await screen.findByTestId('patient-consent-revoke-btn');
    fireEvent.click(screen.getByTestId('patient-consent-revoke-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent(t('admin.patients.detail.identityCard.documents.errorRevokeGeneric'));
  });

  it('registrar consentimento que falha: mostra erro', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockRejectedValue(new FakeApiError('Falha consentimento'));
    render(<PatientDocumentsCard patientId="p1" />);
    await screen.findByTestId('patient-consent-register-btn');
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Falha consentimento');
  });

  it('revogar consentimento que falha: mostra erro', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockResolvedValue({ id: 'consent-1' });
    getVigenteImageConsent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'consent-1', consenterKind: 'PATIENT', consentedAt: '2026-09-14T10:00:00.000Z' });
    revokeImageConsent.mockRejectedValue(new FakeApiError('Falha revogar'));
    render(<PatientDocumentsCard patientId="p1" />);
    await screen.findByTestId('patient-consent-register-btn');
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    await screen.findByTestId('patient-consent-revoke-btn');
    fireEvent.click(screen.getByTestId('patient-consent-revoke-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Falha revogar');
  });
});
