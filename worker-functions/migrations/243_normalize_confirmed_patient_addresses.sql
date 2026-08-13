-- 243: Normaliza state/city de patient_addresses CONFIRMADOS por operação
-- Fonte: planilha "domicilios-pacientes-revisar-2026-07-05" — filas com checkbox Confirmado=✓.
-- Continuação da 242 (retidos por partial_match no backfill de geocoding). Ops revisou a
-- sugestão do Google e confirmou; aqui só state/city são corrigidos (address_raw/formatted/
-- lat/lng ficam intactos). Cada UPDATE mira o id da versão ATIVA (archived_at IS NULL), com
-- guarda no valor atual pra ser idempotente. Em bancos sem essas linhas (stg/E2E) é no-op.
--
-- NÃO incluídos (já corretos no banco — no-op verificado 2026-07-10):
--   caso 336 (id 30bc6a1d) Alvar Nuñez 1477 → já PBA/Moreno
--   caso 777 (id e4871f4c) "Mi Camino" Lincoln 74 → já PBA/Wilde
--   caso 473 (id bf2f19f7) Calle 14 1631 → já PBA/La Plata

-- ── Secundarios retidos (state/city eram NULL) ──────────────────────────────

-- caso 760 — raw: "Av Chiclana 3319, Parque Patricios, Buenos Aires, Provincia de Buenos Aires" (es CABA)
UPDATE patient_addresses SET state = 'CABA', city = 'Parque Patricios', updated_at = NOW()
WHERE id = 'cc754069-16c1-40be-81d1-e5eaab4d0e23' AND state IS NULL AND city IS NULL;

-- caso 230 — raw: "Clinica San Jose, Sanchez de Bustamante 1764, Palermo"
UPDATE patient_addresses SET state = 'CABA', city = 'Palermo', updated_at = NOW()
WHERE id = '3ebb48ad-5f7f-4373-b415-41b0b4fbe937' AND state IS NULL AND city IS NULL;

-- caso 230 — raw: "Barrio San Ramón, Pilar del este" (Google: "B1631 Zelaya" — se usa la localidad de Google)
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Zelaya', updated_at = NOW()
WHERE id = 'a598e78d-1c6f-4a30-9526-76d2e219c644' AND state IS NULL AND city IS NULL;

-- caso 349 — raw: "Rodríguez Peña 58, Bernal (Hogar)"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Bernal', updated_at = NOW()
WHERE id = '43c35c49-5f73-434b-b429-4f8bb61ec415' AND state IS NULL AND city IS NULL;

-- caso 357 — raw: "Miró 1575, Parque Chacabuco, CABA (CET)"
UPDATE patient_addresses SET state = 'CABA', city = 'Parque Chacabuco', updated_at = NOW()
WHERE id = 'ce19df7c-7917-42c5-a5ab-a20721456f92' AND state IS NULL AND city IS NULL;

-- caso 402 — raw: "Avenida Libertador 16592 San Isidro (Domicilio)"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'San Isidro', updated_at = NOW()
WHERE id = 'c36d3687-e83b-4456-a4c6-187abaad902f' AND state IS NULL AND city IS NULL;

-- caso 409 — raw: "Paisandu 1655, Caballito (Hosp de Dia)"
UPDATE patient_addresses SET state = 'CABA', city = 'Caballito', updated_at = NOW()
WHERE id = 'b004de5a-a62a-4808-be63-827476d9bd8c' AND state IS NULL AND city IS NULL;

-- caso 425 — raw: "El Zorzal 55, Playa Dorada (Domicilio 2)" (Google: "El Zorzal, Playa Dorada" — localidad de Google)
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Playa Dorada', updated_at = NOW()
WHERE id = 'a434f8dc-fce1-4bac-8740-fba18fcac174' AND state IS NULL AND city IS NULL;

-- caso 425 — raw: "Colegio Secundario Nº 2 (Escuela)" (Google: Hipólito Yrigoyen 1346, B7600 Mar del Plata)
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Mar del Plata', updated_at = NOW()
WHERE id = 'af90b061-0eca-4c81-bef5-ecb302f15cda' AND state IS NULL AND city IS NULL;

-- caso 442 — raw: "HDD Carpem Diem: Venancio Flores 548 - Lomas del Mirador"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Lomas del Mirador', updated_at = NOW()
WHERE id = 'af73d363-1e52-4bb4-96a4-0dc12485ec88' AND state IS NULL AND city IS NULL;

-- caso 443 — raw: "Colegio del Prado. 2499, Av. Fernández Beschtedt 2399" (Luján; el primary homónimo ya está OK)
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Luján', updated_at = NOW()
WHERE id = 'c1c591b1-ef38-4c1e-b628-e26e587249c2' AND state IS NULL AND city IS NULL;

-- caso 449 — raw: "Escuela N°15 D.E. 3 - México 2383" (México 2383 = Balvanera)
UPDATE patient_addresses SET state = 'CABA', city = 'Balvanera', updated_at = NOW()
WHERE id = '71dcd1e7-415f-4811-98d2-bc5e8eb59225' AND state IS NULL AND city IS NULL;

-- caso 460 — raw: "San Martín 1028, Avellaneda (Internación)"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Avellaneda', updated_at = NOW()
WHERE id = 'ba4aa1db-84da-407e-bdd2-ca265aa62671' AND state IS NULL AND city IS NULL;

