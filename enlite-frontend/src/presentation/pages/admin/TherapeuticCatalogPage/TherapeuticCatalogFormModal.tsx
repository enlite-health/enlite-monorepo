/**
 * TherapeuticCatalogFormModal — criar ou renomear uma opção de um catálogo do projeto terapêutico
 * (spec 017). Um campo só: o rótulo (e a ordem, opcional). O texto é o que o operador vai escolher
 * no projeto e o que sai no PDF — em espanhol, um idioma só (D299.7).
 *
 * Guarda de dado pessoal (lex C18) é do SERVIDOR (400): aqui só o teto de caracteres, para o
 * operador saber antes de mandar.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { CATALOG_LABEL_MAX, type TherapeuticCatalogItem } from '@domain/entities/TherapeuticProject';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { catalogRefusalMessage } from './catalogRefusalMessage';

export interface CatalogItemFormData {
  label: string;
  sortOrder?: number;
}

interface Props {
  item: TherapeuticCatalogItem | null;
  onSave: (data: CatalogItemFormData) => Promise<void>;
  onClose: () => void;
}


export function TherapeuticCatalogFormModal({ item, onSave, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const tr = (k: string, o?: Record<string, unknown>) => t(`admin.therapeuticCatalog.${k}`, o ?? {});
  const isEdit = item !== null;
  const [label, setLabel] = useState(item?.label ?? '');
  const [sortOrder, setSortOrder] = useState(item ? String(item.sortOrder) : '');
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [show, setShow] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const trimmed = label.trim();
  const tooLong = trimmed.length > CATALOG_LABEL_MAX;
  const canSave = trimmed.length > 0 && !tooLong && !isLoading;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSave) return;
    setIsLoading(true);
    setSaveError('');
    try {
      const order = sortOrder.trim() === '' ? undefined : Number(sortOrder);
      await onSave({ label: trimmed, ...(order !== undefined && Number.isFinite(order) ? { sortOrder: order } : {}) });
    } catch (err: unknown) {
      setSaveError(catalogRefusalMessage(err, t));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="therapeutic-catalog-form-modal">
      <div className={`absolute inset-0 bg-black/30 transition-opacity ${show ? 'opacity-100' : 'opacity-0'}`} onClick={onClose} aria-hidden="true" />
      <form
        onSubmit={handleSubmit}
        className={`relative w-full max-w-md h-full bg-white shadow-xl flex flex-col transition-transform duration-200 ${show ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <Heading level={2} weight="semibold" color="primary">{isEdit ? tr('editItem') : tr('newItem')}</Heading>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-500" aria-label={t('common.close')} data-testid="therapeutic-catalog-form-close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          <div>
            <Label htmlFor="therapeutic-catalog-label">{tr('form.label')}</Label>
            <textarea
              id="therapeutic-catalog-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              rows={4}
              maxLength={CATALOG_LABEL_MAX + 50}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
              data-testid="therapeutic-catalog-label-input"
              autoFocus
            />
            <div className="flex justify-between mt-1">
              <Text size="xs" color="muted">{tr('form.labelHelp')}</Text>
              <Text size="xs" color={tooLong ? 'inherit' : 'muted'} className={tooLong ? 'text-red-600' : undefined} data-testid="therapeutic-catalog-label-count">
                {trimmed.length}/{CATALOG_LABEL_MAX}
              </Text>
            </div>
          </div>
          <div>
            <Label htmlFor="therapeutic-catalog-order">{tr('form.sortOrder')}</Label>
            <input
              id="therapeutic-catalog-order"
              type="number"
              min={0}
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="w-40 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
              data-testid="therapeutic-catalog-order-input"
            />
            <Text size="xs" color="muted" className="mt-1">{tr('form.sortOrderHelp')}</Text>
          </div>
          {saveError && (
            <div className="border border-red-300 bg-red-50 rounded-lg px-4 py-3" role="alert" data-testid="therapeutic-catalog-form-error">
              <Text size="sm" className="text-red-700">{saveError}</Text>
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!canSave} data-testid="therapeutic-catalog-form-save">
            {isLoading ? tr('form.saving') : tr('form.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
