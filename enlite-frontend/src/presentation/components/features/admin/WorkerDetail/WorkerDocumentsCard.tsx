import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { DocumentUploadCard } from '@presentation/components/molecules/DocumentUploadCard';
import { AlertTriangle } from 'lucide-react';
import type { WorkerDocument, DocumentValidations } from '@domain/entities/Worker';
import type { AdminDocumentType } from '@hooks/admin/useAdminWorkerDocuments';
import { DocumentValidationBadge } from './DocumentValidationBadge';
import { useActionGate } from '@presentation/hooks/useCellAccess';

interface DocumentSlot {
  docType: AdminDocumentType;
  urlField: keyof WorkerDocument;
  /** Só visível para AT */
  atOnly?: boolean;
  /** Só visível para trabalhadores que NÃO são AT (ex: Cuidador) */
  cuidadorOnly?: boolean;
  /** Nunca exibido na UI (slot oculto por política ABAC) */
  hidden?: boolean;
}

// Regras de visibilidade por profissão (política ABAC de documentos):
//   Universal     : resume_cv, identity_document, identity_document_back, criminal_record,
//                   liability_insurance, monotributo_certificate
//   atOnly        : at_certificate, apto_psicofisico, analitico_universitario
//   cuidadorOnly  : carta_recomendacion
//   Oculto (ABAC) : professional_registration — removido da UI para todos os perfis
const DOCUMENT_SLOTS: DocumentSlot[] = [
  { docType: 'resume_cv', urlField: 'resumeCvUrl' },
  { docType: 'identity_document', urlField: 'identityDocumentUrl' },
  { docType: 'identity_document_back', urlField: 'identityDocumentBackUrl' },
  { docType: 'criminal_record', urlField: 'criminalRecordUrl' },
  { docType: 'liability_insurance', urlField: 'liabilityInsuranceUrl' },
  { docType: 'monotributo_certificate', urlField: 'monotributoCertificateUrl' },
  // professional_registration: oculto para todos os perfis por política ABAC
  { docType: 'professional_registration', urlField: 'professionalRegistrationUrl', hidden: true },
  // atOnly — documentos exclusivos para Acompañantes Terapéuticos
  { docType: 'at_certificate', urlField: 'atCertificateUrl', atOnly: true },
  { docType: 'apto_psicofisico', urlField: 'aptoPsicofisicoUrl', atOnly: true },
  { docType: 'analitico_universitario', urlField: 'analiticoUniversitarioUrl', atOnly: true },
  // cuidadorOnly — documentos exclusivos para Cuidadores (non-AT)
  { docType: 'carta_recomendacion', urlField: 'cartaRecomendacionUrl', cuidadorOnly: true },
];

interface WorkerDocumentsCardProps {
  documents: WorkerDocument | null;
  profession?: string | null;
  onUpload: (docType: AdminDocumentType, file: File) => Promise<void>;
  onDelete: (docType: AdminDocumentType) => Promise<void>;
  onView: (filePath: string) => Promise<void>;
  onValidate: (docType: AdminDocumentType) => Promise<void>;
  onInvalidate: (docType: AdminDocumentType) => Promise<void>;
  loadingTypes: Set<AdminDocumentType>;
  errors: Partial<Record<AdminDocumentType, string>>;
  documentValidations?: DocumentValidations;
  children?: React.ReactNode;
}

