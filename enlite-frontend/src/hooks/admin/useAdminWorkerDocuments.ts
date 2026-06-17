import { useState, useCallback, useMemo } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { WorkerDocument, DocumentValidations } from '@domain/entities/Worker';

export type AdminDocumentType =
  | 'resume_cv'
  | 'identity_document'
  | 'identity_document_back'
  | 'criminal_record'
  | 'professional_registration'
  | 'liability_insurance'
  | 'monotributo_certificate'
  | 'at_certificate'
  | 'apto_psicofisico'
  | 'analitico_universitario'
  | 'carta_recomendacion';

interface UseAdminWorkerDocumentsOptions {
  onDocumentsChange?: (docs: WorkerDocument) => void;
  onValidationChange?: (validations: DocumentValidations) => void;
}

export function useAdminWorkerDocuments(
  workerId: string,
  options: UseAdminWorkerDocumentsOptions = {},
) {
  const opts = useMemo<UseAdminWorkerDocumentsOptions>(
    () => options,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.onDocumentsChange, options.onValidationChange],
  );

  const [loadingTypes, setLoadingTypes] = useState<Set<AdminDocumentType>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<AdminDocumentType, string>>>({});

  const clearError = useCallback((docType: AdminDocumentType) => {
    setErrors((prev) => { const next = { ...prev }; delete next[docType]; return next; });
  }, []);

  const uploadDocument = useCallback(async (docType: AdminDocumentType, file: File) => {
    setLoadingTypes((prev) => new Set(prev).add(docType));
    clearError(docType);
    try {
      const { signedUrl, filePath } = await AdminApiService.getWorkerDocUploadUrl(
        workerId, docType, file.type,
      );
      await AdminApiService.uploadWorkerDocToGCS(signedUrl, file);
      const docs = await AdminApiService.saveWorkerDocPath(workerId, docType, filePath);
      if (docs) opts.onDocumentsChange?.(docs);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [docType]: err instanceof Error ? err.message : 'Error',
      }));
    } finally {
      setLoadingTypes((prev) => { const next = new Set(prev); next.delete(docType); return next; });
    }
  }, [workerId, clearError, opts]);

  const deleteDocument = useCallback(async (docType: AdminDocumentType) => {
    setLoadingTypes((prev) => new Set(prev).add(docType));
    clearError(docType);
    try {
      const docs = await AdminApiService.deleteWorkerDoc(workerId, docType);
      if (docs) opts.onDocumentsChange?.(docs);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [docType]: err instanceof Error ? err.message : 'Error',
      }));
    } finally {
      setLoadingTypes((prev) => { const next = new Set(prev); next.delete(docType); return next; });
    }
  }, [workerId, clearError, opts]);

  const viewDocument = useCallback(async (filePath: string) => {
    const signedUrl = await AdminApiService.getWorkerDocViewUrl(workerId, filePath);
    window.open(signedUrl, '_blank');
  }, [workerId]);

  const validateDocument = useCallback(async (docType: AdminDocumentType) => {
    setLoadingTypes((prev) => new Set(prev).add(docType));
    clearError(docType);
    try {
      const validations = await AdminApiService.validateWorkerDoc(workerId, docType);
      opts.onValidationChange?.(validations);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [docType]: err instanceof Error ? err.message : 'Error',
      }));
    } finally {
      setLoadingTypes((prev) => { const next = new Set(prev); next.delete(docType); return next; });
    }
  }, [workerId, clearError, opts]);

  const invalidateDocument = useCallback(async (docType: AdminDocumentType) => {
    setLoadingTypes((prev) => new Set(prev).add(docType));
    clearError(docType);
    try {
      const validations = await AdminApiService.invalidateWorkerDoc(workerId, docType);
      opts.onValidationChange?.(validations);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [docType]: err instanceof Error ? err.message : 'Error',
      }));
    } finally {
      setLoadingTypes((prev) => { const next = new Set(prev); next.delete(docType); return next; });
    }
  }, [workerId, clearError, opts]);

  return { uploadDocument, deleteDocument, viewDocument, validateDocument, invalidateDocument, loadingTypes, errors };
}