-- caso 474 — raw: "Sentir lll - Localidad de Lozano (CET)" (Lozano, Jujuy)
UPDATE patient_addresses SET state = 'Jujuy', city = 'Lozano', updated_at = NOW()
WHERE id = 'ab555cac-19c0-408d-800e-c81c04d11122' AND state IS NULL AND city IS NULL;

-- caso 456 — raw: "Defensoría (a 3 cuadras Plaza de Mayo) (Trabajo)"
-- La sugerencia de Google ("Santos Dumont 2700", Chacarita) se DESCARTA: es el domicilio PRIMARY
-- de este mismo paciente, no el secundario (el geocoder no resolvió "Defensoría" y cayó en la otra
-- dirección del paciente). "a 3 cuadras de Plaza de Mayo" = Monserrat (CABA).
UPDATE patient_addresses SET state = 'CABA', city = 'Monserrat', updated_at = NOW()
WHERE id = '07f9fa56-2468-45c1-b0e8-8bfa9187b45b' AND state IS NULL AND city IS NULL;

-- ── Fix de la versión ACTIVA que la 242 no tocó ─────────────────────────────

-- caso 409 — raw: "Ibera 2310, piso 6 B, Belgrano, Capital Federal"
-- La 242 corrigió la versión ARCHIVADA (id b5d34737). La versión ACTIVA (id 409c34d5) seguía
-- con state='Buenos Aires'. Belgrano es CABA. city ya era 'Belgrano'.
UPDATE patient_addresses SET state = 'CABA', updated_at = NOW()
WHERE id = '409c34d5-67e6-4b01-aae1-13eb4d15ac46' AND state = 'Buenos Aires';

-- caso 348 — raw: "Soler 5961, C1425 Cdad. Autónoma de Buenos Aires." (Palermo/CABA)
-- La 242 corrigió la versión ARCHIVADA (id 85d943b8). Activa (id 8dd26e39) seguía 'Buenos Aires'. city ya era 'Palermo'.
UPDATE patient_addresses SET state = 'CABA', updated_at = NOW()
WHERE id = '8dd26e39-dcbe-487f-aa92-4a694fd5b6c6' AND state = 'Buenos Aires';

-- caso 479 — raw: "nullMartin Buber: Charcas 4145, Armenia 2314, CABA" (Charcas/Armenia = Palermo)
-- La 242 corrigió la versión ARCHIVADA (id 70b38778). Activa (id 4fd1a18a) seguía state/city='Buenos Aires'.
UPDATE patient_addresses SET state = 'CABA', city = 'Palermo', updated_at = NOW()
WHERE id = '4fd1a18a-d367-421b-a511-1b0c57ca4039' AND state = 'Buenos Aires';

-- ── Auditoría 242: versiones ACTIVAS que la 242 no tocó (mismo defecto del 409/348/479) ──
-- La 242 corrigió filas archivadas (re-versionadas en masa el 2026-05-27, mig 198) y dejó la
-- versión activa hermana con el valor viejo. Cada UPDATE mira el id ACTIVO (archived_at IS NULL)
-- verificado en prod 2026-07-10. NO incluidos (activa ya correcta): Bolivia 4145/Caseros y
-- Olazábal 198/Boulogne.

-- 242-audit — raw: "Saladillo 370, Sarandí, Provincia de Buenos Aires" (city tenía prefijo CP)
UPDATE patient_addresses SET city = 'Sarandí', updated_at = NOW()
WHERE id = '9bebb0c0-763d-4035-85ff-705492faa251' AND city = 'B1872 Sarandí';

-- 242-audit — raw: "Alsina 1395, San Fernando, PBA."
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'San Fernando', updated_at = NOW()
WHERE id = '02d578a9-0e85-4fec-8a08-6b7fcd0ef325' AND state = 'Buenos Aires';

-- 242-audit — raw: "Valentín Alsina 95, Nicolás Avellaneda 158, Adrogué ... Clinica San Gabriel"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Adrogué', updated_at = NOW()
WHERE id = '9018eaf5-2de7-4802-a7e6-99cc9391d3ff' AND state = 'B1846 Adrogué';

-- 242-audit — raw: "Valentín Alsina 95, Nicolás Avellaneda 158, B1846AOB Adrogué, Provincia de Buenos Aires, Argentina"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Adrogué', updated_at = NOW()
WHERE id = 'a1ed1d25-714d-41c4-bb4f-a0f87b8e1780' AND state = 'B1846 Adrogué';

-- 242-audit — raw: "9 DE JULIO 60 PISO 10 DEPTO E, Bernal, PBA."
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Bernal', updated_at = NOW()
WHERE id = '34036d6c-9658-43f8-a9ca-e9337515340a' AND state = 'Buenos Aires';

-- 242-audit — raw: "O´Higgins 2530, Olivos, PBA." (activa tenía state/city cruzados: BA / "Provincia de Buenos Aires")
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Olivos', updated_at = NOW()
WHERE id = '283aa4e4-1ecc-4b3f-9cf6-8be333607e09' AND state = 'Buenos Aires';

-- 242-audit — raw: "Olavarría 486, CABA (Escuela)" ⚠️ REVISAR: la activa geocodeó MAL a "Lanús Oeste / PBA".
-- El raw dice CABA explícitamente y la 242 la ubicó en Barracas/CABA. Se corrige a CABA/Barracas.
UPDATE patient_addresses SET state = 'CABA', city = 'Barracas', updated_at = NOW()
WHERE id = '11b2e0de-b92c-4445-b9a8-54097ee9aee6' AND state = 'Provincia de Buenos Aires' AND city = 'Lanús Oeste';
