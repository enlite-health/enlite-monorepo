import { useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Rocket, ExternalLink } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { useToast } from '@presentation/hooks/useToast';
import type { PatientAddressDetail, PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { recruitmentMissingCodes } from '@domain/entities/PatientCompleteness';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { PatientContractedServicesEditDrawer, type ContractedServiceTarget } from './edit/PatientContractedServicesEditDrawer';
import { ContractedServiceDetailDrawer } from './ContractedServiceDetailDrawer';
import { contractedServiceScheduleText } from './contractedServiceScheduleText';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';

interface ServicosContratadosCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta servicio contratado") — abre o drawer. */
  focusRequest?: DrawerFocusRequest | null;
}

const EMPTY = '—';

/**
 * UMA linha da tabela — as 5 colunas do Figma (decisão do Gabriel 05/09; "Sexo" ficou de fora a
 * pedido dele). Dispositivo ≠ Local ≠ Endereço: três coisas distintas. O endereço é resolvido
 * pelo PONTEIRO `service.addressId` contra `patient.addresses` — nada de endereço é copiado no
 * serviço (migration 330). Clique na linha abre o detalhe completo (`ContractedServiceDetailDrawer`).
 */
/**
 * Ícone "Activar reclutamiento" — 1 por linha de serviço ATIVO (spec 018, PR-6, ADR-5,
 * `contracts/activation.md`). Desabilitado + tooltip quando falta código do gate
 * (`RECRUITMENT_BLOCKING_CODES`); some (vira "Ver vacante") quando o serviço já tem vaga viva.
 * A régua real é sempre o backend (422 `PATIENT_NOT_READY`) — este componente só antecipa o
 * estado na tela para a operadora não bater numa recusa óbvia.
 */
interface ActivateRecruitmentClickDeps {
  patientId: string;
  serviceId: string;
  missing: string[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onActivated: () => void;
  /** `tc` — já namespaced em `contractedServicesCard.` (ver uso abaixo). */
  tc: (k: string, o?: Record<string, unknown>) => string;
  /** `t` cru — os códigos de `completeness.items.*` vivem fora do namespace do `tc`. */
  t: (k: string, o?: any) => string;
  showToast: (message: string, kind: 'success' | 'error') => void;
}

/**
 * Guarda + chamada do `activate-recruitment` — extraído do `onClick` para ser testável DIRETO,
 * sem depender de disparar clique num botão HTML `disabled` (o `disabled` nativo já barra o
 * clique antes de o handler rodar — mesma armadilha do `runAssociateProvider` vizinho, "QA-caça
 * #4" no histórico deste diretório). O guard (`missing.length > 0 || busy`) é redundante com o
 * `disabled` do botão só NA UI; continua aqui porque é este código, e não o atributo HTML, que a
 * suíte prova.
 */
export async function runActivateRecruitmentClick(deps: ActivateRecruitmentClickDeps): Promise<void> {
  if (deps.missing.length > 0 || deps.busy) return;
  deps.setBusy(true);
  try {
    await AdminContractedServicesApiService.activateRecruitment(deps.patientId, deps.serviceId);
    deps.showToast(deps.tc('activateRecruitmentToast'), 'success');
    deps.onActivated();
  } catch (err) {
    if (err instanceof ContractedServiceApiError && err.code === 'SERVICE_ALREADY_RECRUITING') {
      deps.showToast(deps.tc('activateRecruitmentAlreadyRecruiting'), 'error');
      deps.onActivated(); // refetch: a ficha vai mostrar "Ver vacante" agora
    } else if (err instanceof ContractedServiceApiError && err.code === 'PATIENT_NOT_READY') {
      const codes = ((err.details?.missing as string[] | undefined) ?? []).map((code) =>
        deps.t(`admin.patients.detail.completeness.items.${code}`, code),
      );
      deps.showToast(deps.tc('activateRecruitmentTooltip', { items: codes.join(', ') }), 'error');
    } else {
      deps.showToast(deps.tc('activateRecruitmentError'), 'error');
    }
  } finally {
    deps.setBusy(false);
  }
}

function ActivateRecruitmentAction({
  patientId,
  service,
  missing,
  onActivated,
  t,
}: {
  patientId: string;
  service: PatientContractedServiceDetail;
  missing: string[];
  onActivated: () => void;
  t: (k: string, o?: any) => string;
}) {
  const showToast = useToast();
  const [busy, setBusy] = useState(false);
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.contractedServicesCard.${k}`, o);
  const serviceLabel = t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode);

  if (service.liveVacancyId) {
    return (
      <a
        href={`/admin/vacancies/${service.liveVacancyId}`}
        onClick={(e) => e.stopPropagation()}
        aria-label={tc('viewVacancyAria', { service: serviceLabel })}
        data-testid={`contracted-service-view-vacancy-${service.id}`}
        className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary inline-flex items-center gap-1"
      >
        <ExternalLink className="w-4 h-4" strokeWidth={2} />
      </a>
    );
  }

  const handleClick = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    await runActivateRecruitmentClick({
      patientId, serviceId: service.id, missing, busy, setBusy, onActivated, tc, t, showToast,
    });
  };

  return (
    <ActionButton
      resource="patient_services"
      action="write"
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={missing.length > 0 || busy}
      title={missing.length > 0 ? tc('activateRecruitmentTooltip', { items: missing.map((code) => t(`admin.patients.detail.completeness.items.${code}`, code)).join(', ') }) : undefined}
      aria-label={tc('activateRecruitmentAria', { service: serviceLabel })}
      data-testid={`contracted-service-activate-recruitment-${service.id}`}
      className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Rocket className="w-4 h-4" strokeWidth={2} />
    </ActionButton>
  );
}

function ServiceRow({
  patientId,
  service,
  addresses,
  insuranceInformed,
  onOpen,
  onEdit,
  onActivated,
  podeEditar,
  t,
}: {
  patientId: string;
  service: PatientContractedServiceDetail;
  addresses: PatientAddressDetail[];
  insuranceInformed: string | null;
  onOpen: (service: PatientContractedServiceDetail) => void;
  onEdit: (service: PatientContractedServiceDetail) => void;
  onActivated: () => void;
  /** A MESMA régua do "+ Nuevo" e do "Editar" do detalhe, lida uma vez no card. */
  podeEditar: boolean;
  t: (k: string, o?: any) => string;
}) {
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.contractedServicesCard.${k}`, o);
  const address = addresses.find((a) => a.id === service.addressId) ?? null;
  const scheduleText = contractedServiceScheduleText(service.schedule);

