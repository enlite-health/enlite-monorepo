/**
 * TherapeuticCatalogPage — administração de UM catálogo do projeto terapêutico (spec 017, D299):
 * objetivos específicos, atividades (091: com serviço, objetivo, frequência e vínculo a CID-11), (change itinerario-trocas) motivos de saída do serviço (o tipo de patologia NÃO é catálogo: deriva do CID-11, D303).
 * Uma TELA por lista e uma célula por lista (decisão do Gabriel, 08/09) — o componente é o mesmo, parametrizado por `kind`;
 * a rota, a célula e o título mudam.
 *
 * POR QUE TELA E NÃO ENUM: a operação muda estas listas toda semana (as 8 opções do Figma são o
 * espelho dos segmentos do Ana Care, `2026-08-26a#DEC-09`); enum = migration + deploy a cada mudança.
 * Desativar nunca apaga: versões antigas do projeto guardam o id E o texto (snapshot, lex C19).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ListChecks, Edit2, Plus } from 'lucide-react';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import {
  SERVICE_EXIT_REASON_KIND,
  catalogHasDescription,
  SERVICE_EXIT_REASON_RESOURCE,
  SERVICE_SHIFT_TEMPLATE_KIND,
  SERVICE_SHIFT_TEMPLATE_RESOURCE,
  THERAPEUTIC_CATALOG_RESOURCE,
  type TherapeuticCatalogKind,
  type TherapeuticCatalogItem,
  type ShiftTemplate,
  type ShiftTemplateItem,
} from '@domain/entities/TherapeuticProject';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate, useContainerAccess } from '@presentation/hooks/useCellAccess';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { TherapeuticCatalogFormModal, CATALOG_SERVICE_CODES, type CatalogItemFormData } from './TherapeuticCatalogFormModal';
import { TherapeuticCatalogCidPanel, type CidPanelKind } from './TherapeuticCatalogCidPanel';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { catalogRefusalMessage } from './catalogRefusalMessage';
import { shiftEndTime } from '@domain/scheduleHours';
import { shiftRangeLabel } from '@presentation/components/features/admin/PatientDetail/itinerary/shiftRange';
import { sortAlphabeticallyEs } from '@presentation/components/features/admin/PatientDetail/therapeuticProject/alphabeticalOrder';

/**
 * Catálogos que esta tela administra: os 2 do projeto terapêutico (objetivos e atividades; 091 tirou `segments`) e
 * (change itinerario-trocas) os motivos de saída do serviço — o mesmo conjunto de `AdminCatalogKind` — mais a guardia predefinida.
 */
type ManagedCatalogKind = TherapeuticCatalogKind | typeof SERVICE_EXIT_REASON_KIND | typeof SERVICE_SHIFT_TEMPLATE_KIND;

/** Linha da tabela; a guardia predefinida (spec 074) chega com `items` e sem Ordem/descrição. */
type CatalogRow = TherapeuticCatalogItem & { items?: ShiftTemplateItem[] };

const templateRow = (tpl: ShiftTemplate): CatalogRow => ({ id: tpl.id, label: tpl.label, active: tpl.active, items: tpl.items, sortOrder: 0, deactivatedAt: null, createdAt: '', updatedAt: '' });

const CATALOG_RESOURCE: Readonly<Record<ManagedCatalogKind, string>> = {
  'specific-objectives': THERAPEUTIC_CATALOG_RESOURCE['specific-objectives'],
  activities: THERAPEUTIC_CATALOG_RESOURCE.activities,
  [SERVICE_EXIT_REASON_KIND]: SERVICE_EXIT_REASON_RESOURCE,
  [SERVICE_SHIFT_TEMPLATE_KIND]: SERVICE_SHIFT_TEMPLATE_RESOURCE,
};

type Tr = (k: string, o?: Record<string, unknown>) => string;

/** Tudo que uma célula precisa da tela (Strategy por coluna: a célula não conhece o `kind`). */
interface CellCtx {
  tr: Tr;
  t: TFunction;
  writeDenied: boolean;
  onEdit(item: CatalogRow): void;
  onToggle(item: CatalogRow): void;
  onOpenCid(item: CatalogRow): void;
}

/** Uma coluna da tabela: cabeçalho + célula. `columnsByKind` é a tabela que decide quais colunas cada catálogo tem. */
interface CatalogColumn {
  id: string;
  header(tr: Tr): string;
  align?: 'right';
  cell(item: CatalogRow, c: CellCtx): ReactNode;
}

const dash = <Text as="span" size="sm" color="muted">—</Text>;

const orderColumn: CatalogColumn = {
  id: 'order',
  header: (tr) => tr('table.order'),
  cell: (item) => <Text as="span" size="sm" color="muted" className="font-mono">{item.sortOrder}</Text>,
};

