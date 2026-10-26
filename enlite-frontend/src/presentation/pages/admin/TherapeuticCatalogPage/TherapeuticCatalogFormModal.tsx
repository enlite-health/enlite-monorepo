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
import {
  CATALOG_DESCRIPTION_MAX,
  CATALOG_LABEL_MAX,
  CATALOG_TITLE_MAX,
  type TherapeuticCatalogItem,
  type AdminCatalogKind,
  catalogHasDescription,
  SERVICE_SHIFT_TEMPLATE_KIND,
  type ShiftTemplate,
  type ShiftTemplateItem,
} from '@domain/entities/TherapeuticProject';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { catalogRefusalMessage } from './catalogRefusalMessage';
import { ShiftTemplateItemsField } from './ShiftTemplateItemsField';
import { segmentSelectOptions } from './catalogSegment';

export interface CatalogItemFormData {
  /** Objetivo/atividade em edição: só viaja se o título MUDOU (Merge Patch, spec 061) — título antigo >150 salva só a descrição. */
  label?: string;
  /** Só `segments` (spec 061: objetivo/atividade não têm ordem na tela). */
  sortOrder?: number;
  /** Só objetivo/atividade; `null` limpa. Ausente = não mexe. */
  description?: string | null;
  /** Só quando o campo existe E mudou; `null` limpa o vínculo (spec 030). */
  segmentId?: string | null;
  /** Só guardia predefinida (spec 074): os turnos `{ startTime, durationMinutes }`. */
  items?: ShiftTemplateItem[];
}

interface Props {
  kind: AdminCatalogKind | typeof SERVICE_SHIFT_TEMPLATE_KIND;
  item: TherapeuticCatalogItem | ShiftTemplate | null;
  /** Segmentos (inclui inativos) — `null`/ausente = sem célula de segmentos ou catálogo sem vínculo: o campo some. */
  segments?: TherapeuticCatalogItem[] | null;
  onSave: (data: CatalogItemFormData) => Promise<void>;
  onClose: () => void;
}


