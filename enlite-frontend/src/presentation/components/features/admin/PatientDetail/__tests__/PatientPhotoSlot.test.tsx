/**
 * PatientPhotoSlot — spec 018, PR-4 (task 4.10). Mesmo padrão dos outros cards de PatientDetail:
 * i18n resolvido contra o pt-BR.json de verdade, AdminApiService mockado, célula real via
 * `useAdminAuthStore` (D269).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const uploadPatientPhoto = vi.fn();
const deletePatientPhoto = vi.fn();
const getPatientPhotoUrl = vi.fn();
const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class FakeApiError extends Error {
    status: number;
    constructor(message: string, status = 400) { super(message); this.status = status; }
  },
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    uploadPatientPhoto: (...a: unknown[]) => uploadPatientPhoto(...a),
    deletePatientPhoto: (...a: unknown[]) => deletePatientPhoto(...a),
    getPatientPhotoUrl: (...a: unknown[]) => getPatientPhotoUrl(...a),
  },
  ApiError: FakeApiError,
}));

const { PatientPhotoSlot } = await import('../PatientPhotoSlot');

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

describe('PatientPhotoSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPatientPhotoUrl.mockResolvedValue({ url: 'https://signed.example/photo.jpg', expiresInSeconds: 300 });
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('sem patient_identity:read: mostra o placeholder, nunca busca a signed URL', () => {
    withPermissions([]);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    expect(screen.getByTestId('patient-photo-placeholder')).toBeInTheDocument();
    expect(getPatientPhotoUrl).not.toHaveBeenCalled();
  });

  it('com patient_identity:read e hasPhoto=true: busca e mostra a <img> com atributos do contrato', async () => {
    withPermissions(['patient_identity:read']);
    getPatientPhotoUrl.mockResolvedValue({ url: 'https://signed.example/photo.jpg', expiresInSeconds: 300 });
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    const img = await screen.findByTestId('patient-photo-image');
    expect(img).toHaveAttribute('src', 'https://signed.example/photo.jpg');
    expect(img).toHaveAttribute('referrerPolicy', 'no-referrer');
    expect(img.closest('[data-clarity-mask="True"]')).toBeInTheDocument();
  });

  it('hasPhoto=false: mostra placeholder e nunca chama getPatientPhotoUrl', () => {
    withPermissions(['patient_identity:read']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    expect(screen.getByTestId('patient-photo-placeholder')).toBeInTheDocument();
    expect(getPatientPhotoUrl).not.toHaveBeenCalled();
  });

  it('sem patient_identity:write: botões de upload/remover SOMEM (D269)', async () => {
    withPermissions(['patient_identity:read']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    await waitFor(() => expect(getPatientPhotoUrl).toHaveBeenCalled());
    expect(screen.queryByTestId('patient-photo-upload-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-photo-remove-btn')).not.toBeInTheDocument();
  });

  it('hasPhoto=false: botão "remover" não aparece mesmo com write', () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    expect(screen.queryByTestId('patient-photo-remove-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('patient-photo-upload-btn')).toBeInTheDocument();
  });

  it('clicar no botão "Subir foto"/"Cambiar" aciona o input de arquivo oculto', () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    const input = screen.getByTestId('patient-photo-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('patient-photo-upload-btn'));
    expect(clickSpy).toHaveBeenCalled();
  });

  it('upload feliz: escolhe arquivo válido, chama a API e onChanged', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    uploadPatientPhoto.mockResolvedValue({ hasPhoto: true });
    const onChanged = vi.fn();
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} onChanged={onChanged} />);
    const file = makeFile('foto.jpg', 'image/jpeg', 1024);
    fireEvent.change(screen.getByTestId('patient-photo-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(uploadPatientPhoto).toHaveBeenCalledWith('p1', file));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('upload com tipo inválido: mostra erro, nunca chama a API', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    const file = makeFile('doc.pdf', 'application/pdf', 1024);
    fireEvent.change(screen.getByTestId('patient-photo-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-photo-error');
    expect(uploadPatientPhoto).not.toHaveBeenCalled();
  });

  it('upload maior que 5MB: mostra erro, nunca chama a API', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    const file = makeFile('grande.jpg', 'image/jpeg', 6 * 1024 * 1024);
    fireEvent.change(screen.getByTestId('patient-photo-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-photo-error');
    expect(uploadPatientPhoto).not.toHaveBeenCalled();
  });

  it('upload que falha na API (ApiError): mostra a mensagem do erro', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    uploadPatientPhoto.mockRejectedValue(new FakeApiError('Falha no upload'));
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    const file = makeFile('foto.jpg', 'image/jpeg', 1024);
    fireEvent.change(screen.getByTestId('patient-photo-file-input'), { target: { files: [file] } });
    expect(await screen.findByTestId('patient-photo-error')).toHaveTextContent('Falha no upload');
  });

  it('upload que falha com erro genérico (não ApiError): mostra mensagem genérica', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    uploadPatientPhoto.mockRejectedValue(new Error('boom'));
    render(<PatientPhotoSlot patientId="p1" hasPhoto={false} />);
    const file = makeFile('foto.jpg', 'image/jpeg', 1024);
    fireEvent.change(screen.getByTestId('patient-photo-file-input'), { target: { files: [file] } });
    await screen.findByTestId('patient-photo-error');
  });

  it('remover: abre confirmação, confirma, chama a API e onChanged', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    deletePatientPhoto.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('patient-photo-remove-btn'));
    expect(screen.getByTestId('patient-photo-remove-confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('patient-photo-remove-confirm-button'));
    await waitFor(() => expect(deletePatientPhoto).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('patient-photo-remove-confirm')).not.toBeInTheDocument();
  });

  it('remover: cancelar fecha o modal sem chamar a API', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    await waitFor(() => expect(getPatientPhotoUrl).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('patient-photo-remove-btn'));
    fireEvent.click(screen.getByText('Cancelar'));
    expect(screen.queryByTestId('patient-photo-remove-confirm')).not.toBeInTheDocument();
    expect(deletePatientPhoto).not.toHaveBeenCalled();
  });

  it('remover que falha na API (ApiError): mostra erro e mantém o modal fechável', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    deletePatientPhoto.mockRejectedValue(new FakeApiError('Falha ao remover'));
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    fireEvent.click(screen.getByTestId('patient-photo-remove-btn'));
    fireEvent.click(screen.getByTestId('patient-photo-remove-confirm-button'));
    expect(await screen.findByTestId('patient-photo-error')).toHaveTextContent('Falha ao remover');
  });

  it('remover que falha com erro genérico: mostra mensagem genérica', async () => {
    withPermissions(['patient_identity:create', 'patient_identity:update']);
    deletePatientPhoto.mockRejectedValue(new Error('boom'));
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    fireEvent.click(screen.getByTestId('patient-photo-remove-btn'));
    fireEvent.click(screen.getByTestId('patient-photo-remove-confirm-button'));
    await screen.findByTestId('patient-photo-error');
  });

  it('getPatientPhotoUrl falhando: cai para o placeholder em vez de quebrar', async () => {
    withPermissions(['patient_identity:read']);
    getPatientPhotoUrl.mockRejectedValue(new Error('404'));
    render(<PatientPhotoSlot patientId="p1" hasPhoto={true} />);
    await waitFor(() => expect(getPatientPhotoUrl).toHaveBeenCalled());
    expect(screen.getByTestId('patient-photo-placeholder')).toBeInTheDocument();
  });
});
