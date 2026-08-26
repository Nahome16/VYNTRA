import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Politica de privacidad | VYNTRA",
  description: "Politica de privacidad de VYNTRA Agent y VYNTRA Control.",
};

const sections = [
  {
    title: "1. Alcance",
    body: [
      "Esta politica describe como VYNTRA trata informacion relacionada con el uso de VYNTRA Agent, VYNTRA Control y servicios asociados de productividad laboral.",
      "VYNTRA esta disenado para entornos de trabajo donde una empresa informa a sus colaboradores sobre el monitoreo y obtiene el consentimiento o base legal aplicable antes de activar el agente.",
    ],
  },
  {
    title: "2. Informacion que se procesa",
    body: [
      "VYNTRA puede procesar datos de identificacion laboral como nombre, correo corporativo, codigo de empleado, departamento, puesto, empresa asociada y dispositivo asignado.",
      "El agente puede registrar eventos de jornada, pausas, almuerzo, actividad, inactividad, aplicaciones utilizadas, titulos de ventana, clasificacion de productividad, incidencias y evidencias operativas como capturas de pantalla cuando la empresa lo haya configurado.",
      "VYNTRA no esta destinado a recopilar contrasenas personales, datos bancarios, informacion medica, contenido privado ajeno al contexto laboral o informacion de menores.",
    ],
  },
  {
    title: "3. Finalidades",
    body: [
      "Los datos se usan para administrar asistencia, productividad, cumplimiento de politicas internas, soporte operativo, auditoria, reporteria y seguridad de los dispositivos laborales monitoreados.",
      "Las empresas clientes son responsables de configurar reglas, horarios, permisos, periodos de retencion y avisos internos de acuerdo con sus politicas y leyes aplicables.",
    ],
  },
  {
    title: "4. Consentimiento y transparencia",
    body: [
      "Antes de iniciar el monitoreo, el agente muestra un aviso de consentimiento o conocimiento del monitoreo. Si el usuario rechaza el aviso, el agente no activa las capturas ni el registro operativo en ese equipo.",
      "El empleador debe informar de forma clara que herramientas, horarios, datos y finalidades aplican en su organizacion.",
    ],
  },
  {
    title: "5. Almacenamiento, seguridad y acceso",
    body: [
      "Los datos se transmiten al backend configurado por la empresa mediante conexiones protegidas. El acceso al panel se limita por rol, empresa y permisos.",
      "VYNTRA aplica controles de autenticacion, sesiones, registros de auditoria y separacion por empresa para reducir accesos no autorizados.",
      "Los archivos locales necesarios para operar el agente, como configuracion, cola de envio y consentimiento, se mantienen en el equipo asignado y se conservan solo para la operacion del servicio.",
    ],
  },
  {
    title: "6. Retencion y eliminacion",
    body: [
      "La retencion depende de la configuracion y obligaciones de cada empresa cliente. Los administradores autorizados pueden gestionar empleados, dispositivos, reglas y evidencias desde el panel.",
      "Cuando una empresa solicite baja, eliminacion o exportacion, VYNTRA procesara la solicitud segun el contrato aplicable y los requisitos legales vigentes.",
    ],
  },
  {
    title: "7. Terceros",
    body: [
      "VYNTRA puede usar proveedores de infraestructura, correo, almacenamiento, analitica tecnica o seguridad para operar el servicio. Estos proveedores solo deben tratar datos conforme a las instrucciones y necesidades del servicio.",
      "Si una empresa habilita integraciones externas, como almacenamiento documental o correo, esa empresa debe asegurar que cuenta con permisos y avisos adecuados.",
    ],
  },
  {
    title: "8. Derechos y contacto",
    body: [
      "Los colaboradores deben dirigir solicitudes sobre acceso, correccion, oposicion, eliminacion o explicacion del monitoreo primero a su empleador, ya que la empresa controla la relacion laboral y la configuracion del tratamiento.",
      "Para consultas sobre esta politica o seguridad de VYNTRA, escriba a privacy@vyntralab.com.",
    ],
  },
  {
    title: "9. Cambios",
    body: [
      "Podemos actualizar esta politica para reflejar cambios del producto, requisitos legales o practicas de seguridad. La version vigente se publicara en esta pagina.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <nav className="legal-nav" aria-label="VYNTRA">
        <Link href="/" className="legal-brand">
          <span>V</span>
          <strong>VYNTRA</strong>
        </Link>
        <Link href="/login" className="legal-login">Ingresar</Link>
      </nav>

      <article className="legal-document">
        <header>
          <p>Ultima actualizacion: agosto de 2026</p>
          <h1>Politica de privacidad</h1>
          <span>VYNTRA Agent y VYNTRA Control</span>
        </header>

        <section className="legal-summary">
          <strong>Resumen</strong>
          <p>
            VYNTRA es una herramienta empresarial para monitoreo laboral consentido, asistencia,
            productividad y evidencia operativa. El monitoreo debe configurarse y comunicarse por
            la empresa responsable antes de instalar el agente en equipos de trabajo.
          </p>
        </section>

        {sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </article>
    </main>
  );
}