export function WorkerDocumentsCard({
  documents,
  profession,
  onUpload,
  onDelete,
  onView,
  onValidate,
  onInvalidate,
  loadingTypes,
  errors,
  documentValidations,
  children,
}: WorkerDocumentsCardProps) {
  const { t } = useTranslation();
  const isAT = profession === 'AT';
  // POST .../documents/upload-url|save → worker_document:write; DELETE
  // .../documents/:type → worker_document:delete. D269 — repassados como
  // `canUpload`/`canDelete` pro `DocumentUploadCard`, que é COMPARTILHADO com
  // o autoatendimento do worker (por isso o gate mora aqui, não lá).
  const docWriteGate = useActionGate('worker_document', 'write');
  const docDeleteGate = useActionGate('worker_document', 'delete');

  // Filtra slots pela política ABAC de visibilidade por profissão:
  //   - hidden: sempre oculto
  //   - atOnly: visível apenas para AT
  //   - cuidadorOnly: visível apenas para não-AT
  //   - nenhuma flag: universal
  const visibleSlots = DOCUMENT_SLOTS.filter((s) => {
    if (s.hidden) return false;
    if (s.atOnly) return isAT;
    if (s.cuidadorOnly) return !isAT;
    return true;
  });

  const statusColor = documents ? ({
    approved: 'bg-turquoise/20 text-primary',
    under_review: 'bg-wait/20 text-yellow-700',
    rejected: 'bg-cancelled/20 text-red-700',
    submitted: 'bg-blue-100 text-blue-700',
    pending: 'bg-gray-300 text-gray-800',
    incomplete: 'bg-gray-300 text-gray-800',
  }[documents.documentsStatus] ?? 'bg-gray-300 text-gray-800') : null;

  const getUrl = (slot: DocumentSlot): string | null => {
    if (!documents) return null;
    return (documents[slot.urlField] as string | null | undefined) ?? null;
  };

  const row1 = visibleSlots.slice(0, 3);
  const row2 = visibleSlots.slice(3, 6);
  const row3 = visibleSlots.slice(6);

  const renderCard = (slot: DocumentSlot) => {
    const filePath = getUrl(slot);
    const validation = documentValidations?.[slot.docType];
    const isLoading = loadingTypes.has(slot.docType);
    return (
      <div key={slot.docType} data-testid={`doc-slot-${slot.docType}`} className="flex flex-col gap-1.5">
        <DocumentUploadCard
          label={t(`documentTypes.${slot.docType}`)}
          isUploaded={!!filePath}
          isLoading={isLoading}
          onFileSelect={(file) => onUpload(slot.docType, file)}
          onDelete={() => onDelete(slot.docType)}
          onView={() => filePath ? onView(filePath) : Promise.resolve()}
          canUpload={!docWriteGate.denied}
          canDelete={!docDeleteGate.denied}
        />
        <DocumentValidationBadge
          docType={slot.docType}
          validation={validation}
          hasDocument={!!filePath}
          isLoading={isLoading}
          onValidate={onValidate}
          onInvalidate={onInvalidate}
        />
        {errors[slot.docType] && (
          <Text size="xs" color="inherit" className="text-red-500">{errors[slot.docType]}</Text>
        )}
      </div>
    );
  };

  return (
    <div data-testid="worker-documents-card" className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3">
          {t('admin.workerDetail.documents')}
        </Heading>
        {statusColor && documents && (
          <span className={`px-3 py-1 rounded-full ${statusColor}`}>
            <Text as="span" size="sm" weight="medium" color="inherit">
              {documents.documentsStatus}
            </Text>
          </span>
        )}
      </div>

      <Text size="sm" color="muted">
        {t('admin.workerDetail.documentsAdminHint')}
      </Text>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {row1.map(renderCard)}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {row2.map(renderCard)}
      </div>

      {row3.length > 0 && (
        <>
          {isAT && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200">
              <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
              <Text size="sm" color="inherit" className="text-amber-800">
                {t('documents.atRequiredWarning', 'Como Acompañante Terapéutico, estos documentos son obligatorios para completar tu registro.')}
              </Text>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {row3.map(renderCard)}
          </div>
        </>
      )}

      {documents?.reviewNotes && (
        <div className="bg-gray-200 rounded-lg p-3">
          <Text size="xs" color="secondary" className="mb-1">
            {t('admin.workerDetail.reviewNotes')}
          </Text>
          <Text size="sm">{documents.reviewNotes}</Text>
        </div>
      )}

      {children}
    </div>
  );
}
