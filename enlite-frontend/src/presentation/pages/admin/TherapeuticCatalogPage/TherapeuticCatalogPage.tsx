/**
 * TherapeuticCatalogPage — administração de UM catálogo do projeto terapêutico (spec 017, D299):
 * objetivos específicos, rotina e atividades, (change itinerario-trocas) motivos de saída do serviço e segmentos Ana Care (spec 030) (o tipo de patologia NÃO é catálogo: deriva do CID-11, D303).
 * Uma TELA por lista e uma célula por lista (decisão do Gabriel, 08/09) — o componente é o mesmo, parametrizado por `kind`;
 * a rota, a célula e o título mudam.
 *
 * POR QUE TELA E NÃO ENUM: a operação muda estas listas toda semana (as 8 opções do Figma são o
 * espelho dos segmentos do Ana Care, `2026-08-26a#DEC-09`); enum = migration + deploy a cada mudança.
 * Desativar nunca apaga: versões antigas do projeto guardam o id E o texto (snapshot, lex C19).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListChecks, Edit2, Plus } from 'lucide-react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import {
  SERVICE_EXIT_REASON_KIND,
  SERVICE_EXIT_REASON_RESOURCE,
  THERAPEUTIC_CATALOG_RESOURCE,
  type TherapeuticCatalogKind,
  type TherapeuticCatalogItem,
} from '@domain/entities/TherapeuticProject';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate, useContainerAccess } from '@presentation/hooks/useCellAccess';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { TherapeuticCatalogFormModal, type CatalogItemFormData } from './TherapeuticCatalogFormModal';
import { catalogRefusalMessage } from './catalogRefusalMessage';
import { segmentDisplayLabel } from './catalogSegment';

/**
 * Catálogos que esta tela administra: os 3 do projeto terapêutico (inclui `segments`, spec 030) e
 * (change itinerario-trocas) os motivos de saída do serviço — o mesmo conjunto de `AdminCatalogKind`.
 */
type ManagedCatalogKind = TherapeuticCatalogKind | typeof SERVICE_EXIT_REASON_KIND;

const CATALOG_RESOURCE: Readonly<Record<ManagedCatalogKind, string>> = {
  'specific-objectives': THERAPEUTIC_CATALOG_RESOURCE['specific-objectives'],
  activities: THERAPEUTIC_CATALOG_RESOURCE.activities,
  segments: THERAPEUTIC_CATALOG_RESOURCE.segments,
  [SERVICE_EXIT_REASON_KIND]: SERVICE_EXIT_REASON_RESOURCE,
};

interface Props {
  kind: ManagedCatalogKind;
}

/** Chave de i18n do título/subtítulo por catálogo — `admin.therapeuticCatalog.kinds.<kind>`. */
const KIND_KEY: Readonly<Record<ManagedCatalogKind, string>> = {
  'specific-objectives': 'specificObjectives',
  activities: 'activities',
  [SERVICE_EXIT_REASON_KIND]: 'serviceExitReasons',
  segments: 'segments',
};

