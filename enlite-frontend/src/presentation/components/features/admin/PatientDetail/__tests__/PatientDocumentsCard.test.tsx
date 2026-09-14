/**
 * PatientDocumentsCard — spec 018, PR-4 (task 4.10). Cobre upload de documento, listagem
 * session-scoped, abrir por `blob:`, registrar/revogar consentimento e os gates de célula
 * (D269/D286): sem `patient_consent_documents:read` a lista não existe na árvore; sem
 * `patient_identity:write` nem upload nem consentimento aparecem; sem NENHUMA das duas, o
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const uploadPatientDocument = vi.fn();
const getPatientDocumentUrl = vi.fn();
const registerImageConsent = vi.fn();
const revokeImageConsent = vi.fn();
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
    registerImageConsent: (...a: unknown[]) => registerImageConsent(...a),
    revokeImageConsent: (...a: unknown[]) => revokeImageConsent(...a),
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

const originalFetch = global.fetch;
const originalCreateObjectURL = (URL as any).createObjectURL;
const originalOpen = window.open;

describe('PatientDocumentsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    global.fetch = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(['x'])) }) as any;
    (URL as any).createObjectURL = vi.fn().mockReturnValue('blob:fake');
    window.open = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    (URL as any).createObjectURL = originalCreateObjectURL;
    window.open = originalOpen;
  });

  it('sem NENHUMA das duas células: o cartão não renderiza', () => {
    withPermissions([]);
    const { container } = render(<PatientDocumentsCard patientId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('só com patient_consent_documents:read: mostra a lista (vazia) mas não o upload nem consentimento', () => {
    withPermissions(['patient_consent_documents:read']);
    render(<PatientDocumentsCard patientId="p1" />);
    expect(screen.getByTestId('patient-documents-list')).toBeInTheDocument();
    expect(screen.getByTestId('patient-documents-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-document-upload-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-consent-register-btn')).not.toBeInTheDocument();
  });

  it('só com patient_identity:write: mostra upload e consentimento, mas não a lista de documentos', () => {
    withPermissions(['patient_identity:write']);
    render(<PatientDocumentsCard patientId="p1" />);
    expect(screen.getByTestId('patient-document-upload-btn')).toBeInTheDocument();
    expect(screen.getByTestId('patient-consent-register-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-documents-list')).not.toBeInTheDocument();
  });

  it('upload feliz: aparece na lista e permite abrir por blob:', async () => {
    withPermissions(['patient_identity:write', 'patient_consent_documents:read']);
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    getPatientDocumentUrl.mockResolvedValue({ url: 'https://signed.example/doc.pdf', expiresInSeconds: 300 });
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('consentimento.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(uploadPatientDocument).toHaveBeenCalledWith('p1', file, 'image_consent'));
    expect(await screen.findByText('consentimento.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('patient-document-open-btn'));
    await waitFor(() => expect(getPatientDocumentUrl).toHaveBeenCalledWith('p1', 'doc-1'));
    await waitFor(() => expect(window.open).toHaveBeenCalledWith('blob:fake', '_blank', 'noopener,noreferrer'));
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
    uploadPatientDocument.mockResolvedValue({ documentId: 'doc-1' });
    getPatientDocumentUrl.mockRejectedValue(new FakeApiError('Não achei'));
    render(<PatientDocumentsCard patientId="p1" />);
    const file = makeFile('doc.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-document-file-input'), { target: { files: [file] } });
    await screen.findByText('doc.pdf');
    fireEvent.click(screen.getByTestId('patient-document-open-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Não achei');
  });

  it('registrar consentimento feliz: mostra status vigente e permite revogar', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockResolvedValue({ id: 'consent-1' });
    revokeImageConsent.mockResolvedValue(undefined);
    render(<PatientDocumentsCard patientId="p1" />);
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    await waitFor(() => expect(registerImageConsent).toHaveBeenCalled());
    expect(await screen.findByTestId('patient-consent-status')).toBeInTheDocument();
    expect(screen.getByTestId('patient-consent-revoke-btn')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('patient-consent-revoke-btn'));
    await waitFor(() => expect(revokeImageConsent).toHaveBeenCalledWith('p1', 'consent-1', { revocationChannel: 'IN_PERSON' }));
  });

  it('registrar consentimento que falha: mostra erro', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockRejectedValue(new FakeApiError('Falha consentimento'));
    render(<PatientDocumentsCard patientId="p1" />);
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Falha consentimento');
  });

  it('revogar consentimento que falha: mostra erro', async () => {
    withPermissions(['patient_identity:write']);
    registerImageConsent.mockResolvedValue({ id: 'consent-1' });
    revokeImageConsent.mockRejectedValue(new FakeApiError('Falha revogar'));
    render(<PatientDocumentsCard patientId="p1" />);
    fireEvent.click(screen.getByTestId('patient-consent-register-btn'));
    await screen.findByTestId('patient-consent-revoke-btn');
    fireEvent.click(screen.getByTestId('patient-consent-revoke-btn'));
    expect(await screen.findByTestId('patient-documents-error')).toHaveTextContent('Falha revogar');
  });
});
