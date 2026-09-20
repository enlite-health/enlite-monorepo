import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading, Text } from '@presentation/components/atoms';
import { Eye, Trash2, Plus, FileText, Loader2 } from 'lucide-react';
import type { AdditionalDocument } from '@infrastructure/http/DocumentApiService';

interface AdditionalDocumentsSectionProps {
  documents: AdditionalDocument[];
  onUpload: (label: string, file: File) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onView: (filePath: string) => Promise<void>;
  isLoading?: boolean;
  /**
   * D269 (admin `worker_document:write`) — quando `false`, o botão "Agregar"
   * (e o form que ele abre) SOME. Este componente é COMPARTILHADO com o
   * autoatendimento do worker (`DocumentsTab`), que não gateia por célula —
   * por isso o default é `true` (comportamento inalterado sem a prop).
   */
  canUpload?: boolean;
  /** D269 (admin `worker_document:delete`) — quando `false`, o ícone de excluir SOME. Default `true`. */
  canDelete?: boolean;
}

export function AdditionalDocumentsSection({
  documents, onUpload, onDelete, onView, isLoading,
  canUpload = true, canDelete = true,
}: AdditionalDocumentsSectionProps): JSX.Element {
  const { t } = useTranslation();
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!label.trim() || !file) return;
    setSubmitting(true);
    setError(null);
    try {
      await onUpload(label.trim(), file);
      setLabel('');
      setFile(null);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4 mt-6" data-testid="additional-documents-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading level={2} weight="semibold" color="secondary">
          {t('documents.additionalTitle', 'Otros Documentos')}
        </Heading>
        {/* D269 — sem worker_document:write, o botão "Agregar" SOME. */}
        {canUpload && (
          <button
            type="button"
            onClick={() => setShowForm(!showForm)}
            data-testid="additional-doc-add"
            className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-primary text-primary text-sm font-medium hover:bg-primary/5 transition-colors"
          >
            <Plus size={16} />
            {t('documents.addDocument', 'Agregar')}
          </button>
        )}
      </div>

      {/* Add form */}
      {showForm && canUpload && (
        <div className="flex flex-col gap-3 p-4 rounded-card border-2 border-dashed border-gray-400 bg-gray-50">
          <input
            type="text"
            placeholder={t('documents.labelPlaceholder', 'Nombre del documento (ej: Certificado Primeros Auxilios)')}
            value={label}
            onChange={(e) => setLabel(e.target.value.slice(0, 255))}
            className="w-full px-3 py-2 rounded-input border border-gray-400 text-sm font-lexend focus:outline-none focus:border-primary"
          />
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-input border border-gray-400 cursor-pointer hover:border-primary transition-colors">
              <FileText size={16} className="text-gray-500" />
              <span className="text-sm text-gray-600 font-lexend truncate">
                {file ? file.name : t('documents.selectFile', 'Seleccionar archivo (PDF, JPG, PNG)')}
              </span>
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              type="button"
              disabled={!label.trim() || !file || submitting}
              onClick={handleSubmit}
              className="w-full sm:w-auto justify-center shrink-0 px-4 py-2 rounded-input bg-primary text-white text-sm font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors flex items-center gap-1.5"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {t('documents.upload', 'Subir')}
            </button>
          </div>
          {error && (
            <Text as="p" size="xs" color="secondary" className="text-red-500">
              {error}
            </Text>
          )}
        </div>
      )}

      {/* Document list */}
      {isLoading && documents.length === 0 ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={16} className="animate-spin" />
          {t('documents.loading', 'Cargando...')}
        </div>
      ) : documents.length === 0 ? (
        <Text as="p" size="sm" color="secondary" className="italic">
          {t('documents.noAdditional', 'No hay documentos adicionales')}
        </Text>
      ) : (
        <div className="flex flex-col gap-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-300 bg-white"
            >
              <div className="flex items-center gap-3 min-w-0">
                <FileText size={18} className="text-primary shrink-0" />
                <Text as="span" size="sm" color="secondary" className="truncate">
                  {doc.label}
                </Text>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onView(doc.filePath)}
                  className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                  title={t('documents.view', 'Ver')}
                >
                  <Eye size={16} className="text-gray-600" />
                </button>
                {/* D269 — sem worker_document:delete, o ícone de excluir SOME. */}
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => handleDelete(doc.id)}
                    disabled={deletingId === doc.id}
                    className="p-1.5 rounded hover:bg-red-50 transition-colors"
                    title={t('documents.delete', 'Eliminar')}
                  >
                    {deletingId === doc.id
                      ? <Loader2 size={16} className="animate-spin text-gray-400" />
                      : <Trash2 size={16} className="text-red-500" />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
