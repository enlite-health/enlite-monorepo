/**
 * PatientDocumentsCard — documento (prova do consentimento) e consentimento de imagem do
 * paciente (spec 018, PR-4, task 4.10; `contracts/patient-header-and-photo.md` §Documento e
 * §Consentimento de imagem).
 *
 * D335 (14/09/2026): nada aqui é obrigatório para nada — consentimento e representante são
 * funcionalidade independente, sem gate sobre o upload de foto/documento (o `PatientPhotoSlot`
 * nunca espera por este cartão).
 *
 * Furo fechado nesta rodada (revisão pré-gate, 14/09): antes, este cartão só mostrava o que tinha
 * sido enviado/registrado NESTA sessão do navegador (estado local, `useState`) — recarregar a
 * página voltava a lista vazia mesmo com documento/consentimento gravado no banco. Agora carrega
 * do servidor (`GET .../documents` + `GET .../image-consents/vigente`) no mount e depois de cada
 * ação (upload/registrar/revogar) — a lista sobrevive a `page.reload()`.
 *
 * O backend NUNCA guarda o nome original do arquivo (`patient_documents` só tem
 * `content_type`/`size_bytes`/`sha256` — decisão de segurança, `PatientDocumentStorage`). Por isso
 * a linha mostra o TIPO do documento + a data de envio, nunca um "nome de arquivo" inventado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Upload, Shield, ShieldOff } from 'lucide-react';
import {
  AdminApiService,
  ApiError,
  type PatientDocumentListItem,
  type VigenteImageConsentResult,
} from '@infrastructure/http/AdminApiService';
import { ActionButton } from '@presentation/components/features/access';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

const ACCEPTED_DOC_TYPES = ['application/pdf', 'image/jpeg'];
const MAX_DOC_BYTES = 5 * 1024 * 1024;

interface Props {
  patientId: string;
}

export function PatientDocumentsCard({ patientId }: Props): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const td = (k: string): string => t(`admin.patients.detail.identityCard.documents.${k}`);
  const { canWrite } = useCellAccess('patient_identity');
  const { canRead: canReadDocuments } = useCellAccess('patient_consent_documents');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [documents, setDocuments] = useState<PatientDocumentListItem[]>([]);
  const [consent, setConsent] = useState<VigenteImageConsentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [registeringConsent, setRegisteringConsent] = useState(false);
  const [revokingConsent, setRevokingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateFormatter = new Intl.DateTimeFormat(i18n.language === 'pt-BR' ? 'pt-BR' : 'es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docsResult, consentResult] = await Promise.all([
        canReadDocuments ? AdminApiService.listPatientDocuments(patientId) : Promise.resolve([]),
        canWrite ? AdminApiService.getVigenteImageConsent(patientId) : Promise.resolve(null),
      ]);
      setDocuments(docsResult);
      setConsent(consentResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('admin.patients.detail.identityCard.documents.errorLoadGeneric'));
    } finally {
      setLoading(false);
    }
  }, [patientId, canReadDocuments, canWrite, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Sem nenhuma das duas células, a seção inteira não existe na árvore (nada a fazer aqui).
  if (!canWrite && !canReadDocuments) return null;

  const handleUpload = async (file: File) => {
    setError(null);
    if (!ACCEPTED_DOC_TYPES.includes(file.type)) {
      setError(td('errorInvalidType'));
      return;
    }
    if (file.size > MAX_DOC_BYTES) {
      setError(td('errorTooLarge'));
      return;
    }
    setUploading(true);
    try {
      await AdminApiService.uploadPatientDocument(patientId, file, 'image_consent');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : td('errorUploadGeneric'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleOpen = async (doc: PatientDocumentListItem) => {
    setError(null);
    setOpeningId(doc.id);
    try {
      const { url } = await AdminApiService.getPatientDocumentUrl(patientId, doc.id);
      // Contrato (linha 46): abre por `blob:` — não navega direto para a URL assinada do GCS.
      const fileResponse = await fetch(url, { referrerPolicy: 'no-referrer' });
      const blob = await fileResponse.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : td('errorOpenGeneric'));
    } finally {
      setOpeningId(null);
    }
  };

  const handleRegisterConsent = async () => {
    setError(null);
    setRegisteringConsent(true);
    try {
      await AdminApiService.registerImageConsent(patientId, {
        consenterKind: 'PATIENT',
        textVersion: 'v1',
        consentedAt: new Date().toISOString(),
        documentId: documents[0]?.id,
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : td('errorConsentGeneric'));
    } finally {
      setRegisteringConsent(false);
    }
  };

  // `consentId` vem do JSX (só chamado dentro do bloco `{consent && (...)}`) — sem checagem de
  // null AQUI: o guard já é a própria renderização condicional (o botão não existe sem `consent`).
  const handleRevokeConsent = async (consentId: string) => {
    setError(null);
    setRevokingConsent(true);
    try {
      await AdminApiService.revokeImageConsent(patientId, consentId, { revocationChannel: 'IN_PERSON' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : td('errorRevokeGeneric'));
    } finally {
      setRevokingConsent(false);
    }
  };

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-clarity-mask="True"
      data-testid="patient-documents-card"
    >
      <Heading level={1} as="h3" weight="semibold" color="primary">
        {td('title')}
      </Heading>

      {canWrite && (
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_DOC_TYPES.join(',')}
            className="hidden"
            data-testid="patient-document-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <ActionButton
            resource="patient_identity"
            action="write"
            variant="outline"
            size="sm"
            isLoading={uploading}
            onClick={() => fileInputRef.current?.click()}
            data-testid="patient-document-upload-btn"
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {td('uploadButton')}
          </ActionButton>
        </div>
      )}

      {canReadDocuments && !loading && (
        <div className="flex flex-col gap-2" data-testid="patient-documents-list">
          {documents.length === 0 && (
            <Text size="sm" color="secondary" data-testid="patient-documents-empty">
              {td('empty')}
            </Text>
          )}
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-2" data-testid="patient-document-row">
              <FileText className="w-4 h-4 text-gray-500 shrink-0" />
              <Text size="sm" className="truncate">
                {td(`documentTypeLabels.${doc.documentType}`)} — {dateFormatter.format(new Date(doc.uploadedAt))}
              </Text>
              <Button
                variant="outline"
                size="sm"
                isLoading={openingId === doc.id}
                onClick={() => handleOpen(doc)}
                data-testid="patient-document-open-btn"
              >
                {td('openButton')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="border-t border-gray-200 pt-4 flex flex-col gap-2">
          <Text size="sm" weight="medium" color="primary">{td('consentTitle')}</Text>
          {!consent && (
            <Button
              variant="outline"
              size="sm"
              isLoading={registeringConsent}
              onClick={handleRegisterConsent}
              data-testid="patient-consent-register-btn"
              className="w-fit"
            >
              <Shield className="w-3.5 h-3.5 mr-1.5" />
              {td('registerConsentButton')}
            </Button>
          )}
          {consent && (
            <div className="flex items-center gap-2">
              <Text size="sm" data-testid="patient-consent-status">{td('consentActive')}</Text>
              <Button
                variant="outline"
                size="sm"
                isLoading={revokingConsent}
                onClick={() => handleRevokeConsent(consent.id)}
                data-testid="patient-consent-revoke-btn"
              >
                <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
                {td('revokeConsentButton')}
              </Button>
            </div>
          )}
        </div>
      )}

      {error && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="patient-documents-error">
          {error}
        </Text>
      )}
    </div>
  );
}
