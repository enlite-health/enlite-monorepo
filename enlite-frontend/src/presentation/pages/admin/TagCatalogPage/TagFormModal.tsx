/**
 * TagFormModal — side-sheet (desliza da direita, padrão do DS) para criar ou
 * editar uma tag do catálogo. A cor é escolhida numa paleta de presets.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check } from 'lucide-react';
import type { WorkerTag } from '@domain/entities/WorkerTag';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

/** Paleta de presets da marca — cores distintas e legíveis como chip. */
const COLOR_PRESETS = [
  '#DC2626', '#EA580C', '#D97706', '#16A34A',
  '#059669', '#0891B2', '#0EA5E9', '#2563EB',
  '#7C3AED', '#DB2777', '#6B21A8', '#475569',
] as const;

/** Calcula luminância relativa para decidir cor de texto (claro/escuro). */
function getTextColor(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff';
}

interface TagFormModalProps {
  tag: WorkerTag | null;
  onSave: (data: { name: string; color: string; description?: string }) => Promise<void>;
  onClose: () => void;
}

export function TagFormModal({ tag, onSave, onClose }: TagFormModalProps): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? COLOR_PRESETS[10]);
  const [description, setDescription] = useState(tag?.description ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [show, setShow] = useState(false);

  const isEdit = tag !== null;
  const inputClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none';

  // Slide-in on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function handleClose() {
    setShow(false);
    setTimeout(onClose, 300);
  }

  async function handleSubmit() {
    if (!name.trim()) return;
    try {
      setIsLoading(true);
      setSaveError('');
      await onSave({
        name: name.trim(),
        color,
        description: description.trim() || undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg || (isEdit ? t('admin.tags.updateError') : t('admin.tags.createError')));
    } finally {
      setIsLoading(false);
    }
  }

  const previewTextColor = getTextColor(color);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${
          show ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleClose}
        data-testid="tag-form-backdrop"
      />

      {/* Side sheet */}
      <div
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-md bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${
          show ? 'translate-x-0' : 'translate-x-full'
        }`}
        data-testid="tag-form-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={2} weight="semibold" color="primary">
            {isEdit ? t('admin.tags.editTag') : t('admin.tags.newTag')}
          </Heading>
          <button
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded cursor-pointer"
            aria-label={t('admin.tags.cancel')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-8 py-8 space-y-6">
          {/* Name */}
          <div>
            <Label htmlFor="tag-name">{t('admin.tags.name')}</Label>
            <input
              id="tag-name"
              type="text"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('admin.tags.namePlaceholder')}
              maxLength={80}
            />
          </div>

          {/* Color presets */}
          <div>
            <Label htmlFor="tag-color-grid">{t('admin.tags.color')}</Label>
            <div id="tag-color-grid" className="grid grid-cols-6 gap-2.5">
              {COLOR_PRESETS.map((preset) => {
                const selected = preset.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setColor(preset)}
                    aria-label={preset}
                    aria-pressed={selected}
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition-transform hover:scale-110 cursor-pointer ${
                      selected ? 'ring-2 ring-offset-2 ring-primary' : ''
                    }`}
                    style={{ backgroundColor: preset }}
                  >
                    {selected && <Check className="w-4 h-4" style={{ color: getTextColor(preset) }} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Description */}
          <div>
            <Label htmlFor="tag-description">{t('admin.tags.description')}</Label>
            <textarea
              id="tag-description"
              className={`${inputClass} resize-none h-20`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('admin.tags.descriptionPlaceholder')}
              maxLength={255}
            />
          </div>

          {/* Live preview */}
          <div>
            <Label htmlFor="tag-preview">{t('admin.tags.preview')}</Label>
            <div id="tag-preview">
              <span
                className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium"
                style={{ backgroundColor: color, color: previewTextColor }}
              >
                {name.trim() || t('admin.tags.previewPlaceholder')}
              </span>
            </div>
          </div>

          {saveError && (
            <Text as="p" size="xs" color="inherit" className="text-red-600">
              {saveError}
            </Text>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-8 py-5 border-t border-slate-100 shrink-0">
          <button
            type="button"
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 cursor-pointer"
            onClick={handleClose}
          >
            {t('admin.tags.cancel')}
          </button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            isLoading={isLoading}
            disabled={!name.trim()}
          >
            {t('admin.tags.save')}
          </Button>
        </div>
      </div>
    </>
  );
}
