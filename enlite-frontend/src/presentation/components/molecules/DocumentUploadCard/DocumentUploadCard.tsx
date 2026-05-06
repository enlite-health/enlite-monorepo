import { useRef, ChangeEvent } from 'react';
import { Text } from '@presentation/components/atoms';

interface DocumentUploadCardProps {
  label: string;
  isUploaded: boolean;
  isLoading?: boolean;
  onFileSelect: (file: File) => void;
  onDelete: () => void;
  onView: () => void;
  className?: string;
}

function FileIcon({ uploaded }: { uploaded: boolean }): JSX.Element {
  const color = uploaded ? '#180149' : 'rgba(115,115,115,0.5)';
  return (
    <svg width="33" height="40" viewBox="0 0 33 40" fill="none" aria-hidden="true">
      <path d="M20 1H4C2.3 1 1 2.3 1 4V36C1 37.7 2.3 39 4 39H29C30.7 39 32 37.7 32 36V13L20 1Z"
        stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 1V13H32" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 22H25M8 28H18" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function DocumentUploadCard({
  label, isUploaded, isLoading = false, onFileSelect, onDelete, onView, className = '',
}: DocumentUploadCardProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = (): void => {
    if (!isUploaded && !isLoading) inputRef.current?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
      e.target.value = '';
    }
  };

  const borderClass = isUploaded
    ? 'border-primary border-[2.5px]'
    : 'border-gray-700 border-[2.5px]';

  const cursorClass = isUploaded || isLoading ? 'cursor-default' : 'cursor-pointer hover:border-gray-800 transition-colors';

  return (
    <div
      role={isUploaded ? undefined : 'button'}
      tabIndex={isUploaded ? undefined : 0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      aria-label={isUploaded ? label : `Upload ${label}`}
      data-state={isUploaded ? 'uploaded' : isLoading ? 'loading' : 'empty'}
      className={`relative flex flex-col items-center justify-center gap-4 rounded-card min-h-[142px] px-6 py-4 ${borderClass} ${cursorClass} ${className}`}
    >
      {isLoading && (
        <div data-testid="upload-spinner" className="absolute inset-0 flex items-center justify-center bg-white/70 rounded-card">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {isUploaded && (
        <div className="absolute top-3 right-3 flex flex-col gap-2">
          <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }}
            aria-label="Remover documento" className="text-gray-800 hover:text-red-500 transition-colors">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M7 8.4L1.4 14 0 12.6 5.6 7 0 1.4 1.4 0 7 5.6 12.6 0 14 1.4 8.4 7 14 12.6 12.6 14 7 8.4Z" />
            </svg>
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onView(); }}
            aria-label="Visualizar documento" className="text-gray-800 hover:text-primary transition-colors">
            <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M1 6C1 6 3.5 1 8 1C12.5 1 15 6 15 6C15 6 12.5 11 8 11C3.5 11 1 6 1 6Z" />
              <circle cx="8" cy="6" r="2" />
            </svg>
          </button>
        </div>
      )}

      <FileIcon uploaded={isUploaded} />

      <Text
        as="p"
        size="base"
        weight="medium"
        color={isUploaded ? 'primary' : 'secondary'}
        className={`text-center ${!isUploaded ? 'opacity-50' : ''}`}
      >
        {label}
      </Text>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={handleFileChange}
        aria-hidden="true"
      />
    </div>
  );
}
