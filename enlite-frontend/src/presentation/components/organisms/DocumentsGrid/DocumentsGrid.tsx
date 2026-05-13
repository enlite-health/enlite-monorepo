import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DocumentUploadCard } from '@presentation/components/molecules/DocumentUploadCard';
import { Heading, Text } from '@presentation/components/atoms';
import { AlertTriangle } from 'lucide-react';
import { DocumentType, WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

interface DocumentSlot {
  docType: DocumentType;
  atOnly?: boolean;
}

// Labels vêm da chave canônica `documentTypes.<docType>` em i18n —
// fonte única compartilhada com o WorkerDocumentsCard do admin.
const DOCUMENT_SLOTS: DocumentSlot[] = [
  { docType: 'resume_cv' },
  { docType: 'liability_insurance' },
  { docType: 'identity_document' },
  { docType: 'identity_document_back' },
  { docType: 'professional_registration' },
  { docType: 'criminal_record' },
  { docType: 'monotributo_certificate', atOnly: true },
  { docType: 'at_certificate', atOnly: true },
];

const DOC_URL_MAP: Record<DocumentType, keyof WorkerDocumentsResponse> = {
  resume_cv: 'resumeCvUrl',
  identity_document: 'identityDocumentUrl',
  identity_document_back: 'identityDocumentBackUrl',
  criminal_record: 'criminalRecordUrl',
  professional_registration: 'professionalRegistrationUrl',
  liability_insurance: 'liabilityInsuranceUrl',
  monotributo_certificate: 'monotributoCertificateUrl',
  at_certificate: 'atCertificateUrl',
};

interface DocumentsGridProps {
  documents: WorkerDocumentsResponse | null;
  profession?: string | null;
  onUpload: (docType: DocumentType, file: File) => Promise<void>;
  onDelete: (docType: DocumentType) => Promise<void>;
  onView: (filePath: string) => Promise<void>;
}

export function DocumentsGrid({ documents, profession, onUpload, onDelete, onView }: DocumentsGridProps): JSX.Element {
  const { t } = useTranslation();
  const [loadingTypes, setLoadingTypes] = useState<Set<DocumentType>>(new Set());
  const [cardErrors, setCardErrors] = useState<Partial<Record<DocumentType, string>>>({});
  const isAT = profession === 'AT';

  const visibleSlots = DOCUMENT_SLOTS.filter((s) => !s.atOnly || isAT);

  const withLoading = async (docType: DocumentType, fn: () => Promise<void>): Promise<void> => {
    setLoadingTypes((prev) => new Set(prev).add(docType));
    setCardErrors((prev) => { const next = { ...prev }; delete next[docType]; return next; });
    try {
      await fn();
    } catch (err) {
      setCardErrors((prev) => ({ ...prev, [docType]: err instanceof Error ? err.message : 'Erro' }));
    } finally {
      setLoadingTypes((prev) => { const next = new Set(prev); next.delete(docType); return next; });
    }
  };

  const getFilePath = (docType: DocumentType): string | null => {
    if (!documents) return null;
    return (documents[DOC_URL_MAP[docType]] as string | null) ?? null;
  };

  // Row 1: first 3 slots, Row 2: next 3, Row 3: AT-only (if applicable)
  const row1 = visibleSlots.slice(0, 3);
  const row2 = visibleSlots.slice(3, 6);
  const row3 = visibleSlots.slice(6);

  const renderCard = (slot: DocumentSlot, className?: string): JSX.Element => {
    const filePath = getFilePath(slot.docType);
    return (
      <div key={slot.docType} data-testid={`doc-slot-${slot.docType}`} className={`flex flex-col gap-1 ${className ?? ''}`}>
        <DocumentUploadCard
          label={t(`documentTypes.${slot.docType}`)}
          isUploaded={!!filePath}
          isLoading={loadingTypes.has(slot.docType)}
          onFileSelect={(file) => withLoading(slot.docType, () => onUpload(slot.docType, file))}
          onDelete={() => withLoading(slot.docType, () => onDelete(slot.docType))}
          onView={() => filePath ? onView(filePath) : Promise.resolve()}
          className="flex-1"
        />
        {cardErrors[slot.docType] && (
          <Text as="p" size="xs" color="secondary" className="text-red-500">
            {cardErrors[slot.docType]}
          </Text>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <Heading level={2} weight="semibold" color="secondary">
        {t('documents.title', 'Documentos')}
      </Heading>

      <div className="flex flex-wrap gap-4">
        {row1.map((slot) => renderCard(slot, 'flex-1 min-w-[200px]'))}
      </div>

      <div className="flex flex-wrap gap-4">
        {row2.map((slot) => renderCard(slot, 'flex-1 min-w-[200px]'))}
      </div>

      {row3.length > 0 && (
        <>
          {isAT && (
            <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200">
              <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
              <Text as="p" size="sm" color="secondary" className="text-amber-800">
                {t('documents.atRequiredWarning', 'Como Acompañante Terapéutico, estos documentos son obligatorios para completar tu registro.')}
              </Text>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            {row3.map((slot) => renderCard(slot, 'flex-1 min-w-[260px]'))}
          </div>
        </>
      )}
    </div>
  );
}
