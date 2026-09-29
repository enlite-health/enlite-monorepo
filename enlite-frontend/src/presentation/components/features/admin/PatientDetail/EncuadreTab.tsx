import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import type { PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { contractedServiceScheduleText } from './contractedServiceScheduleText';
import { ServiceTeamSection } from './ServiceTeamSection';

const EMPTY = '—';

interface EncuadreTabProps {
  patient: PatientDetail;
}

/**
 * Aba "Encuadre" — Figma nó 11340:76414, decisões do Gabriel de 29/09 (ver PR/brief da tarefa).
 *
 * Decisão 1: o quadro do encuadre (`ServiceTeamSection`/`ServiceTeamBoard`) SAIU da aba "Servicio
 * Contratado" e vive aqui, sozinho. A seleção de QUAL serviço contratado mostrar era antes estado
 * de `ServicosContratadosCard` (a MESMA tabela alimentava a linha escolhida) — como o quadro saiu
 * de lá, a seleção precisa de um seletor PRÓPRIO nesta aba: a tabela abaixo é um seletor
 * somente-leitura (sem lápis, sem foguete, sem drawer — essas ações continuam SÓ na aba "Servicio
 * Contratado", que é quem edita o serviço). Clicar uma linha troca o serviço do quadro C, igual ao
 * que a linha da outra aba fazia antes de mover.
 *
 * Divergências do Figma (nó 11340:76414), citando a decisão que resolve cada uma — nenhuma é
 * "achado meu": (a) a coluna SEXO do Figma não entra — nenhum campo do serviço contratado nem da
 * API desta tela carrega o sexo requerido (isso mora em `job_postings.required_sex`, da VAGA, sem
 * join aqui); (b) os ícones de olho/pasta por linha não entram — sem endpoint/ação definida para
 * eles nesta tabela; (c) "Prazo de pagamento" e "Valor líquido/hora" do bloco "Enquadre
 * Terapêutico" não entram — `AdminVacancyDetail.payment_term_days`/`net_hourly_rate` existem no
 * TIPO do front mas nenhuma rota do backend os popula (medido: grep vazio em `worker-functions/`);
 * (d) o modal de prestador (WhatsApp, Contato efetuado, Status, Data do evento, Anotações, Salvar,
 * Histórico) não entra — não há endpoint que junte `ServiceTeamMember` a telefone/observações, nem
 * tabela de histórico por evento para esse par prestador×serviço. Todas ficam listadas em "Sem
 * fonte" na saída da tarefa, não corrigidas aqui.
 */
export function EncuadreTab({ patient }: EncuadreTabProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (key: string, options?: Record<string, unknown>) =>
    t(`admin.patients.detail.contractedServicesCard.${key}`, options);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);

  const services = patient.contractedServices;
  const currentService = services.find((s) => s.id === selectedServiceId) ?? null;
  const currentAddress = currentService
    ? (patient.addresses ?? []).find((a) => a.id === currentService.addressId) ?? null
    : null;

  function handleSelectService(service: PatientContractedServiceDetail): void {
    setSelectedServiceId(service.id);
    setSelectionNonce((n) => n + 1);
  }

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="encuadre-tab"
    >
      <Heading level={1} as="h3" weight="semibold" color="primary">
        {t('admin.patients.detail.tabs.encuadre')}
      </Heading>

      <Table>
        <TableHeader>
          <TableHead>{tc('tableDevice')}</TableHead>
          <TableHead>{tc('tableProfessional')}</TableHead>
          <TableHead align="center">{tc('tableQuantity')}</TableHead>
          <TableHead>{tc('tableLocation')}</TableHead>
          <TableHead>{tc('tableSchedule')}</TableHead>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={5} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            services.map((service) => {
              const address = (patient.addresses ?? []).find((a) => a.id === service.addressId) ?? null;
              const scheduleText = contractedServiceScheduleText(service.schedule);
              return (
                <TableRow
                  key={service.id}
                  data-testid={`encuadre-service-row-${service.id}`}
                  className={service.active ? '' : 'opacity-60'}
                  selected={service.id === selectedServiceId}
                  onClick={() => handleSelectService(service)}
                >
                  <TableCell unwrapped>
                    {service.deviceTypes.length > 0
                      ? service.deviceTypes.map((d) => t(`admin.patients.deviceTypeOptions.${d}`, d)).join(', ')
                      : EMPTY}
                  </TableCell>
                  <TableCell unwrapped>
                    <Text as="span" size="sm" weight="medium">
                      {t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)}
                    </Text>
                  </TableCell>
                  <TableCell align="center">
                    {service.providersNeeded == null ? EMPTY : String(service.providersNeeded)}
                  </TableCell>
                  <TableCell unwrapped data-testid={`encuadre-service-location-${service.id}`}>
                    <div className="flex flex-col">
                      <Text as="span" size="sm">
                        {service.careLocation
                          ? t(`admin.patients.detail.contractedServicesCard.careLocationOptions.${service.careLocation}`, service.careLocation)
                          : EMPTY}
                      </Text>
                      {address && (
                        <Text as="span" size="xs" color="secondary" data-testid={`encuadre-service-address-${service.id}`}>
                          {patientAddressLabel(address)}
                        </Text>
                      )}
                    </div>
                  </TableCell>
                  <TableCell unwrapped>
                    {scheduleText ? <Text as="span" size="sm">{scheduleText}</Text> : <Text as="span" size="sm" color="secondary">{EMPTY}</Text>}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {/* Figma: bloco "Enquadre Terapêutico" — só os campos com fonte no dado do serviço
          (Horas semanales / Capacidad). "Plazo de pago" e "Valor líquido/hora" não têm fonte no
          backend (ver comentário da função) e por isso não aparecem aqui. */}
      {currentService && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1" data-testid="encuadre-detalhes">
          <Text as="span" size="sm" color="secondary">
            {t('admin.patients.detail.encuadreTab.weeklyHours')}:{' '}
            <Text as="span" size="sm" weight="medium" color="inherit">
              {currentService.weeklyHours == null ? EMPTY : currentService.weeklyHours}
            </Text>
          </Text>
          <Text as="span" size="sm" color="secondary">
            {t('admin.patients.detail.encuadreTab.capacity')}:{' '}
            <Text as="span" size="sm" weight="medium" color="inherit">
              {currentService.providersNeeded == null ? EMPTY : currentService.providersNeeded}
            </Text>
          </Text>
        </div>
      )}

      <ServiceTeamSection
        patientId={patient.id}
        service={currentService}
        address={currentAddress}
        selectionNonce={selectionNonce}
      />
    </div>
  );
}
