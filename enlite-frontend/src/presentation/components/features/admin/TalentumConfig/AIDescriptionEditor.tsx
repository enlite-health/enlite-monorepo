import { useTranslation } from 'react-i18next';
import { Loader2, Check } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Persist the edited description (and propagate to Talentum if published). */
  onSave?: () => void;
  isSaving?: boolean;
  saved?: boolean;
  /** true when the last save also propagated the edit to a published Talentum project. */
  propagated?: boolean;
  saveError?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AIDescriptionEditor({
  value,
  onChange,
  onSave,
  isSaving = false,
  saved = false,
  propagated = false,
  saveError = null,
}: Props) {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.talentumConfig.descriptionEditor.${k}`);

  const charCount = value.length;
  const canSave = value.trim().length > 0 && !isSaving;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (e.target.value.length <= MAX_CHARS) {
      onChange(e.target.value);
    }
  };

  return (
    <div className="flex flex-col gap-1 w-full">
      {/* Label */}
      <label className="font-['Lexend'] font-medium text-[18px] text-[#737373]">
        {tc('label')}
      </label>

      {/* Container */}
      <div className="border-2 border-[#d9d9d9] rounded-[10px] p-4 relative">
        <textarea
          value={value}
          onChange={handleChange}
          placeholder={tc('placeholder')}
          className="w-full h-[300px] resize-none outline-none font-['Lexend'] font-medium text-[18px] text-[#737373] leading-[1.5] bg-transparent placeholder:text-[#d9d9d9]"
          aria-label={tc('label')}
        />
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center">
        <span className="font-['Lexend'] text-[12px] text-[#737373]">
          {tc('helper')}
        </span>
        <span
          className={`font-['Lexend'] text-[12px] ${charCount >= MAX_CHARS ? 'text-red-500' : 'text-[#737373]'}`}
        >
          {charCount}/{MAX_CHARS}
        </span>
      </div>

      {/* Save action */}
      {onSave && (
        <div className="flex items-center gap-3 mt-1">
          <Button variant="outline" size="sm" onClick={onSave} disabled={!canSave}>
            {isSaving ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {tc('saving')}
              </span>
            ) : (
              tc('saveButton')
            )}
          </Button>
          {saved && !isSaving && (
            <span className="flex items-center gap-1 font-['Lexend'] text-[12px] text-green-600">
              <Check className="w-4 h-4" />
              {propagated ? tc('savedAndPropagated') : tc('saved')}
            </span>
          )}
          {saveError && !isSaving && (
            <span className="font-['Lexend'] text-[12px] text-red-500">{saveError}</span>
          )}
        </div>
      )}
    </div>
  );
}
