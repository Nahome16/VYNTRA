"""
test_rules_download.py - Prueba de descarga de reglas de productividad.

Uso desde PowerShell:
    python test_rules_download.py
"""

import json
import sys
from config import Config
from rules_downloader import RulesDownloader


def main():
    print("=" * 60)
    print("TEST: Descarga de Reglas de Productividad")
    print("=" * 60)

    try:
        print("\n1. Cargando configuración...")
        cfg = Config()
        print(f"   ✓ Backend URL: {cfg.evidence_backend_url}")
        print(f"   ✓ Token de dispositivo: {cfg.evidence_device_token[:10]}..." if cfg.evidence_device_token else "   ✗ Token no configurado")
        print(f"   ✓ Sincronización habilitada: {cfg.evidence_backend_enabled}")

        if not cfg.evidence_backend_enabled:
            print("\n   ✗ La sincronización no está habilitada en config.ini")
            return

        if not cfg.evidence_device_token:
            print("\n   ✗ Token de dispositivo no configurado")
            return

        print("\n2. Inicializando descargador de reglas...")
        downloader = RulesDownloader(cfg, on_event=print)

        print("\n3. Descargando reglas...")
        success = downloader.download_now()

        if success:
            info = downloader.get_rules_info()
            print(f"\n✓ Descarga exitosa!")
            print(f"   - Total de reglas: {info['count']}")
            print(f"   - Última actualización: {info['last_update']}")
            print(f"   - Cache guardado en: {info['cache_path']}")

            if info['count'] > 0:
                print("\n4. Primeras 5 reglas descargadas:")
                for i, rule in enumerate(downloader.rules[:5], 1):
                    print(f"   {i}. {rule.get('executable_name', 'N/A')}")
                    print(f"      - Título: {rule.get('title_contains', '(cualquier)')}")
                    print(f"      - Clasificación: {rule.get('classification')}")
                    print(f"      - Prioridad: {rule.get('priority')}")
        else:
            print("\n✗ Error al descargar reglas. Verifica tu conexión y token.")

    except Exception as exc:
        print(f"\n✗ Error: {exc}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    print("\n" + "=" * 60)
    print("Prueba completada")
    print("=" * 60)


if __name__ == "__main__":
    main()
