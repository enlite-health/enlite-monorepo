import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus } from 'lucide-react';
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
import { Button } from '@presentation/components/atoms/Button';
import type { PatientAddressDetail, PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
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
function ServiceRow({
  service,
  addresses,
  onOpen,
  onEdit,
  t,
}: {
  service: PatientContractedServiceDetail;
  addresses: PatientAddressDetail[];
  onOpen: (service: PatientContractedServiceDetail) => void;
  onEdit: (service: PatientContractedServiceDetail) => void;
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
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit(service); }}
          aria-label={tc('editRowAria', { service: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode) })}
          data-testid={`contracted-service-edit-${service.id}`}
          className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <Pencil className="w-4 h-4" strokeWidth={2} />
        </button>
      </TableCell>
    </TableRow>
  );
}

export function ServicosContratadosCard({ patient, onSaved, focusRequest }: ServicosContratadosCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<ContractedServiceTarget | null>(null);
  const [selected, setSelected] = useState<PatientContractedServiceDetail | null>(null);
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
            lista; editar um existente é pelo lápis da linha ou pelo botão do detalhe. */}
        <Button variant="outline" size="sm" onClick={() => setEditing({ kind: 'new' })} className="flex items-center gap-1" data-testid="new-service-btn">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.contractedServicesCard.newButton')}
        </Button>
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
          onEdit={() => { const id = selected.id; setSelected(null); setEditing({ kind: 'edit', serviceId: id }); }}
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
              <ServiceRow key={svc.id} service={svc} addresses={patient.addresses} onOpen={setSelected} onEdit={(s) => setEditing({ kind: 'edit', serviceId: s.id })} t={t} />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