export function TherapeuticCatalogPage({ kind }: Props): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tr = (k: string, o?: Record<string, unknown>) => t(`admin.therapeuticCatalog.${k}`, o ?? {});
  const resource = CATALOG_RESOURCE[kind];

  // Trava de rota pela célula de LEITURA deste catálogo (defesa em profundidade; quem manda é o 403
  // do backend). Só nega com o engine ligado (D268/D286).
  const { visible } = useContainerAccess(resource);
  useEffect(() => {
    if (!visible) navigate('/admin', { replace: true });
  }, [visible, navigate]);
  // Nº fixo de chamadas (Rules of Hooks) e recurso LITERAL em cada uma: a catraca `ui-gate-debt`
  // só reconhece consumidor de célula por literal — `useActionGate(resource, …)` não conta.
  const writeGates = {
    'specific-objectives': useActionGate('catalog_therapeutic_objectives', 'update'),
    activities: useActionGate('catalog_therapeutic_activities', 'update'),
    'service-exit-reasons': useActionGate('catalog_service_exit_reasons', 'update'),
    segments: useActionGate('catalog_therapeutic_segments', 'update'),
  } as const;
  const writeGate = writeGates[kind];

  const [items, setItems] = useState<TherapeuticCatalogItem[]>([]);
  // Segmentos (spec 030): só objetivos/atividades se vinculam; `null` = sem célula (403) ou catálogo sem vínculo.
  const [segments, setSegments] = useState<TherapeuticCatalogItem[] | null>(null);
  const hasSegmentLink = kind === 'specific-objectives' || kind === 'activities';
  const inactiveSegment = (label: string) => tr('form.segmentInactive', { label });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formModal, setFormModal] = useState<{ open: boolean; item: TherapeuticCatalogItem | null }>({ open: false, item: null });

  const fetchItems = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      // includeInactive: quem administra precisa ver o que está desligado para poder reativar.
      const [itemsRes, segmentsRes] = await Promise.allSettled([
        AdminTherapeuticProjectsApiService.listCatalog(kind, { includeInactive: true }),
        hasSegmentLink ? AdminTherapeuticProjectsApiService.listCatalog('segments', { includeInactive: true }) : Promise.resolve(null),
      ]);
      if (itemsRes.status === 'rejected') throw itemsRes.reason;
      setItems(itemsRes.value);
      // 403 (sem `catalog_therapeutic_segments:read`) ou qualquer falha → sem campo e sem coluna; o resto da tela segue.
      setSegments(segmentsRes.status === 'fulfilled' ? segmentsRes.value : null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [kind, hasSegmentLink]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  async function handleFormSave(data: CatalogItemFormData): Promise<void> {
    if (formModal.item) {
      await AdminTherapeuticProjectsApiService.updateCatalogItem(kind, formModal.item.id, data);
    } else {
      await AdminTherapeuticProjectsApiService.createCatalogItem(kind, data);
    }
    setFormModal({ open: false, item: null });
    setActionError(null);
    await fetchItems();
  }

  async function handleToggleActive(item: TherapeuticCatalogItem): Promise<void> {
    try {
      setActionError(null);
      await AdminTherapeuticProjectsApiService.updateCatalogItem(kind, item.id, { active: !item.active });
      await fetchItems();
    } catch (err: unknown) {
      setActionError(catalogRefusalMessage(err, t));
    }
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <ListChecks className="w-6 h-6 text-primary" />
          {/* Sem data-testid: o atom Heading não repassa `data-*` (achado do QA da spec 017; LISTA). */}
          <Heading level={1} weight="semibold" color="primary">{tr(`kinds.${KIND_KEY[kind]}.title`)}</Heading>
        </div>
        <ActionButton
          resource={resource}
          action="create"
          variant="primary"
          size="md"
          onClick={() => setFormModal({ open: true, item: null })}
          data-testid="therapeutic-catalog-new-btn"
        >
          <Plus className="w-4 h-4" />
          {tr('newItem')}
        </ActionButton>
      </div>

      <Text size="sm" color="muted" className={kind === SERVICE_EXIT_REASON_KIND ? 'mb-2' : 'mb-6'}>{tr(`kinds.${KIND_KEY[kind]}.subtitle`)}</Text>
      {kind === SERVICE_EXIT_REASON_KIND && (
        <Text size="sm" className="mb-6" data-testid="catalog-guidance">{tr('kinds.serviceExitReasons.guidance')}</Text>
      )}

      {actionError && (
        <div className="mb-4 border border-red-300 bg-red-50 rounded-lg px-4 py-3" role="alert" data-testid="therapeutic-catalog-action-error">
          <Text size="sm" className="text-red-700">{actionError}</Text>
        </div>
      )}

      {loadError ? (
        <div className="py-12 text-center" data-testid="therapeutic-catalog-load-error">
          <Text color="inherit" className="text-red-600">{loadError}</Text>
        </div>
      ) : isLoading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center" data-testid="therapeutic-catalog-empty">
          <Text size="sm" color="muted">{tr('noItems')}</Text>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto" data-testid="therapeutic-catalog-table">
          <Table>
            <TableHeader>
              <TableHead>{tr('table.order')}</TableHead>
              <TableHead>{tr('table.label')}</TableHead>
              {segments !== null && <TableHead>{tr('table.segment')}</TableHead>}
              <TableHead>{tr('table.status')}</TableHead>
              <TableHead align="right">{tr('table.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} clickable={false} data-testid={`therapeutic-catalog-row-${item.id}`}>
                  <TableCell unwrapped>
                    <Text as="span" size="sm" color="muted" className="font-mono">{item.sortOrder}</Text>
                  </TableCell>
                  <TableCell unwrapped>
                    <Text as="span" size="sm" color={item.active ? 'primary' : 'muted'} data-testid={`therapeutic-catalog-label-${item.id}`}>{item.label}</Text>
                  </TableCell>
                  {segments !== null && (
                    <TableCell unwrapped>
                      <Text as="span" size="sm" color="muted" data-testid={`therapeutic-catalog-segment-${item.id}`}>
                        {segmentDisplayLabel(segments, item.segmentId, inactiveSegment) ?? '—'}
                      </Text>
                    </TableCell>
                  )}
                  <TableCell unwrapped>
                    <span
                      className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${item.active ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                      data-testid={`therapeutic-catalog-status-${item.id}`}
                    >
                      {item.active ? tr('active') : tr('inactive')}
                    </span>
                  </TableCell>
                  <TableCell align="right" unwrapped>
                    {/* D269: renomear e (des)ativar fazem PATCH → célula de escrita deste catálogo; sem ela, as ações SOMEM. */}
                    {!writeGate.denied && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setFormModal({ open: true, item })}
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-primary transition-colors cursor-pointer"
                          aria-label={tr('editItem')}
                          data-testid={`therapeutic-catalog-edit-${item.id}`}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(item)}
                          className="px-2 py-1 rounded hover:bg-gray-100 text-xs text-gray-600 hover:text-primary transition-colors cursor-pointer"
                          data-testid={`therapeutic-catalog-toggle-${item.id}`}
                        >
                          {item.active ? tr('deactivate') : tr('activate')}
                        </button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {formModal.open && (
        <TherapeuticCatalogFormModal
          item={formModal.item}
          segments={segments}
          onSave={handleFormSave}
          onClose={() => setFormModal({ open: false, item: null })}
        />
      )}
    </PageContainer>
  );
}

export default TherapeuticCatalogPage;
