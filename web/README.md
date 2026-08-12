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

## Nota de entorno

Si `npm install` falla con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, el equipo o la red
esta interceptando/verificando certificados. Resolver el certificado raiz local
antes de instalar dependencias; no se recomienda desactivar `strict-ssl` para
produccion.