  return (
    <TableRow
      data-testid={`contracted-service-row-${service.id}`}
      className={service.active ? '' : 'opacity-60'}
      onClick={() => onOpen(service)}
    >
      <TableCell unwrapped>
        {service.deviceTypes.length > 0
          ? service.deviceTypes
              .map((d) => t(`admin.patients.deviceTypeOptions.${d}`, d))
              .join(', ')
          : EMPTY}
      </TableCell>
      <TableCell unwrapped>
        <div className="flex items-center gap-2">
          <Text as="span" size="sm" weight="medium">
            {t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)}
          </Text>
          {!service.active && (
            <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
              <Text as="span" size="xs" weight="medium" color="inherit">
                {tc('inactiveBadge')}
              </Text>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell align="center" data-testid={`contracted-service-providers-${service.id}`}>
        {service.providersNeeded == null ? EMPTY : String(service.providersNeeded)}
      </TableCell>
      <TableCell unwrapped data-testid={`contracted-service-location-${service.id}`}>
        <div className="flex flex-col">
          <Text as="span" size="sm">
            {service.careLocation
              ? t(`admin.patients.detail.contractedServicesCard.careLocationOptions.${service.careLocation}`, service.careLocation)
              : EMPTY}
          </Text>
          {/* Sem endereço vinculado é um AVISO, não um traço: é o que trava a ativação
              (checklist SERVICE_ADDRESS) e a operadora precisa ver isso aqui, na linha. */}
          {address ? (
            <Text as="span" size="xs" color="secondary" data-testid={`contracted-service-address-${service.id}`}>
              {patientAddressLabel(address)}
            </Text>
          ) : (
            <Text as="span" size="xs" className="text-amber-700" data-testid={`contracted-service-address-missing-${service.id}`}>
              {tc('noAddressLinked')}
            </Text>
          )}
        </div>
      </TableCell>
      <TableCell unwrapped data-testid={`contracted-service-schedule-${service.id}`}>
        {/* Decisão do Gabriel 07/09: "Sin horario" deixou de ser um traço cinza. É o que trava a
            mudança de status para activo/búsqueda/reemplazo (checklist SERVICE_SCHEDULE), então
            recebe o MESMO âmbar do endereço faltante ao lado — pendência de igual peso, mesma cor. */}
        {scheduleText ? (
          <Text as="span" size="sm">{scheduleText}</Text>
        ) : (
          /* `color="inherit"` é obrigatório, não enfeite: o default do `Text` é `secondary` →
             emite `text-gray-800`, e um `text-amber-700` no `className` PERDE pela ordem em que
             o Tailwind emite as classes — medido com `getComputedStyle`: rgb(115,115,115), cinza.
             `inherit` não emite classe nenhuma, então a do `className` é a única e vale. */
          <Text
            as="span"
            size="sm"
            color="inherit"
            className="text-amber-700"
            data-testid={`contracted-service-schedule-missing-${service.id}`}
          >
            {tc('noSchedule')}
          </Text>
        )}
      </TableCell>
      {/* Lápis na linha (Gabriel, 06/09): a tabela É a lista — editar abre SÓ este serviço, sem
          passar por um drawer-lista. `stopPropagation` para o clique não abrir o detalhe junto. */}
      <TableCell unwrapped align="right">
        <div className="flex items-center justify-end gap-1">
          {/* Spec 018, PR-6: ativar recrutamento é POR SERVIÇO ATIVO — a baixa (não `service.active`)
              não mostra o ícone, é ativação de nada. As 2 células que alimentam o gate (endereço
              vivo + horário) já estão nesta MESMA linha, mais a cobertura do paciente. */}
          {service.active && (
            <ActivateRecruitmentAction
              patientId={patientId}
              service={service}
              missing={recruitmentMissingCodes({
                serviceHasAddress: addresses.some((a) => a.id === service.addressId),
                serviceHasSchedule: Array.isArray(service.schedule) && service.schedule.length > 0,
                insuranceInformed,
              })}
              onActivated={onActivated}
              t={t}
            />
          )}
          {/* D269/D286: o lápis faz PATCH → mesma régua do "Nuevo" (`useActionGate`, só com enforcement on). */}
          {podeEditar && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit(service); }}
              aria-label={tc('editRowAria', { service: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode) })}
              data-testid={`contracted-service-edit-${service.id}`}
              className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Pencil className="w-4 h-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ServicosContratadosCard({ patient, onSaved, focusRequest }: ServicosContratadosCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ContractedServiceTarget | null>(null);
  const [selected, setSelected] = useState<PatientContractedServiceDetail | null>(null);
  // D269/D286: as TRÊS portas para o PATCH (+ Nuevo, lápis da linha, "Editar" do detalhe) seguem a
  // mesma célula — o gate do sync main→stage (08/09) achou a terceira aberta.
  const { allowed: podeEditar } = useActionGate('patient_services', 'write');
  const services = patient.contractedServices;
  // Checklist "falta serviço" → formulário de um serviço NOVO.
  useAutoOpenDrawer(focusRequest, 'CONTRACTED_SERVICE', () => setEditing({ kind: 'new' }));
  // Migration 330: "falta endereço no serviço" → abre o PRIMEIRO serviço ativo sem endereço vivo
  // (é dele que o checklist reclama); sem candidato, abre um novo.
  useAutoOpenDrawer(focusRequest, 'SERVICE_ADDRESS', () => {
    const vivos = new Set(patient.addresses.map((a) => a.id));
    const orfao = services.find((s) => s.active && (s.addressId == null || !vivos.has(s.addressId)));
    setEditing(orfao ? { kind: 'edit', serviceId: orfao.id } : { kind: 'new' });
  });
  // Decisão do Gabriel 07/09: "falta horário no serviço" → abre o PRIMEIRO serviço ativo sem
  // horário. `[]` conta como sem horário tanto quanto `null` (o `[]` é gravável fora da borda zod).
  useAutoOpenDrawer(focusRequest, 'SERVICE_SCHEDULE', () => {
    const semHorario = services.find(
      (s) => s.active && (!Array.isArray(s.schedule) || s.schedule.length === 0),
    );
    setEditing(semHorario ? { kind: 'edit', serviceId: semHorario.id } : { kind: 'new' });
  });

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="servicos-contratados-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.contractedServicesCard.title')}
        </Heading>
        {/* "+ Nuevo servicio" no lugar de "Editar servicios" (Gabriel, 06/09): a tabela já é a
            lista; editar um existente é pelo lápis da linha ou pelo botão do detalhe.
            D269/D286 — o POST do drawer exige `patient_services:write`: sem a célula o botão não existe. */}
        <ActionButton resource="patient_services" action="write" variant="outline" size="sm" onClick={() => setEditing({ kind: 'new' })} className="flex items-center gap-1" data-testid="new-service-btn">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.contractedServicesCard.newButton')}
        </ActionButton>
      </div>

