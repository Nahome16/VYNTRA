# VYNTRA Control Web

Panel administrativo de VYNTRA construido con Next.js, React, TypeScript y Tailwind CSS.

## Desarrollo local

```powershell
copy .env.example .env.local
npm install
npm run dev
```

La API local esperada es:

```text
http://localhost:8000
```

Credenciales demo:

```text
admin@vyntra.local / Vyntra2026
```

## API simulada (sin backend)

Para trabajar en la interfaz sin levantar el backend real existe una API simulada
en memoria (`dev-mock-api.mjs`). Escucha en `http://localhost:8000` (o en el
puerto indicado en la variable `PORT`) y responde los endpoints principales del
panel con datos de demostracion:

```powershell
# terminal 1: API simulada
npm run dev:mock

# terminal 2: panel (reenvia /api/* a VYNTRA_API_URL, por defecto localhost:8000)
npm run dev
```

La API simulada es solo para desarrollo: no persiste datos ni valida permisos
como el backend real.

## Scripts

| Script              | Uso                                                  |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Servidor de desarrollo de Next.js                    |
| `npm run dev:mock`  | API simulada local (ver seccion anterior)            |
| `npm run build`     | Build de produccion (`output: standalone`)           |
| `npm run typecheck` | Verificacion de tipos con `tsc --noEmit`             |
| `npm run lint`      | ESLint                                               |

## Build de Docker

`next.config.ts` define un `rewrites()` que reenvia `/api/*` al backend. Con
`output: "standalone"` ese destino se evalua **durante `next build`** y queda
fijado en la imagen, por lo que la URL del backend debe pasarse como argumento
de build (no basta con la variable de entorno en tiempo de ejecucion):

```powershell
docker build --build-arg VYNTRA_API_URL=http://api:8000 -t vyntra-web .
```

En docker compose:

```yaml
web:
  build:
    context: ../web
    args:
      VYNTRA_API_URL: http://api:8000
```

Si no se indica, el valor por defecto del Dockerfile es `http://api:8000`
(nombre del servicio del backend en `docker-compose.prod.yml`).

## Nota de entorno

Si `npm install` falla con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, el equipo o la red
esta interceptando el trafico TLS (antivirus o proxy). Copia `.npmrc.example`
como `.npmrc` y apunta `cafile` al certificado raiz del interceptor. Ese
archivo es local de cada maquina y esta ignorado por git: nunca debe subirse
al repositorio, porque rompe la instalacion en CI/Vercel.
