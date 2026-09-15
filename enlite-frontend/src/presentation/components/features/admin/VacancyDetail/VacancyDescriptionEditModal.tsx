import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

const MAX_CHARS = 4000;

interface VacancyDescriptionEditModalProps {
  isOpen: boolean;
  vacancyId: string;
  /** Descrição atual (talentum_description) para pré-preencher o editor. */
  currentDescription: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Edita a talentum_description da vaga a partir da página de detalhe. Se a vaga
 * já estiver publicada no Talentum (e for de conta nossa), o backend propaga a
 * edição in-place. Vagas de outra conta retornam 409 com mensagem clara.
 *
 * Espelha o VacancyScheduleEditModal (mesmo layout de painel lateral).
 */
export function VacancyDescriptionEditModal({
  isOpen,
  vacancyId,
  currentDescription,
  onClose,
  onSuccess,
}: VacancyDescriptionEditModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.vacancyDetail.descriptionEditor.${k}`);
  const [value, setValue] = useState(currentDescription ?? '');
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(currentDescription ?? '');
      setApiError(null);
    }
  }, [isOpen, currentDescription]);

  if (!isOpen) return null;

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !saving;

  const handleSubmit = async (): Promise<void> => {
    setApiError(null);
    if (trimmed.length === 0) {
      setApiError(tc('errorEmpty'));
      return;
    }
    setSaving(true);
    try {
      await AdminApiService.updateTalentumDescription(vacancyId, value);
      onSuccess();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-slate-900/60 z-[60]"
        onClick={() => !saving && onClose()}
        data-testid="vacancy-description-modal-backdrop"
      />

      <aside
        className="fixed top-[10px] bottom-[10px] right-0 z-[60] w-full max-w-xl bg-white shadow-2xl rounded-tl-2xl rounded-bl-2xl flex flex-col"
        data-testid="vacancy-description-modal"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="secondary">
            {tc('title')}
          </Heading>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-[#737373] hover:text-red-500 transition-colors p-1 rounded disabled:opacity-50"
            aria-label={tc('close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          <Text size="sm" color="secondary">
            {tc('subtitle')}
          </Text>

          <textarea
            value={value}
            onChange={(e) => {
              if (e.target.value.length <= MAX_CHARS) setValue(e.target.value);
            }}
            disabled={saving}
            placeholder={tc('placeholder')}
            aria-label={tc('title')}
            data-testid="vacancy-description-textarea"
            className="w-full h-[360px] resize-none rounded-[10px] border-2 border-[#d9d9d9] p-4 outline-none font-['Lexend'] text-[15px] text-[#525252] leading-[1.6] focus:border-primary disabled:opacity-60"
          />

          <div className="flex justify-end">
            <span className={`text-[12px] ${value.length >= MAX_CHARS ? 'text-red-500' : 'text-[#737373]'}`}>
              {value.length}/{MAX_CHARS}
            </span>
          </div>

          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <Text size="sm" color="inherit" className="text-red-600">
                {apiError}
              </Text>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-100 shrink-0">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {tc('cancel')}
          </Button>
          {/* PUT /vacancies/:id/talentum-description → updateTalentumDescription → talentum:write. */}
          <ActionButton
            resource="talentum"
            action="update"
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            isLoading={saving}
            disabled={!canSave}
            data-testid="vacancy-description-save"
          >
            {saving ? tc('saving') : tc('save')}
          </ActionButton>
        </div>
      </aside>
    </>,
    document.body,
  );
}
