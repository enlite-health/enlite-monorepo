/**
 * PatientDocumentRow — um item da lista de documentos do paciente (spec 031): nome, origem, autor,
 * data, tamanho, "Ver", lápis de renomear em linha (FR-013) e excluir.
 *
 * Renomear em linha: lápis → campo → Enter salva, Esc cancela. Nome vazio/só espaços é RECUSADO
 * (mensagem, o campo continua aberto e o nome antigo segue na lista); nome igual ao atual só fecha
 * o campo, sem chamar o servidor. Falha do servidor mantém o campo aberto, com a mensagem.
 *
 * O nome é texto digitado pela operadora (FR-009): `data-clarity-mask` em todo nó que o desenha,
 * inclusive o campo de edição. Os botões de lápis/excluir só existem se o chamador permitir (célula).
 */
import { useState, type JSX, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Pencil, Trash2 } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Input } from '@presentation/components/atoms/Input';
import type { PatientDocument } from '@infrastructure/http/AdminPatientDocumentsApiService';
import { formatMessageDateTime } from '../conversation/messageDateFormat';
import { formatFileSize, iconComponentForContentType } from '../conversation/attachmentIcon';
import { renameErrorKey } from './documentErrors';

const MAX_LABEL_LENGTH = 255;

interface Props {
  doc: PatientDocument;
  canUpdate: boolean;
  canDelete: boolean;
  onView: (docId: string) => void;
  onRename: (docId: string, label: string) => Promise<void>;
  onDelete: (doc: PatientDocument) => void;
}

export function PatientDocumentRow({ doc, canUpdate, canDelete, onView, onRename, onDelete }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const td = (key: string, opts?: Record<string, string>): string => t(`admin.patients.detail.documentsTab.${key}`, opts);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = doc.label ?? td('untitled');
  const Icon = iconComponentForContentType(doc.contentType);
  const author = doc.createdByDisplayName ? td('author', { name: doc.createdByDisplayName }) : td('unknownAuthor');
  const when = formatMessageDateTime(
    doc.createdAt,
    i18n.language,
    t('admin.patients.detail.conversation.thread.dateConnector'),
  );

  const startEdit = (): void => {
    setDraft(doc.label ?? '');
    setError(null);
    setEditing(true);
  };

  const cancelEdit = (): void => {
    setEditing(false);
    setError(null);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const next = draft.trim();
    if (!next) {
      setError(td('renameEmpty'));
      return;
    }
    if (next === doc.label) {
      cancelEdit();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRename(doc.id, next);
      setEditing(false);
    } catch (err) {
      setError(t(renameErrorKey(err)));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div
      data-testid={`patient-document-row-${doc.id}`}
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg border border-gray-600 bg-white"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Icon size={18} className="text-primary shrink-0" aria-hidden="true" />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          {editing ? (
            <>
              <Input
                autoFocus
                value={draft}
                disabled={saving}
                maxLength={MAX_LABEL_LENGTH}
                aria-label={td('renameInputLabel')}
                data-clarity-mask="True"
                data-testid={`patient-document-rename-input-${doc.id}`}
                onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
                onKeyDown={onKeyDown}
              />
              {error && (
                <Text size="xs" role="alert" className="text-red-800" data-testid={`patient-document-rename-error-${doc.id}`}>
                  {error}
                </Text>
              )}
            </>
          ) : (
            <Text
              as="span"
              size="sm"
              weight="medium"
              className="truncate text-gray-900"
              title={name}
              data-clarity-mask="True"
              data-testid={`patient-document-name-${doc.id}`}
            >
              {name}
            </Text>
          )}
          <Text as="span" size="xs" className="text-slate-600" data-testid={`patient-document-meta-${doc.id}`}>
            {[td(doc.origin === 'chat' ? 'originChat' : 'originTab'), author, when, formatFileSize(doc.sizeBytes)].join(' · ')}
          </Text>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onView(doc.id)}
          className="p-1.5 rounded hover:bg-gray-200 transition-colors"
          title={td('view')}
          aria-label={td('view')}
          data-testid={`patient-document-view-${doc.id}`}
        >
          <Eye size={16} className="text-slate-600" aria-hidden="true" />
        </button>
        {canUpdate && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className="p-1.5 rounded hover:bg-gray-200 transition-colors"
            title={td('rename')}
            aria-label={td('rename')}
            data-testid={`patient-document-rename-${doc.id}`}
          >
            <Pencil size={16} className="text-slate-600" aria-hidden="true" />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => onDelete(doc)}
            className="p-1.5 rounded hover:bg-red-50 transition-colors"
            title={td('delete')}
            aria-label={td('delete')}
            data-testid={`patient-document-delete-${doc.id}`}
          >
            <Trash2 size={16} className="text-red-800" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
