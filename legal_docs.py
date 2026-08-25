"""
Legal and consent copy shown by the VYNTRA desktop agent.

These texts are product notices, not legal advice. Customer-specific contracts,
retention periods and local annexes should be reviewed by counsel before launch
in each jurisdiction.
"""

from __future__ import annotations


NOTICE_VERSION = "2026.08-global-employee-notice-v1"


def normalized_language(value: str | None) -> str:
    value = (value or "").strip().lower()
    return "en" if value.startswith("en") else "es"


def employee_notice(language: str, company: str, contact_email: str, interval_minutes: int) -> dict:
    company = company or "la empresa"
    contact_email = contact_email or "RR. HH."
    interval_minutes = max(1, int(interval_minutes or 5))
    lang = normalized_language(language)
    if lang == "en":
        return {
            "title": "This work device records activity during your shift",
            "subtitle": (
                f"{company} uses VYNTRA to record working time, activity evidence and "
                "attendance-related events. Please read this notice before continuing."
            ),
            "sections": [
                (
                    "What is recorded only while your shift is active",
                    [
                        "Clock-in, clock-out, breaks, lunch and overtime events.",
                        "The foreground application, window title, idle time, click count and window switches.",
                        f"Screenshots at the interval configured by your employer. Current interval: every {interval_minutes} minutes.",
                        "Technical device data such as hostname, Windows user, agent version and synchronization status.",
                    ],
                ),
                (
                    "What VYNTRA never records",
                    [
                        "No keystrokes or typed content are captured.",
                        "Passwords are not captured.",
                        "Camera and microphone are not activated.",
                        "Personal files are not opened or copied.",
                        "No GPS location is collected.",
                        "Nothing is captured after your shift is closed or while capture is paused.",
                    ],
                ),
                (
                    "Purpose and access",
                    [
                        "The information is used for working-time records, attendance review, operational continuity and approved incident handling.",
                        "Only authorized users of your employer, such as administrators, HR or supervisors, may access it according to their role.",
                        "VYNTRA stores and processes this information on behalf of your employer and does not sell it or use it for advertising.",
                    ],
                ),
                (
                    "Your choices and rights",
                    [
                        f"You may ask {company} to show, correct or delete information when legally appropriate.",
                        "You may withdraw consent. Withdrawal is not retroactive and your employer may need to define another lawful way to record attendance.",
                        f"For questions or requests, contact: {contact_email}.",
                    ],
                ),
                (
                    "Practical recommendation",
                    [
                        "Avoid opening banking, health, personal messaging or other private information while your shift is active.",
                        "If you need to handle personal information, pause or close your shift first.",
                    ],
                ),
            ],
            "checks": [
                "I have read and understood this monitoring notice.",
                "I understand what VYNTRA records and what it does not record.",
                "I authorize activity evidence during my active work shift under the configuration described above.",
                "I understand that I may withdraw consent and request information through the contact listed above.",
            ],
            "accept": "Accept and continue",
            "reject": "Do not accept and exit",
            "contact": f"Contact: {contact_email}",
        }

    return {
        "title": "Este equipo registra actividad durante tu jornada laboral",
        "subtitle": (
            f"{company} utiliza VYNTRA para registrar jornada, evidencias de actividad "
            "y eventos relacionados con asistencia. Lee este aviso antes de continuar."
        ),
        "sections": [
            (
                "Que se registra solo mientras tu jornada esta activa",
                [
                    "Inicio, cierre de jornada, pausas, almuerzo y horas extra.",
                    "Aplicacion en primer plano, titulo de ventana, inactividad, conteo de clics y cambios de ventana.",
                    f"Capturas de pantalla con el intervalo configurado por tu empleador. Intervalo actual: cada {interval_minutes} minutos.",
                    "Datos tecnicos del equipo como nombre del dispositivo, usuario de Windows, version del agente y estado de sincronizacion.",
                ],
            ),
            (
                "Lo que VYNTRA nunca registra",
                [
                    "No registra teclas ni el contenido que escribes.",
                    "No captura contrasenas.",
                    "No activa camara ni microfono.",
                    "No abre ni copia archivos personales.",
                    "No recopila ubicacion GPS.",
                    "No captura nada cuando cierras la jornada o cuando la captura esta pausada.",
                ],
            ),
            (
                "Finalidad y acceso",
                [
                    "La informacion se usa para control de jornada, revision de asistencia, continuidad operativa y gestion de incidencias aprobadas.",
                    "Solo usuarios autorizados de tu empleador, como administracion, RR. HH. o supervisores, pueden verla segun su rol.",
                    "VYNTRA almacena y procesa esta informacion por cuenta de tu empleador. No la vende ni la usa para publicidad.",
                ],
            ),
            (
                "Tus decisiones y derechos",
                [
                    f"Puedes pedir a {company} que te muestre, corrija o elimine informacion cuando corresponda legalmente.",
                    "Puedes retirar tu consentimiento. El retiro no es retroactivo y tu empleador podria definir otro medio valido para registrar asistencia.",
                    f"Para consultas o solicitudes, contacta a: {contact_email}.",
                ],
            ),
            (
                "Recomendacion practica",
                [
                    "Evita abrir banca, salud, mensajeria personal u otra informacion privada mientras tu jornada esta activa.",
                    "Si necesitas atender informacion personal, pausa o cierra tu jornada primero.",
                ],
            ),
        ],
        "checks": [
            "Lei y comprendi este aviso de monitoreo.",
            "Entiendo que registra VYNTRA y que no registra.",
            "Autorizo evidencias de actividad durante mi jornada laboral activa bajo la configuracion descrita.",
            "Entiendo que puedo retirar el consentimiento y solicitar informacion mediante el contacto indicado.",
        ],
        "accept": "Aceptar y continuar",
        "reject": "No aceptar y salir",
        "contact": f"Contacto: {contact_email}",
    }


def terms_summary(language: str) -> dict:
    if normalized_language(language) == "en":
        return {
            "title": "VYNTRA terms and privacy summary",
            "body": (
                "VYNTRA is a work-time, attendance and activity-evidence platform used by a customer company. "
                "The customer company determines who is monitored, why, for how long and who may access the data. "
                "VYNTRA does not make employment decisions, does not sell personal data, and does not perform hidden monitoring. "
                "The full terms, privacy policy and employee notice are included in the installation package and in the installed app folder."
            ),
        }
    return {
        "title": "Resumen de terminos y privacidad de VYNTRA",
        "body": (
            "VYNTRA es una plataforma de jornada, asistencia y evidencias de actividad usada por una empresa cliente. "
            "La empresa cliente determina a quien se monitorea, con que finalidad, por cuanto tiempo y quien puede acceder a los datos. "
            "VYNTRA no toma decisiones laborales, no vende datos personales y no realiza monitoreo oculto. "
            "Los terminos completos, politica de privacidad y aviso al empleado estan incluidos en el paquete de instalacion y en la carpeta instalada."
        ),
    }
