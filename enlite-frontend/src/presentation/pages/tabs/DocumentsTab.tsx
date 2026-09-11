import { useEffect } from 'react';
import { useDocumentsApi } from '@presentation/hooks/useDocumentsApi';
import { useAdditionalDocumentsApi } from '@presentation/hooks/useAdditionalDocumentsApi';
import { DocumentsGrid } from '@presentation/components/organisms/DocumentsGrid';
import { AdditionalDocumentsSection } from '@presentation/components/organisms/AdditionalDocumentsSection';
import { DocumentType } from '@infrastructure/http/DocumentApiService';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';

export function DocumentsTab(): JSX.Element {
  const profession = useWorkerRegistrationStore((s) => s.data.generalInfo.profession);
  // Fase 3/DD4 — só gateia a ajuda de antecedentes (trâmite argentino, F12)
  // dentro do DocumentsGrid; este componente não decide nada com ele.
  const country = useWorkerRegistrationStore((s) => s.data.generalInfo.country);
  const { documents, isLoading, error, fetchDocuments, uploadDocument, deleteDocument, viewDocument } =
    useDocumentsApi();
  const additional = useAdditionalDocumentsApi();
  const { fetchDocuments: fetchAdditional } = additional;

  useEffect(() => {
    fetchDocuments();
    fetchAdditional();
  }, [fetchDocuments, fetchAdditional]);

  if (isLoading && !documents) {
    return (
      <div className="animate-pulse flex flex-col gap-4">
        <div className="h-8 bg-gray-300 rounded-input w-48" />
        <div className="flex gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="flex-1 h-36 bg-gray-300 rounded-card" />)}
        </div>
        <div className="flex gap-4">
          {[1, 2].map((i) => <div key={i} className="flex-1 h-36 bg-gray-300 rounded-card" />)}
        </div>
      </div>
    );
  }

  if (error && !documents) {
    return (
      <div className="p-4 rounded-input bg-red-50 border border-red-200">
        <p className="font-lexend text-sm text-red-700">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <DocumentsGrid
        documents={documents}
        profession={profession || null}
        country={country || null}
        onUpload={(docType: DocumentType, file: File) => uploadDocument(docType, file)}
        onDelete={(docType: DocumentType) => deleteDocument(docType)}
        onView={(filePath: string) => viewDocument(filePath)}
      />

      <AdditionalDocumentsSection
        documents={additional.documents}
        onUpload={additional.uploadDocument}
        onDelete={additional.deleteDocument}
        onView={additional.viewDocument}
        isLoading={additional.isLoading}
      />
    </div>
  );
}
