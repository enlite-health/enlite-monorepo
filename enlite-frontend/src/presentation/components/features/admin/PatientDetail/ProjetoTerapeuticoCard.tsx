/**
 * ProjetoTerapeuticoCard — o card da ficha (spec 017 F4; Figma `6390:13229`): no topo, a versão
 * "em andamento" (a mais recente por data de criação — Gabriel, 08/09); embaixo, TODAS as versões,
 * mais recente primeiro: VERSÃO · AUTOR · INÍCIO · TÉRMINO · ver. "Novo +" cria a major seguinte;
 * "Editar" cria a minor seguinte da versão em andamento. Tudo sob `patient_therapeutic_project`
 * (D286: o pai monta este card atrás do `ContainerGate`); as ações de escrita, sob `:write`.
 *
 * Deixou de ser placeholder em 08/09/2026 (spec 017; `2026-07-27a#DEC-05` superada pelo pedido do
 * Gabriel). Rótulo "ICHOM" não existe (D299.2).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Plus, Pencil } from 'lucide-react';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { currentVersion, type TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { useTherapeuticProjects } from '@hooks/admin/useTherapeuticProjects';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { TherapeuticProjectDrawer, type TherapeuticProjectTarget } from './therapeuticProject/TherapeuticProjectDrawer';
import { TherapeuticProjectVersionView } from './therapeuticProject/TherapeuticProjectVersionView';
import { formatIsoDateEsAr } from './therapeuticProject/pdf/therapeuticProjectPdfInput';

interface Props {
  patient: PatientDetail;
}

export function ProjetoTerapeuticoCard({ patient }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectCard.${k}`, o ?? {});
  const { versions, fieldClass, isLoading, error, refetch } = useTherapeuticProjects(patient.id);
  const [target, setTarget] = useState<TherapeuticProjectTarget | null>(null);
  const current = currentVersion(versions);
  const hasActiveService = patient.contractedServices.some((s) => s.active);
  // Sem `patient_services:read` a lista chega vazia por redação: o card não pode dizer "não tem serviço".
  const { visible: servicesReadable } = useContainerAccess('patient_services');

  return (
    <div data-testid="projeto-terapeutico-card" className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Heading level={1} as="h3" weight="semibold" color="primary">{tc('title')}</Heading>
        <div className="flex items-center gap-2">
          {/* "Novo": major seguinte. Sem serviço contratado ATIVO não há o que vincular (Gabriel 4a). */}
          <ActionButton resource="patient_therapeutic_project" action="write" variant="outline" size="sm" onClick={() => setTarget({ mode: 'new' })} disabled={!hasActiveService} title={hasActiveService ? undefined : tc('needsService')} className="flex items-center gap-1" data-testid="tp-new-btn">
            {tc('newButton')}
            <Plus className="w-4 h-4" />
          </ActionButton>
          {/* "Editar": minor seguinte da versão em andamento — nunca altera a existente. */}
          {current && (
            <ActionButton resource="patient_therapeutic_project" action="write" variant="primary" size="sm" onClick={() => setTarget({ mode: 'edit', version: current })} className="flex items-center gap-1" data-testid="tp-edit-btn">
              <Pencil className="w-4 h-4" />
              {t('admin.patients.detail.edit')}
            </ActionButton>
          )}
        </div>
      </div>

      {error ? (
        <Text size="sm" className="text-red-600" data-testid="tp-load-error">{error}</Text>
      ) : isLoading ? (
        <TableSkeleton />
      ) : versions.length === 0 ? (
        <Text size="sm" color="muted" data-testid="tp-empty">{hasActiveService || !servicesReadable ? tc('empty') : tc('needsService')}</Text>
      ) : (
        <>
          {current && (
            <div data-testid="tp-current">
              <TherapeuticProjectVersionView version={current} services={patient.contractedServices} compact servicesRedacted={!servicesReadable} />
            </div>
          )}
          <div className="overflow-x-auto" data-testid="tp-versions-table">
            <Table>
              <TableHeader>
                <TableHead unwrapped><span className="sr-only">{tc('tableView')}</span></TableHead>
                <TableHead>{tc('tableVersion')}</TableHead>
                <TableHead>{tc('tableAuthor')}</TableHead>
                <TableHead>{tc('tableStartDate')}</TableHead>
                <TableHead>{tc('tableEndDate')}</TableHead>
              </TableHeader>
              <TableBody>
                {versions.map((v: TherapeuticProjectVersion) => (
                  <TableRow key={v.id} onClick={() => setTarget({ mode: 'view', version: v, isCurrent: v.id === current?.id })} data-testid={`tp-row-${v.id}`} className={v.annulledAt ? 'opacity-60 line-through' : ''}>
                    <TableCell unwrapped>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setTarget({ mode: 'view', version: v, isCurrent: v.id === current?.id }); }} aria-label={tc('viewVersion', { version: v.version })} className="text-primary p-1 rounded hover:bg-gray-100" data-testid={`tp-view-${v.id}`}>
                        <Eye className="w-5 h-5" />
                      </button>
                    </TableCell>
                    <TableCell weight="medium">{v.version}</TableCell>
                    <TableCell>{v.createdByName ?? '—'}</TableCell>
                    <TableCell>{formatIsoDateEsAr(v.startDate) ?? '—'}</TableCell>
                    <TableCell>{formatIsoDateEsAr(v.endDate) ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {target && (
        <TherapeuticProjectDrawer
          patient={patient}
          target={target}
          fieldClass={fieldClass}
          onClose={() => setTarget(null)}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
