# API de integración por agencia (v2) — enfermería

Todas las rutas de esta integración usan el prefijo:

`https://admin.ana.care/api/v2/agencies/`

La autenticación es siempre una **API key por agencia** en formato `ana_care.*` (ver §2). Solo se accede a los datos de la agencia asociada a esa clave.

---

## 1. Operaciones disponibles

| Área | Descripción |
|------|-------------|
| Enfermeras | Listar, crear, leer y actualizar parcialmente (`PATCH`) registros de la agencia. |
| Catálogos | Listar tipos de enfermería y tipos de contratación de la agencia (para `tipo_enfermera` / `tipo_contratacion`). |
| Actualización masiva | `PATCH` a `/agencies/nurses/bulk/` con varias enfermeras en una sola petición transaccional. |

---

## 2. API key

Ana entrega la **clave completa** una sola vez (guardarla en un gestor de secretos). Formato:

```text
ana_care.<public_id_hex_16_caracteres>.<secreto>
```

**Cabeceras admitidas** (elegir una):

```http
X-Agency-Key: ana_care.<public_id>.<secreto>
```

```http
Authorization: Api-Key ana_care.<public_id>.<secreto>
```

(Debe existir un espacio después de `Api-Key`.)

Para cuerpos JSON: `Content-Type: application/json`.

**Producción:** usar **HTTPS** únicamente.

Generar una nueva clave invalida la anterior; si hace falta rotación, coordinarlo con Ana.

---

## 3. Endpoints

Sustituir `{BASE}` por la URL base que Ana indique (ej. `https://api.ejemplo.com`).

| Método | Ruta |
|--------|------|
| `GET` | `{BASE}/api/v2/agencies/nurse-types/` |
| `GET` | `{BASE}/api/v2/agencies/hiring-types/` |
| `GET` | `{BASE}/api/v2/agencies/nurses/` |
| `POST` | `{BASE}/api/v2/agencies/nurses/` |
| `GET` | `{BASE}/api/v2/agencies/nurses/<id>/` |
| `PATCH` | `{BASE}/api/v2/agencies/nurses/<id>/` |
| `PATCH` | `{BASE}/api/v2/agencies/nurses/bulk/` |

---

## 4. Recurso enfermera (JSON)

Atributos en **español**. En respuestas, los tipos suelen devolverse como **id** numérico.

| Campo | Obligatorio (alta) | Notas |
|-------|-------------------|--------|
| `nombre` | Sí | |
| `apellidos` | Sí | |
| `genero` | Sí | `"M"` o `"H"` |
| `email` | Sí | Único en el sistema para enfermeras |
| `telefono` | No | Si se envía, debe ser único |
| `calle`, `estado`, `ciudad`, `colonia`, `codigo_postal` | No | |
| `fecha_nacimiento` | No | `YYYY-MM-DD` |
| `cedula_ciudadania` | No | Identificador (ej. CURP) |
| `tipo_enfermera` | No | Ver §4.1 |
| `tipo_contratacion` | No | Ver §4.1 |

### 4.1 `tipo_enfermera` y `tipo_contratacion`

Valores de **esa agencia** únicamente. Se puede enviar:

- **Id numérico** (entero o string solo con dígitos, ej. `12` o `"12"`), o  
- **Nombre exacto** igual al campo `name` del catálogo correspondiente (mayúsculas, acentos y espacios laterales tras `trim`).

Conviene obtener `id` o `name` con los `GET` de `nurse-types` y `hiring-types` antes de altas o cambios.

Si hubiera más de un catálogo con el mismo nombre en la agencia, la API rechazará el nombre y habrá que usar el **id** numérico.

### 4.2 Alta mínima

```json
{
  "nombre": "María",
  "apellidos": "Pérez",
  "genero": "M",
  "email": "maria.unica@ejemplo.com"
}
```

### 4.3 Actualización masiva (`PATCH …/nurses/bulk/`)

```json
{
  "items": [
    { "id": 101, "telefono": "5511111111" },
    { "id": 102, "email": "nueva@ejemplo.com", "colonia": "Roma Norte" }
  ]
}
```

Cada elemento debe incluir **`id`**. Todos los `id` deben ser enfermeras de la misma agencia que la API key. La operación es **atómica** (fallo total si algo no valida). Los mismos campos que en el alta (incl. tipos por id o nombre) pueden ir dentro de cada ítem.

El límite máximo de ítems por petición lo confirma Ana si se requiere un valor exacto.

---

## 5. Listados paginados

Las listas (`GET` de nurses y catálogos) devuelven objeto con `count`, `next`, `previous` y `results`. La paginación suele usar `?page=` y, si está habilitado en el despliegue, `?page_size=`.

---

## 6. Códigos HTTP frecuentes

| Código | Situación típica |
|--------|------------------|
| `200` / `201` | Éxito según operación |
| `400` | Validación (campos, duplicados de email/teléfono, tipo inexistente o ambiguo, etc.) |
| `401` | API key ausente, incorrecta o agencia inactiva |
| `403` | Sin autenticación de integración válida |
| `404` | Enfermera inexistente o no perteneciente a la agencia; en bulk, `id` no válido |

Los errores de validación suelen detallarse por campo en JSON.

---

## 7. Ejemplos

### cURL — catálogo

```bash
API_KEY='ana_care.<public_id>.<secreto>'
curl -sS "https://<host>/api/v2/agencies/nurse-types/" \
  -H "X-Agency-Key: ${API_KEY}"
```

### cURL — alta

```bash
curl -sS -X POST "https://<host>/api/v2/agencies/nurses/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Key ${API_KEY}" \
  --data-binary '{
    "nombre": "María",
    "apellidos": "Pérez Ejemplo",
    "genero": "M",
    "email": "maria.ejemplo+2026@ejemplo.com",
    "telefono": "5512345678",
    "tipo_enfermera": "Gericultista",
    "tipo_contratacion": "Independiente"
  }'
```

Ajustar `tipo_*` a los valores reales devueltos por los catálogos de la agencia.

### Postman

Método y URL según la tabla del §3.  
**Headers:** `X-Agency-Key` con la clave completa, o `Authorization: Api-Key <clave>`.  
**Body:** raw, JSON.

---

## 8. Seguridad

- No commitear la API key ni enviarla por canales inseguros.  
- Preferir almacén de secretos en producción.  
- Tras una posible filtración, solicitar rotación de clave a Ana.  
- Monitorizar `401` y errores de validación para detectar claves revocadas o datos inconsistentes.
