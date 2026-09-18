"""Fetch the Smart Home Hub 2 local token without persisting Mi Account login data."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from miio.cloud import CloudException, CloudInterface


EMAIL = "el_bruho@mail.ru"
HUB_IP = "192.168.101.5"
ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "runtime" / "xiaomi-hub-credentials.json"


def find_hub(cloud: CloudInterface):
    # The Mi Home account uses the Russian region.  Keep the fallback for a
    # device which has been associated with another region in the app.
    for locale in ("ru", None):
        devices = cloud.get_devices(locale=locale)
        for device in devices.values():
            if device.ip == HUB_IP:
                return device
    return None


def main() -> int:
    print("Вход в Xiaomi Cloud для поиска Smart Home Hub 2.")
    hub = None
    while hub is None:
        password = input("Пароль Mi Account (ввод отображается): ")
        try:
            cloud = CloudInterface(username=EMAIL, password=password)
            hub = find_hub(cloud)
        except CloudException as error:
            print(f"Не удалось войти в Xiaomi Cloud: {error}", file=sys.stderr)
            retry = input("Попробовать ещё раз? [Y/n]: ").strip().lower()
            if retry in {"n", "no", "нет", "н"}:
                return 1
        finally:
            password = None

    if hub is None:
        print(
            f"Hub с IP {HUB_IP} не найден в списке устройств Xiaomi Cloud.",
            file=sys.stderr,
        )
        return 2

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ip": hub.ip,
        "token": hub.token,
        "model": hub.model,
        "did": hub.did,
        "name": hub.name,
    }
    temporary = OUTPUT.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(OUTPUT)
    print("Токен Hub 2 сохранён локально. В терминал он не выводится.")
    print(f"Устройство: {hub.name} ({hub.model}), IP {hub.ip}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