const labelColumn = (headerKey: 'table.title' | 'table.label'): CatalogColumn => ({
  id: 'label',
  header: (tr) => tr(headerKey),
  cell: (item, { t }) => (
    <>
      <Text as="span" size="sm" color={item.active ? 'primary' : 'muted'} data-testid={`therapeutic-catalog-label-${item.id}`}>{item.label}</Text>
      {item.items && (
        <Text size="xs" color="tertiary" className="mt-0.5" data-testid={`therapeutic-catalog-shifts-${item.id}`}>
          {item.items.map((it) => shiftRangeLabel(t, { startTime: it.startTime, endTime: shiftEndTime(it.startTime, it.durationMinutes), durationMinutes: it.durationMinutes }, 'full')).join(' · ')}
        </Text>
      )}
    </>
  ),
});

const descriptionColumn: CatalogColumn = {
  id: 'description',
  header: (tr) => tr('table.description'),
  cell: (item) => item.description ? (
    <Text size="xs" color="tertiary" className="line-clamp-2" title={item.description} data-testid={`therapeutic-catalog-description-${item.id}`}>
      {item.description}
    </Text>
  ) : dash,
};

const serviceColumn: CatalogColumn = {
  id: 'service',
  header: (tr) => tr('service'),
  cell: (item, { t }) => item.serviceCode ? (
    <Text as="span" size="sm" color="muted" data-testid={`therapeutic-catalog-service-${item.id}`}>
      {t(`admin.therapeuticCatalog.service${item.serviceCode}`, { defaultValue: item.serviceCode })}
    </Text>
  ) : dash,
};

const objectiveColumn: CatalogColumn = {
  id: 'objective',
  header: (tr) => tr('objective'),
  cell: (item, { tr }) => item.objectiveLabel ? (
    <Text as="span" size="sm" color="muted" data-testid={`therapeutic-catalog-objective-${item.id}`}>
      {item.objectiveActive === false ? `${item.objectiveLabel} (${tr('inactive')})` : item.objectiveLabel}
    </Text>
  ) : dash,
};

const frequencyColumn: CatalogColumn = {
  id: 'frequency',
  header: (tr) => tr('frequency'),
  cell: (item) => item.suggestedFrequency ? (
    <Text as="span" size="sm" color="muted" data-testid={`therapeutic-catalog-frequency-${item.id}`}>{item.suggestedFrequency}</Text>
  ) : dash,
};

/** CIE-11: chip "N categorías" que abre o painel de CIDs (§9.7). */
const icdColumn: CatalogColumn = {
  id: 'icd',
  header: (tr) => tr('icdCategories'),
  cell: (item, { tr, onOpenCid }) => (
    <button
      type="button"
      onClick={() => onOpenCid(item)}
      className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 cursor-pointer"
      data-testid={`therapeutic-catalog-icd-${item.id}`}
    >
      {tr('icdCount', { count: item.categoryCount ?? 0 })}
    </button>
  ),
};

const statusColumn: CatalogColumn = {
  id: 'status',
  header: (tr) => tr('table.status'),
  cell: (item, { tr }) => (
    <span
      className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${item.active ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}
      data-testid={`therapeutic-catalog-status-${item.id}`}
    >
      {item.active ? tr('active') : tr('inactive')}
    </span>
  ),
};

const actionsColumn: CatalogColumn = {
  id: 'actions',
  header: (tr) => tr('table.actions'),
  align: 'right',
  // D269: renomear e (des)ativar fazem PATCH → célula de escrita deste catálogo; sem ela, as ações SOMEM.
  cell: (item, { tr, writeDenied, onEdit, onToggle }) => writeDenied ? null : (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => onEdit(item)}
        className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-primary transition-colors cursor-pointer"
        aria-label={tr('editItem')}
        data-testid={`therapeutic-catalog-edit-${item.id}`}
      >
        <Edit2 className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => onToggle(item)}
        className="px-2 py-1 rounded hover:bg-gray-100 text-xs text-gray-600 hover:text-primary transition-colors cursor-pointer"
        data-testid={`therapeutic-catalog-toggle-${item.id}`}
      >
        {item.active ? tr('deactivate') : tr('activate')}
      </button>
    </div>
  ),
};

/** Colunas por catálogo (§9.7). Kind novo = uma linha aqui, sem `if` na tela. */
const columnsByKind: Readonly<Record<ManagedCatalogKind, readonly CatalogColumn[]>> = {
  'specific-objectives': [labelColumn('table.title'), descriptionColumn, serviceColumn, icdColumn, statusColumn, actionsColumn],
  activities: [labelColumn('table.title'), descriptionColumn, objectiveColumn, frequencyColumn, icdColumn, statusColumn, actionsColumn],
  [SERVICE_EXIT_REASON_KIND]: [orderColumn, labelColumn('table.label'), statusColumn, actionsColumn],
  [SERVICE_SHIFT_TEMPLATE_KIND]: [labelColumn('table.label'), statusColumn, actionsColumn],
};

