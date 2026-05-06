import { useTranslation } from 'react-i18next';

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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AIDescriptionEditor({ value, onChange }: Props) {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.talentumConfig.descriptionEditor.${k}`);

  const charCount = value.length;

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
    </div>
  );
}
