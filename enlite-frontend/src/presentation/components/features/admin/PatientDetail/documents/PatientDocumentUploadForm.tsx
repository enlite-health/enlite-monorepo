/**
 * PatientDocumentUploadForm — formulário de subir documento da aba "Documentos" (spec 031, FR-002):
 * nome livre OBRIGATÓRIO (sem lista sugerida), um arquivo por envio, "Subir" desabilitado com nome
 * vazio/só espaços ou sem arquivo. Mesma UX do "Otros Documentos" do prestador
 * (`AdditionalDocumentsSection`), sem tocá-lo (aquele é do autoatendimento).
 *
 * `accept` é só dica do seletor: tipo e tamanho quem decide é o SERVIDOR (413/415), e a mensagem
 * dele vira es-AR em `uploadErrorKey`. Nome do documento e nome do arquivo escolhido são texto da
 * operadora → `data-clarity-mask`.
 */
import { useState, type FormEvent, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Input } from '@presentation/components/atoms/Input';
import { Button } from '@presentation/components/atoms/Button';
import { uploadErrorKey } from './documentErrors';

const ACCEPTED_TYPES = '.pdf,.png,.jpg,.jpeg,.docx';
const MAX_LABEL_LENGTH = 255;

interface Props {
  onUpload: (label: string, file: File) => Promise<void>;
}

export function PatientDocumentUploadForm({ onUpload }: Props): JSX.Element {
  const { t } = useTranslation();
  const td = (key: string): string => t(`admin.patients.detail.documentsTab.${key}`);
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // O <input type="file"> não aceita `value` controlado: trocar a `key` o remonta vazio depois de um envio.
  const [fileInputKey, setFileInputKey] = useState(0);

  // Só há arquivo "pronto" com nome não vazio e sem envio em andamento — uma condição só para o botão e o Enter.
  const readyFile = label.trim() !== '' && !submitting ? file : null;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!readyFile) return;
    setSubmitting(true);
    setError(null);
    try {
      await onUpload(label.trim(), readyFile);
      setLabel('');
      setFile(null);
      setFileInputKey((k) => k + 1);
    } catch (err) {
      setError(t(uploadErrorKey(err)));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="patient-document-upload-form"
      className="flex flex-col gap-3 p-4 rounded-card border-2 border-dashed border-gray-800 bg-gray-200"
    >
      <Input
        type="text"
        placeholder={td('labelPlaceholder')}
        aria-label={td('labelAria')}
        value={label}
        maxLength={MAX_LABEL_LENGTH}
        onChange={(e) => setLabel(e.target.value.slice(0, MAX_LABEL_LENGTH))}
        data-clarity-mask="True"
        data-testid="patient-document-label-input"
      />
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <label className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-input border border-gray-800 bg-white cursor-pointer hover:border-primary transition-colors">
          <FileText size={16} className="text-slate-600 shrink-0" aria-hidden="true" />
          <span className="text-sm text-gray-900 font-lexend truncate" data-clarity-mask="True" data-testid="patient-document-file-name">
            {file ? file.name : td('selectFile')}
          </span>
          <input
            key={fileInputKey}
            type="file"
            accept={ACCEPTED_TYPES}
            className="hidden"
            data-testid="patient-document-file-input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Button
          type="submit"
          size="sm"
          disabled={readyFile === null}
          className="w-full sm:w-auto shrink-0"
          data-testid="patient-document-upload"
        >
          {td(submitting ? 'uploading' : 'upload')}
        </Button>
      </div>
      {error && (
        <Text as="p" size="xs" role="alert" className="text-red-800" data-testid="patient-document-upload-error">
          {error}
        </Text>
      )}
    </form>
  );
}