      {editing && (
        <PatientContractedServicesEditDrawer
          patient={patient}
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={() => onSaved?.()}
        />
      )}

      {selected && (
        // `key`: trocar de serviço nos 300 ms da animação de fechar REMONTA o drawer — sem isto
        // o `show` interno ficava `false` e o clique na outra linha "não abria" (gate, 06/09).
        <ContractedServiceDetailDrawer
          key={selected.id}
          service={selected}
          addresses={patient.addresses}
          onClose={() => setSelected(null)}
          onEdit={podeEditar ? () => { const id = selected.id; setSelected(null); setEditing({ kind: 'edit', serviceId: id }); } : undefined}
        />
      )}

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableDevice')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableProfessional')}</TableHead>
          <TableHead align="center">{t('admin.patients.detail.contractedServicesCard.tableQuantity')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableLocation')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableSchedule')}</TableHead>
          <TableHead unwrapped><span className="sr-only">{t('admin.patients.detail.contractedServicesCard.tableActions')}</span></TableHead>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={6} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            services.map((svc) => (
              <ServiceRow
                key={svc.id}
                patientId={patient.id}
                service={svc}
                addresses={patient.addresses}
                insuranceInformed={patient.insuranceInformed}
                onOpen={setSelected}
                onEdit={(s) => setEditing({ kind: 'edit', serviceId: s.id })}
                onActivated={() => onSaved?.()}
                podeEditar={podeEditar}
                t={t}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
