"""Gateway runtime setup and the operator's enrolment CLI.

    python3 -m housemate_endpoint_gateway.admin --db DB --key KEY list [--state pending]
    python3 -m housemate_endpoint_gateway.admin --db DB --key KEY approve ENDPOINT_ID \\
        --name "Kitchen Speaker" --area office --physical-pairing-confirmed --secret-out FILE

Approval needs the operator to have confirmed the device in hand (physical pairing). The device
secret is written only to --secret-out (0600, refused if it exists) for provisioning onto that one
device; it is never printed. The master key file is created 0600 on first use and stays out of git
and out of the fleet database.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys

from .registry import FleetRegistry
from .service import GatewayControlPlane

MASTER_KEY_BYTES = 32


def load_master_key(path: str, *, create: bool) -> bytes:
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        if not create:
            raise SystemExit(f"no gateway master key at {path}")
        os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(secrets.token_bytes(MASTER_KEY_BYTES))
    mode = os.stat(path).st_mode & 0o777
    if mode & 0o077:
        raise SystemExit(f"gateway master key {path} must be owner-only (is {oct(mode)})")
    with open(path, "rb") as f:
        key = f.read()
    if len(key) < MASTER_KEY_BYTES:
        raise SystemExit("gateway master key is too short")
    return key


def build_control_plane(db_path: str, key_path: str, *, create_key: bool = True) -> GatewayControlPlane:
    registry = FleetRegistry(os.path.expanduser(db_path))
    return GatewayControlPlane(registry, load_master_key(key_path, create=create_key))


def _record_summary(record) -> dict:
    return {
        "endpoint_id": record.endpoint_id,
        "state": record.state,
        "friendly_name": record.friendly_name,
        "area_id": record.area_id,
        "hardware_id": record.hardware_id,
        "last_ip": record.last_ip,
        "credential_version": record.credential_version,
        "media_player": record.media_player,
        "ha_device_id": record.ha_device_id,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="housemate_endpoint_gateway.admin")
    ap.add_argument("--db", required=True)
    ap.add_argument("--key", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list")
    ls.add_argument("--state")
    ok = sub.add_parser("approve")
    ok.add_argument("endpoint_id")
    ok.add_argument("--name", required=True)
    ok.add_argument("--area", required=True)
    ok.add_argument("--physical-pairing-confirmed", action="store_true")
    ok.add_argument("--secret-out", required=True)
    rv = sub.add_parser("revoke")
    rv.add_argument("endpoint_id")
    pl = sub.add_parser("player", help="set the endpoint's Music Assistant player (`none` clears it)")
    pl.add_argument("endpoint_id")
    pl.add_argument("media_player")
    dv = sub.add_parser("device", help="set the endpoint's Home Assistant device, for Assist turns (`none` clears it)")
    dv.add_argument("endpoint_id")
    dv.add_argument("ha_device_id")
    a = ap.parse_args(argv)

    control = build_control_plane(a.db, a.key, create_key=a.cmd not in ("list", "player", "device"))
    if a.cmd == "list":
        records = control.registry.list(state=a.state)
        print(json.dumps([_record_summary(r) for r in records], indent=1))
        return 0
    if a.cmd == "revoke":
        print(json.dumps(_record_summary(control.revoke(a.endpoint_id))))
        return 0
    if a.cmd == "player":
        player = None if a.media_player.lower() == "none" else a.media_player
        print(json.dumps(_record_summary(control.registry.assign_media_player(a.endpoint_id, player))))
        return 0
    if a.cmd == "device":
        device = None if a.ha_device_id.lower() == "none" else a.ha_device_id
        print(json.dumps(_record_summary(control.registry.assign_ha_device(a.endpoint_id, device))))
        return 0
    if not a.physical_pairing_confirmed:
        raise SystemExit("approve needs --physical-pairing-confirmed (the device is in the operator's hands)")
    out = os.path.expanduser(a.secret_out)
    if os.path.exists(out):
        raise SystemExit(f"{out} already exists; refusing to overwrite a secret file")
    grant = control.approve_pending(
        a.endpoint_id,
        friendly_name=a.name,
        area_id=a.area,
        physical_pairing_confirmed=True,
    )
    # Only once the grant exists: a failed approval must not leave an empty secret file behind.
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({
            "endpoint_id": grant.endpoint_id,
            "credential_version": grant.credential_version,
            "secret": grant.device_secret,
        }, f)
    print(json.dumps({"approved": grant.endpoint_id, "credential_version": grant.credential_version,
                      "secret_written_to": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
