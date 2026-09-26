FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_UID=10001 \
    APP_GID=10001 \
    FORWARDED_ALLOW_IPS="*"

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Usuario sin privilegios para ejecutar la API.
RUN groupadd --system --gid 10001 vyntra \
    && useradd --system --uid 10001 --gid vyntra --home-dir /app --no-create-home --shell /usr/sbin/nologin vyntra \
    && mkdir -p /data/evidence /data/downloads \
    && chown -R vyntra:vyntra /data/evidence

COPY app /app/app
COPY scripts /app/scripts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

# El entrypoint arranca como root solo para corregir la propiedad del volumen de
# evidencias (los volumenes creados por versiones anteriores quedaron como root)
# y luego baja a vyntra (uid 10001) antes de ejecutar uvicorn.
#
# --proxy-headers + FORWARDED_ALLOW_IPS: en produccion el puerto 8000 de la API
# no se publica (solo Caddy y web la alcanzan por la red interna de Docker), por
# eso "*" es aceptable. Si alguna vez se publica el puerto, restringir
# FORWARDED_ALLOW_IPS a la IP/red de Caddy.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=\"${FORWARDED_ALLOW_IPS:-*}\""]