export function TherapeuticCatalogFormModal({ kind, item, segments = null, onSave, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const tr = (k: string, o?: Record<string, unknown>) => t(`admin.therapeuticCatalog.${k}`, o ?? {});
  const isEdit = item !== null;
  const isTemplate = kind === SERVICE_SHIFT_TEMPLATE_KIND;
  const catalogItem = isTemplate ? null : (item as TherapeuticCatalogItem | null);
  const [items, setItems] = useState<ShiftTemplateItem[]>(isTemplate && item !== null ? (item as ShiftTemplate).items : []);
  const [itemsValid, setItemsValid] = useState(true);
  // Spec 061: `segments` segue como era (rótulo 200 + Ordem); objetivo/atividade ganham título 150 + descrição, sem Ordem.
  const hasDescription = !isTemplate && catalogHasDescription(kind);
  const labelMax = !hasDescription ? CATALOG_LABEL_MAX : CATALOG_TITLE_MAX;
  const [label, setLabel] = useState(item?.label ?? '');
  const [description, setDescription] = useState(catalogItem?.description ?? '');
  const [sortOrder, setSortOrder] = useState(catalogItem ? String(catalogItem.sortOrder) : '');
  const initialSegmentId = catalogItem?.segmentId ?? '';
  const [segmentId, setSegmentId] = useState(initialSegmentId);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [show, setShow] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const trimmed = label.trim();
  const trimmedDescription = description.trim();
  const initialDescription = (catalogItem?.description ?? '').trim();
  const labelChanged = !isEdit || trimmed !== item.label;
  const descriptionChanged = trimmedDescription !== initialDescription;
  const segmentChanged = segments !== null && segmentId !== initialSegmentId;
  // O teto novo só barra título criado agora ou alterado: o antigo (até 200) segue editável sem ser recusado.
  const tooLong = trimmed.length > labelMax && (!hasDescription || labelChanged);
  const descriptionTooLong = hasDescription && trimmedDescription.length > CATALOG_DESCRIPTION_MAX;
  const nothingToSave = hasDescription && isEdit && !labelChanged && !descriptionChanged && !segmentChanged;
  const itemsOk = !isTemplate || (items.length > 0 && itemsValid);
  const canSave = itemsOk && trimmed.length > 0 && !tooLong && !descriptionTooLong && !nothingToSave && !isLoading;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSave) return;
    setIsLoading(true);
    setSaveError('');
    try {
      if (isTemplate) {
        await onSave({ label: trimmed, items });
        return;
      }
      const order = hasDescription || sortOrder.trim() === '' ? undefined : Number(sortOrder);
      // `segmentId` só viaja se o campo existe E mudou: reenviar um vínculo inativo seria recusado (422).
      await onSave({
        ...(!hasDescription || labelChanged ? { label: trimmed } : {}),
        ...(order !== undefined && Number.isFinite(order) ? { sortOrder: order } : {}),
        ...(hasDescription && descriptionChanged ? { description: trimmedDescription === '' ? null : trimmedDescription } : {}),
        ...(segmentChanged ? { segmentId: segmentId || null } : {}),
      });
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
            <Label htmlFor="therapeutic-catalog-label">{tr(!hasDescription ? 'form.label' : 'form.title')}</Label>
            <textarea
              id="therapeutic-catalog-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              rows={4}
              maxLength={labelMax + 50}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
              data-testid="therapeutic-catalog-label-input"
              autoFocus
            />
            {/* Ajuda quebra livre à esquerda; contador em coluna própria à direita (não encolhe, não quebra). */}
            <div className="flex items-start justify-between gap-3 mt-1">
              <Text size="xs" color="muted" className="min-w-0 flex-1">{tr(!hasDescription ? 'form.labelHelp' : 'form.titleHelp')}</Text>
              <Text size="xs" color={tooLong ? 'inherit' : 'muted'} className={`shrink-0 whitespace-nowrap ${tooLong ? 'text-red-600' : ''}`} data-testid="therapeutic-catalog-label-count">
                {trimmed.length}/{labelMax}
              </Text>
            </div>
          </div>
          {hasDescription && (
            <div>
              <Label htmlFor="therapeutic-catalog-description">{tr('form.description')}</Label>
              <textarea
                id="therapeutic-catalog-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                maxLength={CATALOG_DESCRIPTION_MAX + 200}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                data-testid="therapeutic-catalog-description-input"
              />
              <div className="flex items-start justify-between gap-3 mt-1">
                <Text size="xs" color="muted" className="min-w-0 flex-1">{tr('form.descriptionHelp')}</Text>
                <Text
                  size="xs"
                  color={descriptionTooLong ? 'inherit' : 'muted'}
                  className={`shrink-0 whitespace-nowrap ${descriptionTooLong ? 'text-red-600' : ''}`}
                  data-testid="therapeutic-catalog-description-count"
                >
                  {trimmedDescription.length}/{CATALOG_DESCRIPTION_MAX}
                </Text>
              </div>
            </div>
          )}
          {isTemplate && (
            <div className="flex flex-col gap-2">
              <ShiftTemplateItemsField value={items} onChange={setItems} onValidityChange={setItemsValid} />
              <Text size="xs" color="muted" data-testid="therapeutic-catalog-not-retroactive">{tr('shiftTemplates.notRetroactive')}</Text>
            </div>
          )}
          {!hasDescription && !isTemplate && (
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
          )}
          {segments !== null && (
            <div>
              <Label htmlFor="therapeutic-catalog-segment">{tr('form.segment')}</Label>
              <Combobox
                id="therapeutic-catalog-segment"
                value={segmentId}
                onChange={setSegmentId}
                placeholder={tr('form.segmentNone')}
                options={[
                  { value: '', label: tr('form.segmentNone') },
                  ...segmentSelectOptions(segments, segmentId, (l) => tr('form.segmentInactive', { label: l })),
                ]}
                data-testid="therapeutic-catalog-segment-select"
              />
              <Text size="xs" color="muted" className="mt-1">{tr('form.segmentHelp')}</Text>
            </div>
          )}
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
