import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DocumentUploadCard } from '@presentation/components/molecules/DocumentUploadCard';
import { Heading, Text } from '@presentation/components/atoms';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { DocumentType, WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';
import { isATProfession, requiredDocTypesFor } from '@presentation/utils/workerDocumentPolicy';

interface DocumentSlot {
  docType: DocumentType;
  /** Apenas visível para profissão AT */
  atOnly?: boolean;
  /** Apenas visível para Cuidador (profissão diferente de AT) */
  cuidadorOnly?: boolean;
}

// Labels vêm da chave canônica `documentTypes.<docType>` em i18n —
// fonte única compartilhada com o WorkerDocumentsCard do admin.
//
// Regras de visibilidade por profissão:
//   Universal  : resume_cv, liability_insurance, identity_document,
//                identity_document_back, criminal_record, monotributo_certificate
//   atOnly     : at_certificate, apto_psicofisico, analitico_universitario
//   cuidadorOnly: carta_recomendacion
//   Oculto     : professional_registration (slot removido da UI)
const DOCUMENT_SLOTS: DocumentSlot[] = [
  { docType: 'resume_cv' },
  { docType: 'liability_insurance' },
  { docType: 'identity_document' },
  { docType: 'identity_document_back' },
  { docType: 'criminal_record' },
  { docType: 'monotributo_certificate' },
  { docType: 'at_certificate', atOnly: true },
  { docType: 'apto_psicofisico', atOnly: true },
  { docType: 'analitico_universitario', atOnly: true },
  { docType: 'carta_recomendacion', cuidadorOnly: true },
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
  apto_psicofisico: 'aptoPsicofisicoUrl',
  analitico_universitario: 'analiticoUniversitarioUrl',
  carta_recomendacion: 'cartaRecomendacionUrl',
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
  // NULL/'' profession is treated as AT — mirrors the SQL gate that blocks
  // postulación (see workerDocumentPolicy.ts). Fixes the ~68% of ATs with
  // profession=NULL who otherwise never saw the AT slots/warning.
  const isAT = isATProfession(profession);

  // Mostrar slot se:
  //   - não tem flag exclusiva (universal), OU
  //   - atOnly E é AT, OU
  //   - cuidadorOnly E não é AT
  const visibleSlots = DOCUMENT_SLOTS.filter(
    (s) => (!s.atOnly && !s.cuidadorOnly) || (s.atOnly && isAT) || (s.cuidadorOnly && !isAT),
  );

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

  // Gate-required docs for this profession + the ones still missing.
  const requiredDocs = requiredDocTypesFor(profession);
  const isRequiredDoc = (docType: DocumentType): boolean => requiredDocs.includes(docType);
  const pendingRequiredDocs = requiredDocs.filter((docType) => !getFilePath(docType));

  // Row 1: first 3 slots, Row 2: next 3, Row 3: AT-only (if applicable)
  const row1 = visibleSlots.slice(0, 3);
  const row2 = visibleSlots.slice(3, 6);
  const row3 = visibleSlots.slice(6);

  // Todos os 3 call sites (row1/row2/row3) sempre passam className — sem uso
  // opcional a cobrir, então o parâmetro é obrigatório (D200.12).
  const renderCard = (slot: DocumentSlot, className: string): JSX.Element => {
    const filePath = getFilePath(slot.docType);
    return (
      <div key={slot.docType} data-testid={`doc-slot-${slot.docType}`} className={`flex flex-col gap-1 ${className}`}>
        <DocumentUploadCard
          label={t(`documentTypes.${slot.docType}`)}
          isUploaded={!!filePath}
          isLoading={loadingTypes.has(slot.docType)}
          isRequired={isRequiredDoc(slot.docType)}
          onFileSelect={(file) => withLoading(slot.docType, () => onUpload(slot.docType, file))}
          onDelete={() => withLoading(slot.docType, () => onDelete(slot.docType))}
          // DocumentUploadCard só desenha (e só chama) o botão "Visualizar"
          // quando isUploaded=true, e isUploaded aqui é exatamente `!!filePath`
          // — logo, sempre que onView for de fato invocado, filePath já é
          // string. Sem ramo pra cobrir (e sem função nunca chamada sobrando).
          onView={() => onView(filePath as string)}
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

      {/* Aviso dos documentos obrigatórios pendentes — prominente e específico
          (lista os que faltam). Cuidador/enfermeiro/psicólogo TAMBÉM têm DNI +
          antecedentes obrigatórios (workerDocumentPolicy.ts); só o texto muda
          por profissão — para não-AT ele nunca cita "Acompañante Terapéutico". */}
      {pendingRequiredDocs.length > 0 && (
        <div
          data-testid="at-required-notice"
          className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 border border-amber-300"
        >
          <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <Text as="p" size="sm" color="secondary" className="text-amber-900">
            {isAT
              ? t('documents.atRequiredPending', 'Para postularte como Acompañante Terapéutico necesitás subir:')
              : t('documents.pendingRequiredGeneric', 'Para postularte necesitás subir:')}{' '}
            <Text as="span" size="sm" weight="semibold" color="inherit">
              {pendingRequiredDocs.map((dt) => t(`documentTypes.${dt}`)).join(', ')}
            </Text>
          </Text>
        </div>
      )}
      {pendingRequiredDocs.length === 0 && (
        <div
          data-testid="at-required-done"
          className="flex items-start gap-2 px-4 py-3 rounded-lg bg-green-50 border border-green-200"
        >
          <CheckCircle2 size={18} className="text-green-600 shrink-0 mt-0.5" />
          <Text as="p" size="sm" color="secondary" className="text-green-800">
            {t('documents.allRequiredDone', 'Ya subiste todos los documentos obligatorios para postularte.')}
          </Text>
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {row1.map((slot) => renderCard(slot, 'flex-1 min-w-[200px]'))}
      </div>

      <div className="flex flex-wrap gap-4">
        {row2.map((slot) => renderCard(slot, 'flex-1 min-w-[200px]'))}
      </div>

      {row3.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {row3.map((slot) => renderCard(slot, 'flex-1 min-w-[260px]'))}
        </div>
      )}
    </div>
  );
}
