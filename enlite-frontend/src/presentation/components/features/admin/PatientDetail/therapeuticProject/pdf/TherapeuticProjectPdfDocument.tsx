/**
 * TherapeuticProjectPdfDocument — o "Proyecto Terapéutico – EnLite Care" em `@react-pdf/renderer`
 * (spec 017 F3; D299.4: gerado NO NAVEGADOR, nenhum serviço externo; lex C11–C15).
 *
 * Formato do documento de referência: logo no topo de cada página, título, seções I a X com
 * bullets; VIII e IX fixas. Rodapé em toda página (C14): nº do caso, versão, emissão, aviso de
 * confidencialidade e "pode ser corrigido e substituído". O nome de quem EXPORTOU não vai (C14).
 * Seção cujo container foi redigido sai OMITIDA COM RÓTULO (C12) — nunca em branco.
 */
import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';
import {
  PDF_TITLE, PDF_SECTIONS, PDF_LABELS, PDF_FOOTER,
  CAREGIVER_LIMITS, CAREGIVER_LIMITS_INTRO, CAREGIVER_MUST_NOT_TITLE, CAREGIVER_MUST_NOT,
  NOT_DOMESTIC_TITLE, NOT_DOMESTIC, NOT_DOMESTIC_OUTRO, FUNDAMENTAL_RULE, FIXED_SECTIONS_SERVICE_CODE,
} from './pdfFixedTexts';
import { formatIsoDateEsAr, implementationPeriodText, type TherapeuticProjectPdfInput } from './therapeuticProjectPdfInput';

const PRIMARY = '#180149';
const GRAY = '#737373';

const styles = StyleSheet.create({
  page: { paddingTop: 96, paddingBottom: 84, paddingHorizontal: 56, fontFamily: 'Lexend', fontSize: 10, color: '#1f1f1f', lineHeight: 1.45 },
  header: { position: 'absolute', top: 28, left: 0, right: 0, alignItems: 'center' },
  logo: { width: 120, height: 40, objectFit: 'contain' },
  logoText: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 16, color: PRIMARY },
  title: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 15, color: '#111', textAlign: 'center', marginBottom: 18 },
  section: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 10.5, color: '#111', backgroundColor: '#f3e8f5', paddingHorizontal: 3, alignSelf: 'flex-start', marginTop: 12, marginBottom: 6 },
  subsection: { fontFamily: 'Lexend', fontWeight: 500, fontSize: 10, color: GRAY, marginTop: 6, marginBottom: 3 },
  row: { flexDirection: 'row', marginBottom: 2 },
  bullet: { width: 12 },
  label: { fontWeight: 500 },
  paragraph: { marginBottom: 6, textAlign: 'justify' },
  // Sem itálico: só Regular/Medium estão registradas (lex C11 — nenhuma fonte extra é buscada).
  redacted: { color: GRAY, marginBottom: 6 },
  annulled: { fontFamily: 'Poppins', fontWeight: 600, color: '#b00020', textAlign: 'center', marginBottom: 8 },
  footer: { position: 'absolute', bottom: 26, left: 56, right: 56, fontSize: 7, color: GRAY, borderTopWidth: 0.5, borderTopColor: '#d9d9d9', paddingTop: 4 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
});

function Bullet({ children }: { children: string }): JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.bullet}>•</Text>
      <Text style={{ flex: 1 }}>{children}</Text>
    </View>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }): JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.bullet}>•</Text>
      <Text style={{ flex: 1 }}>
        <Text style={styles.label}>{label}: </Text>
        {value && value.length > 0 ? value : PDF_LABELS.notInformed}
      </Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }): JSX.Element {
  return <Text style={styles.section}>{children}</Text>;
}

function Redacted(): JSX.Element {
  return <Text style={styles.redacted}>{PDF_LABELS.sectionRedacted}</Text>;
}

/**
 * Seção fixa VIII/IX: só o serviço de cuidadores a carrega; nos demais, rótulo (uma regra, dois lugares).
 * `null` = o emissor não lê o tipo do serviço (lex A1 C3): rótulo NEUTRO de permissão — "no aplicable"
 * afirmaria que o serviço não é de cuidador, e isso é inferência sobre dado que ele não pode ver.
 */
function FixedSection({ serviceCode, children }: { serviceCode: string | null; children: JSX.Element }): JSX.Element {
  if (serviceCode === null) return <Redacted />;
  if (serviceCode !== FIXED_SECTIONS_SERVICE_CODE) return <Text style={styles.redacted}>{PDF_LABELS.sectionNotForService}</Text>;
  return children;
}

