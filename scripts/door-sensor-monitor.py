"""Visible health monitor for the Xiaomi Smart Home Hub 2 door-sensor channel."""

from __future__ import annotations

import json
import select
import socket
import time
from datetime import datetime
from pathlib import Path

from miio.device import Device


ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "runtime" / "xiaomi-door-sensor.json"
LOG = ROOT / "runtime" / "door-sensor-monitor.log"


def log(message: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S} {message}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")


def main() -> None:
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    hub = config["hub"]
    door = config["door"]
    log(f"Monitor started: Hub {hub['ip']}, door sensor {door['mac']}.")
    listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", 9898))
    listener.setblocking(False)
    log("Hub health channel is active. Listening for gateway events on UDP 9898.")
    next_health_check = 0.0
    while True:
        ready, _, _ = select.select([listener], [], [], 1)
        if ready:
            payload, sender = listener.recvfrom(65535)
            try:
                event = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if door["mac"].lower() in json.dumps(event).lower() or door["did"] in json.dumps(event):
                log(f"Door sensor event from {sender[0]}: {json.dumps(event, ensure_ascii=False)}")
        if time.monotonic() >= next_health_check:
            next_health_check = time.monotonic() + 30
            try:
                info = Device(hub["ip"], hub["token"]).info()
                log(f"Hub online: {info.model}, firmware {info.firmware_version}.")
            except Exception as error:
                log(f"Hub unavailable: {type(error).__name__}: {error}")


if __name__ == "__main__":
    main()