/** Painel de CIDs por kind (só objetivo e atividade têm vínculo). */
const CID_PANEL_KIND: Partial<Record<ManagedCatalogKind, CidPanelKind>> = {
  'specific-objectives': 'objective',
  activities: 'activity',
};

/** Filtro de CIE-11: só dispara com um código de categoria completo (4 caracteres, DD-20: "vínculo existe"). */
const ICD_FILTER_LENGTH = 4;

interface Props {
  kind: ManagedCatalogKind;
}

/** Chave de i18n do título/subtítulo por catálogo — `admin.therapeuticCatalog.kinds.<kind>`. */
const KIND_KEY: Readonly<Record<ManagedCatalogKind, string>> = {
  'specific-objectives': 'specificObjectives',
  activities: 'activities',
  [SERVICE_EXIT_REASON_KIND]: 'serviceExitReasons',
  [SERVICE_SHIFT_TEMPLATE_KIND]: 'serviceShiftTemplates',
};

export function TherapeuticCatalogPage({ kind }: Props): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tr: Tr = (k, o) => t(`admin.therapeuticCatalog.${k}`, o ?? {});
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
    'service-shift-templates': useActionGate('catalog_service_shift_templates', 'update'),
  } as const;
  const writeGate = writeGates[kind];

  const isTemplate = kind === SERVICE_SHIFT_TEMPLATE_KIND;
  const [items, setItems] = useState<CatalogRow[]>([]);
  // Spec 061: objetivo/atividade não mostram nem editam a Ordem — a lista é A–Z; os motivos de saída seguem na ordem do servidor.
  // A guardia predefinida (spec 074) também não tem Ordem: lista A–Z, com os turnos sob o rótulo.
  const [serviceFilter, setServiceFilter] = useState('');
  const showOrder = !catalogHasDescription(kind) && !isTemplate;
  const sorted = showOrder ? items : sortAlphabeticallyEs(items);
  const hasServiceFilter = kind === 'specific-objectives';
  const shownItems = hasServiceFilter && serviceFilter ? sorted.filter((i) => i.serviceCode === serviceFilter) : sorted;
  // 091: atividade escolhe o objetivo dono (select do modal + filtro); `null` = lista não veio (sem célula de objetivos ou falha).
  const [objectives, setObjectives] = useState<TherapeuticCatalogItem[] | null>(null);
  const hasObjectiveLink = kind === 'activities';
  const cidPanelKind = CID_PANEL_KIND[kind];
  // Filtros (§9.7): Servicio (objetivos, no front) · Objetivo (atividades, servidor) · CIE-11 (servidor: `categoryCode`, "vínculo existe", DD-20).
  const [objectiveFilter, setObjectiveFilter] = useState('');
  const [icdFilter, setIcdFilter] = useState('');
  const categoryCode = cidPanelKind && icdFilter.trim().length === ICD_FILTER_LENGTH ? icdFilter.trim().toUpperCase() : undefined;
  const objectiveIdFilter = hasObjectiveLink && objectiveFilter ? objectiveFilter : undefined;
  const [cidPanel, setCidPanel] = useState<CatalogRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const columns = columnsByKind[kind];
  const [formModal, setFormModal] = useState<{ open: boolean; item: CatalogRow | null }>({ open: false, item: null });

  const fetchItems = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      // includeInactive: quem administra precisa ver o que está desligado para poder reativar.
      const [itemsRes, objectivesRes] = await Promise.allSettled([
        isTemplate
          ? AdminTherapeuticProjectsApiService.listShiftTemplates({ includeInactive: true }).then((list) => list.map(templateRow))
          : AdminTherapeuticProjectsApiService.listCatalog(kind as TherapeuticCatalogKind, {
              includeInactive: true,
              ...(categoryCode ? { categoryCode } : {}),
              ...(objectiveIdFilter ? { objectiveId: objectiveIdFilter } : {}),
            }),
        hasObjectiveLink ? AdminTherapeuticProjectsApiService.listCatalog('specific-objectives', { includeInactive: true }) : Promise.resolve(null),
      ]);
      if (itemsRes.status === 'rejected') throw itemsRes.reason;
      setItems(itemsRes.value);
      // Falha na lista de objetivos → sem select no modal e sem filtro; o resto da tela segue.
      setObjectives(objectivesRes.status === 'fulfilled' ? objectivesRes.value : null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [kind, hasObjectiveLink, isTemplate, categoryCode, objectiveIdFilter]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  async function handleFormSave(data: CatalogItemFormData): Promise<void> {
    if (isTemplate) {
      const body = { label: data.label ?? '', items: data.items ?? [] };
      if (formModal.item) await AdminTherapeuticProjectsApiService.updateShiftTemplate(formModal.item.id, body);
      else await AdminTherapeuticProjectsApiService.createShiftTemplate(body);
    } else if (formModal.item) {
      await AdminTherapeuticProjectsApiService.updateCatalogItem(kind as TherapeuticCatalogKind, formModal.item.id, data);
    } else {
      await AdminTherapeuticProjectsApiService.createCatalogItem(kind as TherapeuticCatalogKind, { ...data, label: data.label ?? '' });
    }
    setFormModal({ open: false, item: null });
    setActionError(null);
    await fetchItems();
  }

  async function handleToggleActive(item: CatalogRow): Promise<void> {
    try {
      setActionError(null);
      if (isTemplate) await AdminTherapeuticProjectsApiService.updateShiftTemplate(item.id, { active: !item.active });
      else await AdminTherapeuticProjectsApiService.updateCatalogItem(kind as TherapeuticCatalogKind, item.id, { active: !item.active });
      await fetchItems();
    } catch (err: unknown) {
      setActionError(catalogRefusalMessage(err, t));
    }
  }

  const cellCtx: CellCtx = {
    tr,
    t,
    writeDenied: writeGate.denied,
    onEdit: (item) => setFormModal({ open: true, item }),
    onToggle: handleToggleActive,
    onOpenCid: setCidPanel,
  };

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

      {(hasServiceFilter || hasObjectiveLink || cidPanelKind) && (
        <div className="flex flex-wrap items-end gap-3 mb-4" data-testid="therapeutic-catalog-filters">
          {hasServiceFilter && (
            <div className="w-64">
              <Label htmlFor="therapeutic-catalog-filter-service">{tr('service')}</Label>
              <Combobox
                id="therapeutic-catalog-filter-service"
                value={serviceFilter}
                onChange={setServiceFilter}
                placeholder={t('common.all')}
                options={[{ value: '', label: t('common.all') }, ...CATALOG_SERVICE_CODES.map((code) => ({ value: code, label: tr(`service${code}`) }))]}
                data-testid="therapeutic-catalog-filter-service"
              />
            </div>
          )}
          {hasObjectiveLink && objectives !== null && (
            <div className="w-72">
              <Label htmlFor="therapeutic-catalog-filter-objective">{tr('objective')}</Label>
              <Combobox
                id="therapeutic-catalog-filter-objective"
                value={objectiveFilter}
                onChange={setObjectiveFilter}
                placeholder={t('common.all')}
                options={[{ value: '', label: t('common.all') }, ...objectives.map((o) => ({ value: o.id, label: o.label }))]}
                data-testid="therapeutic-catalog-filter-objective"
              />
            </div>
          )}
          {cidPanelKind && (
            <div className="w-64">
              <Label htmlFor="therapeutic-catalog-filter-icd">{tr('filterIcd')}</Label>
              <input
                id="therapeutic-catalog-filter-icd"
                type="search"
                value={icdFilter}
                onChange={(e) => setIcdFilter(e.target.value)}
                maxLength={ICD_FILTER_LENGTH}
                placeholder={tr('icdSearch')}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                data-testid="therapeutic-catalog-filter-icd"
              />
            </div>
          )}
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
              {columns.map((c) => <TableHead key={c.id} align={c.align}>{c.header(tr)}</TableHead>)}
            </TableHeader>
            <TableBody>
              {shownItems.map((item) => (
                <TableRow key={item.id} clickable={false} data-testid={`therapeutic-catalog-row-${item.id}`}>
                  {columns.map((c) => (
                    <TableCell key={c.id} align={c.align} unwrapped>{c.cell(item, cellCtx)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {formModal.open && (
        <TherapeuticCatalogFormModal
          kind={kind}
          item={formModal.item}
          objectives={objectives}
          onSave={handleFormSave}
          onClose={() => setFormModal({ open: false, item: null })}
        />
      )}
      {cidPanelKind && cidPanel && (
        <TherapeuticCatalogCidPanel
          kind={cidPanelKind}
          itemId={cidPanel.id}
          itemLabel={cidPanel.label}
          objectiveId={cidPanel.objectiveId ?? undefined}
          isOpen
          onClose={() => setCidPanel(null)}
          canWrite={!writeGate.denied}
          onChanged={() => { void fetchItems(); }}
        />
      )}
    </PageContainer>
  );
}

export default TherapeuticCatalogPage;
