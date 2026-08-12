-- 242: Normaliza state/city de 12 patient_addresses retidos por partial_match no backfill
-- de geocoding (scripts/backfill-patient-addresses-location.ts). O geocoder do Google não
-- retornou match exato pra esses raws (tokens extras: "Clinica San Gabriel", "PISO 10 DEPTO E",
-- "(Escuela)" etc.), mas o próprio address_raw nomeia a localidade explicitamente — cada UPDATE
-- abaixo cita o raw como evidência. Só state/city são corrigidos; address_formatted/lat/lng
-- ficam intactos. Idempotente (UPDATE por id pra valor fixo); em bancos sem essas linhas
-- (stg/E2E) é no-op.

-- raw: "Saladillo 370, Sarandí, Provincia de Buenos Aires"
UPDATE patient_addresses SET city = 'Sarandí', updated_at = NOW()
WHERE id = '3630c28a-565a-44e7-8a0f-21f90661dac1' AND city = 'B1872 Sarandí';

-- raw: "Alsina 1395, San Fernando, PBA."
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'San Fernando', updated_at = NOW()
WHERE id = '401d36e3-9590-4506-9aed-528e8c108313' AND state = 'Buenos Aires';

-- raw: "Valentín Alsina 95, Nicolás Avellaneda 158, Adrogué, Provincia de Buenos Aires. Clinica San Gabriel"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Adrogué', updated_at = NOW()
WHERE id = '4fa9ca79-6f55-4595-a263-5b65d9726f8f' AND state = 'B1846 Adrogué';

-- raw: "Valentín Alsina 95, Nicolás Avellaneda 158, B1846AOB Adrogué, Provincia de Buenos Aires, Argentina"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Adrogué', updated_at = NOW()
WHERE id = '580c7c7f-5b38-400e-bdb8-c64c60fb5867' AND state = 'B1846 Adrogué';

-- raw: "nullMartin Buber: Charcas 4145, Armenia 2314, CABA" (Charcas 4100 / Armenia 2300 = Palermo)
UPDATE patient_addresses SET state = 'CABA', city = 'Palermo', updated_at = NOW()
WHERE id = '70b38778-9bea-4322-a907-75b4919640b0' AND state = 'Buenos Aires';

-- raw: "Bolivia 4145, Caseros"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Caseros', updated_at = NOW()
WHERE id = '72d4cac6-3f7d-47e1-8257-9940cffec580' AND state = 'Buenos Aires';

-- raw: "Soler 5961, C1425 Cdad. Autónoma de Buenos Aires." (city já era Palermo; só state)
UPDATE patient_addresses SET state = 'CABA', updated_at = NOW()
WHERE id = '85d943b8-e902-40c7-ae94-2ac49a290455' AND state = 'Buenos Aires';

-- raw: "9 DE JULIO 60 PISO 10 DEPTO E, Bernal, PBA."
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Bernal', updated_at = NOW()
WHERE id = '8ee77247-e8a3-49f2-8c22-af4d2aa9c716' AND state = 'Buenos Aires';

-- raw: "Olavarría 486, CABA (Escuela)" (city já era Barracas; só state)
UPDATE patient_addresses SET state = 'CABA', updated_at = NOW()
WHERE id = 'ae4b61c9-3a13-4595-83c0-b316494ec05f' AND state = 'Buenos Aires';

-- raw: "O´Higgins 2530, Olivos, PBA."
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Olivos', updated_at = NOW()
WHERE id = 'b13e46c0-bd6a-416b-81b9-a7264ed577ca' AND state = 'Buenos Aires';

-- raw: "Ibera 2310, piso 6 B, Belgrano, Capital Federal" (city já era Belgrano; só state)
UPDATE patient_addresses SET state = 'CABA', updated_at = NOW()
WHERE id = 'b5d34737-9218-417f-a364-81814cba5210' AND state = 'Buenos Aires';

-- raw: "Olazábal 198, Boulogne, San Isidro, PBA"
UPDATE patient_addresses SET state = 'Provincia de Buenos Aires', city = 'Boulogne', updated_at = NOW()
WHERE id = 'ca1c0321-18d8-47e2-a57b-d0b118a39993' AND state = 'Buenos Aires';
