import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';
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
import { ContractedServiceDetailDrawer } from './ContractedServiceDetailDrawer';

const EMPTY = '—';

interface EncuadreTabProps {
  patient: PatientDetail;
}

/**
 * Aba "Encuadre" — Figma nó 11340:76414, decisões do Gabriel de 29/09 (rodada 1) e 29/09 (rodada
 * 2, correção de critério — ver brief da tarefa).
 *
 * Decisão 1 (rodada 1): o quadro do encuadre (`ServiceTeamSection`/`ServiceTeamBoard`) SAIU da
 * aba "Servicio Contratado" e vive aqui, sozinho. A seleção de QUAL serviço contratado mostrar
 * era antes estado de `ServicosContratadosCard` — como o quadro saiu de lá, a seleção precisa de
 * um seletor PRÓPRIO nesta aba: a tabela abaixo é um seletor somente-leitura de EDIÇÃO (sem
 * lápis, sem foguete — essas ações continuam SÓ na aba "Servicio Contratado"), mas com o ícone
 * OLHO (decisão B, rodada 2): abre o MESMO `ContractedServiceDetailDrawer` que a outra aba usa,
 * sem `onEdit` — vira somente-leitura de verdade (o próprio componente já suportava isso).
 *
 * Divergências do Figma que CONTINUAM sem fonte (rodada 2, decisões B/C) — não são "achado meu",
 * são decisão do Gabriel, citadas aqui para o pixel-check: (a) o ícone PASTA da linha e o botão
 * "Novo" do cabeçalho da tabela ficam FORA — criar/editar serviço continua só em "Servicio
 * Contratado" (decisão B); (b) "Prazo de pagamento" e "Valor líquido/hora" do bloco "Enquadre
 * Terapêutico" ficam FORA — financeiro decide depois (decisão C); nenhum dos dois tem fonte no
 * backend hoje (`AdminVacancyDetail.payment_term_days`/`net_hourly_rate` existem no TIPO do front,
 * nenhuma rota os popula). A coluna SEXO (decisão A) e o modal do prestador (decisão D) DEIXARAM
 * de ser divergência — ver `requiredSex` na tabela abaixo e `ServiceTeamProviderModal`.
 */
export function EncuadreTab({ patient }: EncuadreTabProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (key: string, options?: Record<string, unknown>) =>
    t(`admin.patients.detail.contractedServicesCard.${key}`, options);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const [viewingService, setViewingService] = useState<PatientContractedServiceDetail | null>(null);

  // D447.3: o painel do prestador abre focado no PACIENTE. Nome e WhatsApp vêm da ficha JÁ
  // carregada — a mesma projeção do card de identidade (`patient_identity:read`; sem a célula o
  // backend manda `null` e a parte some no painel).
  const patientHeader = {
    name: [patient.firstName, patient.lastName].filter(Boolean).join(' ') || null,
    phone: patient.phoneWhatsapp,
  };

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
          <TableHead>{t('admin.patients.detail.encuadreTab.tableSex')}</TableHead>
          <TableHead>{tc('tableSchedule')}</TableHead>
          <TableHead unwrapped><span className="sr-only">{tc('tableActions')}</span></TableHead>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={7} className="py-6 text-center">
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
                  <TableCell unwrapped data-testid={`encuadre-service-sex-${service.id}`}>
                    {service.requiredSex
                      ? t(`admin.patients.detail.encuadreTab.sexOptions.${service.requiredSex}`, service.requiredSex)
                      : <Text as="span" size="sm" color="secondary">{EMPTY}</Text>}
                  </TableCell>
                  <TableCell unwrapped>
                    {scheduleText ? <Text as="span" size="sm">{scheduleText}</Text> : <Text as="span" size="sm" color="secondary">{EMPTY}</Text>}
                  </TableCell>
                  <TableCell unwrapped align="right">
                    {/* Decisão B (rodada 2): só o OLHO — abre o MESMO drawer de "Servicio Contratado",
                        sem `onEdit` (somente-leitura). Pasta/Novo ficam fora (criar/editar só na outra aba). */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setViewingService(service); }}
                      aria-label={t('admin.patients.detail.encuadreTab.viewServiceAria', { service: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode) })}
                      data-testid={`encuadre-service-view-${service.id}`}
                      className="text-primary hover:text-primary/70 transition-colors p-1 rounded focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <Eye className="w-4 h-4" strokeWidth={2} />
                    </button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {viewingService && (
        <ContractedServiceDetailDrawer
          key={viewingService.id}
          service={viewingService}
          addresses={patient.addresses ?? []}
          onClose={() => setViewingService(null)}
        />
      )}

      {/* Figma: bloco "Enquadre Terapêutico" — agrupamento "Detalles del Encuadre" (Horas
          semanales) + "Capacidad" (Cantidad de profesionales), igual ao Figma (decisão A, DIV-9).
          "Plazo de pago" e "Valor líquido/hora" ficam FORA (decisão C — financeiro decide depois;
          sem fonte no backend hoje). */}
      {currentService && (
        <div className="flex flex-wrap gap-x-10 gap-y-3" data-testid="encuadre-detalhes">
          <div className="flex flex-col gap-1">
            <Text as="span" size="sm" weight="semibold" color="primary">
              {t('admin.patients.detail.encuadreTab.detailsGroupTitle')}
            </Text>
            <Text as="span" size="sm" color="secondary">
              {t('admin.patients.detail.encuadreTab.weeklyHours')}:{' '}
              <Text as="span" size="sm" weight="medium" color="inherit">
                {currentService.weeklyHours == null ? EMPTY : currentService.weeklyHours}
              </Text>
            </Text>
          </div>
          <div className="flex flex-col gap-1">
            <Text as="span" size="sm" weight="semibold" color="primary">
              {t('admin.patients.detail.encuadreTab.capacityGroupTitle')}
            </Text>
            <Text as="span" size="sm" color="secondary">
              {t('admin.patients.detail.encuadreTab.professionalsCount')}:{' '}
              <Text as="span" size="sm" weight="medium" color="inherit">
                {currentService.providersNeeded == null ? EMPTY : currentService.providersNeeded}
              </Text>
            </Text>
          </div>
        </div>
      )}

      <ServiceTeamSection
        patientId={patient.id}
        patientHeader={patientHeader}
        service={currentService}
        address={currentAddress}
        selectionNonce={selectionNonce}
      />
    </div>
  );
}