function Header({ logoSrc }: { logoSrc?: string }): JSX.Element {
  return (
    <View style={styles.header} fixed>
      {logoSrc ? <Image src={logoSrc} style={styles.logo} /> : <Text style={styles.logoText}>enlite</Text>}
    </View>
  );
}

function Footer({ caseRef, version, issuedAtText }: { caseRef: string; version: string; issuedAtText: string }): JSX.Element {
  return (
    <View style={styles.footer} fixed>
      <View style={styles.footerRow}>
        <Text>{`${PDF_LABELS.caseNumber}: ${caseRef} · ${PDF_LABELS.version} ${version} · ${PDF_LABELS.issuedAt}: ${issuedAtText}`}</Text>
        <Text render={({ pageNumber, totalPages }) => `${pageNumber}/${totalPages}`} />
      </View>
      <Text>{PDF_FOOTER.confidentiality}</Text>
      <Text>{PDF_FOOTER.mutable}</Text>
    </View>
  );
}

export function TherapeuticProjectPdfDocument({ input }: { input: TherapeuticProjectPdfInput }): JSX.Element {
  const { version: v } = input;
  const chrome = { caseRef: input.caseRef, version: v.version, issuedAtText: input.issuedAtText };
  const clinicalRedacted = v.redacted?.clinical === true;

  return (
    <Document title={`${PDF_TITLE} · ${v.version}`} language="es-AR">
      <Page size="A4" style={styles.page}>
        <Header logoSrc={input.logoSrc} />
        <Footer {...chrome} />
        <Text style={styles.title}>{PDF_TITLE}</Text>
        {v.annulledAt !== null && <Text style={styles.annulled}>{PDF_LABELS.annulled}</Text>}

        {/* I — identidade, cobertura, serviço, endereço e contatos: cada um sob a célula do seu container (C12). */}
        <SectionTitle>{PDF_SECTIONS.identification}</SectionTitle>
        {input.identification ? (
          <>
            <Field label={PDF_LABELS.patient} value={input.identification.fullName} />
            <Field label={PDF_LABELS.document} value={input.identification.documentLabel} />
            <Field
              label={PDF_LABELS.birthDate}
              value={input.identification.birthDate
                ? `${formatIsoDateEsAr(input.identification.birthDate)}${input.identification.age !== null ? `; ${PDF_LABELS.age}: ${input.identification.age} ${PDF_LABELS.years}` : ''}`
                : null}
            />
          </>
        ) : <Redacted />}
        {input.coverage ? (
          <Field
            label={PDF_LABELS.coverage}
            value={input.coverage.insurance ? `${input.coverage.insurance}${input.coverage.affiliateId ? `; ${PDF_LABELS.affiliateId}: ${input.coverage.affiliateId}` : ''}` : null}
          />
        ) : <Redacted />}
        {input.service ? (
          <>
            <Field
              label={PDF_LABELS.requestedService}
              value={`${input.service.serviceLabel}${input.service.deviceLabels.length > 0 ? `; ${PDF_LABELS.deviceType}: ${input.service.deviceLabels.join(', ')}` : ''}`}
            />
            <Field label={PDF_LABELS.providerProfile} value={input.service.providerProfile} />
            <Field
              label={PDF_LABELS.authorizedSchedule}
              value={[input.service.scheduleText, input.service.careLocationLabel].filter(Boolean).join('; ') || null}
            />
          </>
        ) : <Redacted />}
        {/* D301.3a — modalidade é da VERSÃO, não do cadastro: não depende de célula de container. */}
        <Field label={PDF_LABELS.modality} value={input.modalityLabel} />
        {input.addressText !== null ? <Field label={PDF_LABELS.address} value={input.addressText} /> : <Redacted />}
        {/* D301.3b (Ana): DOIS campos de emergência, cada um sob a célula do SEU container (lex C5). */}
        <Text style={styles.subsection}>{PDF_LABELS.emergencyContact}</Text>
        {input.emergencyContacts ? (
          <Field
            label={PDF_LABELS.familyEmergencyContact}
            value={input.emergencyContacts.length === 0 ? null : input.emergencyContacts
              .map((c) => [c.name + (c.relationship ? ` (${c.relationship})` : ''), c.phone, c.email].filter(Boolean).join(' - '))
              .join('. ')}
          />
        ) : <Redacted />}
        {input.coverageEmergencyContacts ? (
          <>
            <Field
              label={PDF_LABELS.coverageEmergencyContact}
              value={input.coverageEmergencyContactsUnavailable
                ? PDF_LABELS.fieldUnavailable
                : input.coverageEmergencyContacts.length === 0 ? null : input.coverageEmergencyContacts
                  .map((c) => `${c.kindLabel}: ${c.name} - ${c.phone}`)
                  .join('. ')}
            />
            {/* lex C3: a lista não é completa para este emissor — o documento diz, em vez de fingir. */}
            {input.coverageDirectProfessionalRedacted && <Text style={styles.redacted}>{PDF_LABELS.directProfessionalWithheld}</Text>}
          </>
        ) : <Redacted />}

        {/* II — só CID-11 (Gabriel Q5); sob patient_clinical:read (C7). */}
        <SectionTitle>{PDF_SECTIONS.diagnosis}</SectionTitle>
        {clinicalRedacted || v.diagnoses === null ? <Redacted /> : v.diagnoses.map((d) => <Bullet key={d.uri}>{d.title}</Bullet>)}
        {/* Derivado dos CID-11 (capítulo; D163/D164) — dado clínico como eles: redigido junto. */}
        {clinicalRedacted || v.pathologyTypes === null
          ? <Redacted />
          : <Field label={PDF_LABELS.pathologyType} value={v.pathologyTypes.map((p) => p.label).join(', ')} />}

        <SectionTitle>{PDF_SECTIONS.careTeam}</SectionTitle>
        {input.careTeam ? (input.careTeam.length === 0 ? <Text style={styles.paragraph}>{PDF_LABELS.notInformed}</Text> : input.careTeam.map((n, i) => <Bullet key={i}>{n}</Bullet>)) : <Redacted />}

        <SectionTitle>{PDF_SECTIONS.clinicalContext}</SectionTitle>
        {clinicalRedacted || v.clinicalContext === null ? <Redacted /> : <Text style={styles.paragraph}>{v.clinicalContext}</Text>}

        <SectionTitle>{PDF_SECTIONS.generalObjective}</SectionTitle>
        {clinicalRedacted || v.generalObjective === null ? <Redacted /> : <Text style={styles.paragraph}>{v.generalObjective}</Text>}

        <SectionTitle>{PDF_SECTIONS.specificObjectives}</SectionTitle>
        {v.specificObjectives.map((o) => <Bullet key={o.id}>{o.label}</Bullet>)}

        <SectionTitle>{PDF_SECTIONS.activities}</SectionTitle>
        {v.activities.map((a) => <Bullet key={a.id}>{a.label}</Bullet>)}

        {/* VIII e IX — texto fixo (constante, sem dado pessoal) do serviço de CUIDADORES (Ana, 08/09 — D301.1).
            Decide pelo `service_code` CONGELADO na versão (417): não depende de célula nem do serviço vivo. */}
        <SectionTitle>{PDF_SECTIONS.caregiverLimits}</SectionTitle>
        <FixedSection serviceCode={input.fixedSectionsServiceCode}>
          <>
            {CAREGIVER_LIMITS.map((g) => (
              <View key={g.title}>
                <Text style={styles.subsection}>{g.title}</Text>
                {g.items.map((it) => <Bullet key={it}>{it}</Bullet>)}
              </View>
            ))}
            <Text style={[styles.paragraph, { marginTop: 6 }]}>{CAREGIVER_LIMITS_INTRO}</Text>
            <Text style={styles.subsection}>{CAREGIVER_MUST_NOT_TITLE}</Text>
            {CAREGIVER_MUST_NOT.map((it) => <Bullet key={it}>{it}</Bullet>)}
            <Text style={styles.subsection}>{NOT_DOMESTIC_TITLE}</Text>
            {NOT_DOMESTIC.map((it) => <Bullet key={it}>{it}</Bullet>)}
            <Text style={[styles.paragraph, { marginTop: 4 }]}>{NOT_DOMESTIC_OUTRO}</Text>
          </>
        </FixedSection>

        <SectionTitle>{PDF_SECTIONS.fundamentalRule}</SectionTitle>
        <FixedSection serviceCode={input.fixedSectionsServiceCode}>
          <>
            {FUNDAMENTAL_RULE.map((g) => (
              <View key={g.title}>
                <Text style={styles.subsection}>{g.title}</Text>
                {g.items.map((it) => <Bullet key={it}>{it}</Bullet>)}
              </View>
            ))}
          </>
        </FixedSection>

        <SectionTitle>{PDF_SECTIONS.projectData}</SectionTitle>
        <Text><Text style={styles.label}>{PDF_LABELS.elaboratedBy}: </Text>{v.createdByName ?? PDF_LABELS.notInformed}</Text>
        <Text><Text style={styles.label}>{PDF_LABELS.implementationPeriod}: </Text>{implementationPeriodText(v.startDate, v.endDate)}</Text>
        <Text><Text style={styles.label}>{PDF_LABELS.issueDate}: </Text>{formatIsoDateEsAr(v.createdAt)}</Text>
      </Page>
    </Document>
  );
}
