/**
 * PreviewShell — a raiz do harness do enquadre (spec 052, Fase 0): escolhe, por estado, o componente REAL de produção a
 * renderizar. O relógio é fixo (14/10/2026 12:00 em Buenos Aires) e entra pelo `now` que `EnquadreTab` já aceita; nada
 * global (nem `Date`) é substituído. `?estado=indice` lista os 17.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { KanbanBoard } from '@presentation/components/features/admin/Kanban/KanbanBoard';
import { VacancyDetailTabs } from '@presentation/components/features/admin/VacancyDetail/VacancyDetailTabs';
import { EnquadreTab } from '@presentation/components/features/admin/VacancyDetail/Enquadre/EnquadreTab';
import { VACANCY_FUNNEL_COLUMNS } from '@presentation/components/features/admin/VacancyDetail/Funnel/funnelTabsConfig';
import { runAutoSteps } from './autoSteps';
import { DATASETS, datasetById, installDataset, type PreviewDataset } from './datasets';
import { HARNESS_NOW_ISO, HARNESS_VACANCY_ID, funnelStages } from './fixtures';

const NOW = new Date(HARNESS_NOW_ISO);
const now = (): Date => NOW;
const COLUMNS_WITHOUT_CONFIRMED = VACANCY_FUNNEL_COLUMNS.filter((c) => c.id !== 'CONFIRMED');

export function StateRoot({ dataset }: { dataset: PreviewDataset }): JSX.Element {
  if (dataset.root === 'funnel') {
    return (
      <KanbanBoard
        stages={funnelStages()}
        columns={COLUMNS_WITHOUT_CONFIRMED}
        vacancyId={HARNESS_VACANCY_ID}
        onMove={async () => null}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {dataset.root === 'tabs' && <VacancyDetailTabs activeTab="enquadre" onTabChange={() => undefined} />}
      <EnquadreTab vacancyId={HARNESS_VACANCY_ID} now={now} />
    </div>
  );
}

function Index(): JSX.Element {
  return (
    <div className="p-8" data-testid="preview-index">
      <h1 className="text-xl font-semibold mb-4">Protótipo do enquadre — 17 estados</h1>
      <ol className="flex flex-col gap-1">
        {DATASETS.map((d) => (
          <li key={d.id}><a className="text-primary underline" href={`?estado=${d.id}`} data-testid={`preview-link-${d.id}`}>E{Number(d.id)} — {d.title}</a></li>
        ))}
      </ol>
    </div>
  );
}

function Stage({ dataset }: { dataset: PreviewDataset }): JSX.Element {
  // O servidor falso é instalado ANTES do primeiro render (os hooks buscam ao montar).
  useMemo(() => { installDataset(dataset.id); }, [dataset.id]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void runAutoSteps(dataset.id).catch((err: unknown) => { console.error('auto-steps', err); }).finally(() => setReady(true));
  }, [dataset.id]);
  return (
    <div className="p-6 max-w-[1400px]" data-testid="preview-stage" data-estado={dataset.id} data-preview-ready={ready ? dataset.id : undefined}>
      <StateRoot dataset={dataset} />
    </div>
  );
}

export function PreviewShell({ estado }: { estado: string | null }): JSX.Element {
  const dataset = estado && estado !== 'indice' ? datasetById(estado) : undefined;
  return dataset ? <Stage dataset={dataset} /> : <Index />;
}
