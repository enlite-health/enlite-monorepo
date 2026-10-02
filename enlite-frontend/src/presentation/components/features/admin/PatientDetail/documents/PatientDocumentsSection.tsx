/**
 * PatientDocumentsSection — aba "Documentos" da ficha do paciente (spec 031, D463): subir, listar,
 * ver, renomear em linha e excluir (com confirmação) os documentos do paciente — subidos aqui ou
 * enviados pelo chat (a lista tem UMA fonte, o servidor).
 *
 * Componente IRMÃO do `AdditionalDocumentsSection` (aquele é do autoatendimento do prestador, não
 * se toca). Gates por célula, ao estilo de `WorkerDetailContent` (D269): sem `patient_document:create`
 * o formulário some, sem `:update` o lápis some, sem `:delete` o ícone de excluir some. O gate de
 * LEITURA é do container (`ContainerGate resource="patient_document"` na página).
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { usePatientDocuments } from '@hooks/admin/usePatientDocuments';
import { useOpenPatientDocument } from '@hooks/admin/useOpenPatientDocument';
import type { PatientDocument } from '@infrastructure/http/AdminPatientDocumentsApiService';
import { PatientDocumentUploadForm } from './PatientDocumentUploadForm';
import { PatientDocumentRow } from './PatientDocumentRow';
import { DeletePatientDocumentConfirm } from './DeletePatientDocumentConfirm';

interface Props {
  patientId: string;
}

export function PatientDocumentsSection({ patientId }: Props): JSX.Element {
  const { t } = useTranslation();
  const td = (key: string): string => t(`admin.patients.detail.documentsTab.${key}`);
  const createGate = useActionGate('patient_document', 'create');
  const updateGate = useActionGate('patient_document', 'update');
  const deleteGate = useActionGate('patient_document', 'delete');
  const { documents, status, upload, rename, remove } = usePatientDocuments(patientId);
  const { viewError, openDocument } = useOpenPatientDocument(patientId);
  const [pendingDelete, setPendingDelete] = useState<PatientDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const closeDelete = (): void => {
    setPendingDelete(null);
    setDeleteError(null);
  };

  const confirmDelete = async (doc: PatientDocument): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await remove(doc.id);
      setPendingDelete(null);
    } catch {
      setDeleteError(td('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="patient-documents-section">
      <Heading level={2} weight="semibold" color="secondary">{td('title')}</Heading>

      {createGate.allowed && <PatientDocumentUploadForm onUpload={upload} />}

      {viewError && (
        <Text as="p" size="xs" role="alert" className="text-red-800" data-testid="patient-documents-view-error">
          {viewError}
        </Text>
      )}

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-slate-600 text-sm" data-testid="patient-documents-loading">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {td('loading')}
        </div>
      )}
      {status === 'error' && (
        <Text as="p" size="sm" role="alert" className="text-red-800" data-testid="patient-documents-load-error">
          {td('loadError')}
        </Text>
      )}
      {status === 'ok' && documents.length === 0 && (
        <Text as="p" size="sm" className="italic text-slate-600" data-testid="patient-documents-empty">
          {td('empty')}
        </Text>
      )}
      {status === 'ok' && documents.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="patient-documents-list">
          {documents.map((doc) => (
            <PatientDocumentRow
              key={doc.id}
              doc={doc}
              canUpdate={updateGate.allowed}
              canDelete={deleteGate.allowed}
              onView={(docId) => { void openDocument(docId); }}
              onRename={rename}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      {pendingDelete && (
        <DeletePatientDocumentConfirm
          name={pendingDelete.label ?? td('untitled')}
          busy={deleting}
          error={deleteError}
          onConfirm={() => { void confirmDelete(pendingDelete); }}
          onClose={closeDelete}
        />
      )}
    </div>
  );
}
