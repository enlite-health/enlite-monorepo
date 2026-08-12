import { useTranslation } from 'react-i18next';
import {
  ShieldCheck,
  Hammer,
  HeartPulse,
  Briefcase,
  PauseCircle,
  LayoutGrid,
  MapPin,
  Clock,
  Gauge,
  Inbox,
  CalendarCheck,
  ClipboardList,
  Search,
} from 'lucide-react';
import { MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';
import { useMetricHelp } from './useMetricHelp';

/**
 * Números clave no desenho acordado na call de 22/07 e refinado pelo Diego (30/07):
 *
 *  1. PERCENTUAIS numa linha própria, separados dos absolutos (Marcel 02:01, Diego
 *     "essas porcentagens sim sim") — cada um com numerador/denominador visíveis.
 *  2. RODANDO — a operação em andamento: pacientes ativos · ubicaciones · horas ativas.
 *  3. CHEGANDO — o funil de entrada de pacientes, estados ATUAIS e exclusivos:
 *     Solicitações → Entrevista Agendada → Em Admissão → Em Busca.
 *  4. Vagas e equipes (cards que já existiam, inalterados).
 *
 * NUNCA somar entre linhas: `enBusca` sobrepõe `activos` de propósito (o paciente
 * 24/7 com turno descoberto está nos dois — era a origem do "193" falso da call).
 */
export function BigNumbersSection({
  data,
  pacientes,
  horas,
  pctRespostaRapida,
  pctCapacidade,
}: {
  data: ManagementDashboardData['bigNumbers'];
  pacientes: ManagementDashboardData['pacientes'];
  horas: ManagementDashboardData['horas'];
  pctRespostaRapida: ManagementDashboardData['equipoArmada']['pctRespostaRapidaArmado'];
  pctCapacidade: ManagementDashboardData['encuadres']['pctCapacidadeSemana'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.bigNumbers.';
  const { helpProps, helpDrawer } = useMetricHelp();

  return (
    <section data-testid="mgmt-big-numbers" className="space-y-4">
      <SectionHeader
        icon={LayoutGrid}
        accent="primary"
        title={t('admin.managementDashboard.sections.bigNumbers')}
        hint={t('admin.managementDashboard.sections.bigNumbersHint')}
      />

      {/* 1 — Percentuais (linha própria, sem misturar com absolutos) */}
      <div data-testid="mgmt-percentuais" className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <MetricCard
          icon={Gauge}
          accent="success"
          title={t(`${p}pctRespostaRapida`)}
          {...helpProps('pctRespostaRapida')}
          value={pctRespostaRapida.pct != null ? `${pctRespostaRapida.pct}%` : '—'}
          subtitle={
            pctRespostaRapida.pct != null
              ? t(`${p}pctRespostaRapidaSub`, {
                  num: pctRespostaRapida.num,
                  den: pctRespostaRapida.den,
                  excluidos: pctRespostaRapida.excluidos,
                })
              : t(`${p}pctRespostaRapidaSinDen`)
          }
        />
        {pctCapacidade && (
          <MetricCard
            icon={Gauge}
            accent="clinic"
            title={t(`${p}pctCapacidadEncuadres`)}
          {...helpProps('pctCapacidadEncuadres')}
            value={`${pctCapacidade.pct}%`}
            subtitle={t(`${p}pctCapacidadEncuadresSub`, {
              agendados: pctCapacidade.agendados,
              capacidade: pctCapacidade.capacidade,
            })}
          />
        )}
      </div>

      {/* 2 — RODANDO */}
      <div data-testid="mgmt-rodando" className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <MetricCard icon={HeartPulse} accent="care" title={t(`${p}pacientesActivos`)}
          {...helpProps('pacientesActivos')} value={data.pacientesActivos} subtitle={t(`${p}pacientesActivosSub`)} />
        <MetricCard
          icon={MapPin}
          accent="primary"
          title={t(`${p}ubicacionesActivas`)}
          {...helpProps('ubicacionesActivas')}
          value={pacientes.ubicacionesActivas}
          subtitle={t(`${p}ubicacionesActivasSub`)}
        />
        <MetricCard
          icon={Clock}
          accent="success"
          title={t(`${p}horasActivas`)}
          {...helpProps('horasActivas')}
          value={horas.ativas}
          subtitle={t(`${p}horasActivasSub`, { sinSchedule: horas.ativasSinSchedule })}
        />
      </div>

      {/* 3 — CHEGANDO (estados exclusivos; Em Busca sobrepõe Activos, nunca somar) */}
      <div data-testid="mgmt-chegando" className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={Inbox} accent="neutral" title={t(`${p}solicitudes`)}
          {...helpProps('solicitudes')} value={pacientes.solicitudes} subtitle={t(`${p}solicitudesSub`)} />
        <MetricCard icon={CalendarCheck} accent="learn" title={t(`${p}entrevistaAgendada`)}
          {...helpProps('entrevistaAgendada')} value={pacientes.entrevistaAgendada} subtitle={t(`${p}entrevistaAgendadaSub`)} />
        <MetricCard icon={ClipboardList} accent="clinic" title={t(`${p}enAdmision`)}
          {...helpProps('enAdmision')} value={pacientes.enAdmision} subtitle={t(`${p}enAdmisionSub`)} />
        <MetricCard
          icon={Search}
          accent="care"
          title={t(`${p}enBusca`)}
          {...helpProps('enBusca')}
          value={pacientes.enBusca}
          subtitle={t(`${p}enBuscaSub`, { horas: horas.totais })}
        />
      </div>

      {/* 4 — Vagas e equipes (cards pré-existentes) */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={ShieldCheck} accent="success" title={t(`${p}equiposArmados`)}
          {...helpProps('equiposArmados')} value={data.equiposArmados} subtitle={t(`${p}equiposArmadosSub`)} />
        <MetricCard icon={Hammer} accent="learn" title={t(`${p}equiposPorArmar`)}
          {...helpProps('equiposPorArmar')} value={data.equiposPorArmar} subtitle={t(`${p}equiposPorArmarSub`)} />
        <MetricCard icon={Briefcase} accent="clinic" title={t(`${p}vacantesAbiertas`)}
          {...helpProps('vacantesAbiertas')} value={data.vacantesAbiertas} subtitle={t(`${p}vacantesAbiertasSub`)} />
        <MetricCard icon={PauseCircle} accent="neutral" title={t(`${p}vacantesPausadas`)}
          {...helpProps('vacantesPausadas')} value={data.vacantesPausadas} subtitle={t(`${p}vacantesPausadasSub`)} />
      </div>

      {helpDrawer}
    </section>
  );
}
