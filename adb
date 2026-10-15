#!/usr/bin/env python3
"""ADB wrapper with password-authenticated, persistent per-host SSH tunnels.

Management:
    adb tunnel start lab42
    adb tunnel list
    adb tunnel status lab42
    adb tunnel stop lab42
    adb tunnel stop --all

Remote ADB (only for hosts with started tunnels):
    adb lab42 devices
    adb lab42 -s DEVICE_SERIAL shell
    adb @lab42 devices       # Unambiguous host selection

Other commands (e.g. "adb version", "adb devices") are delegated unchanged
 to the real ADB executable.

IMPORTANT: The SSH password below is stored in PLAINTEXT in this file.
Only use password automation if your lab's security policy permits it.
Protect this file with chmod 700.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile

# ---------------------- USER CONFIGURATION ----------------------
SSH_PASSWORD = "REPLACE_WITH_YOUR_LAB_PASSWORD"
REMOTE_ADB_PORT = 5037
# Optional: override with the ADBHOST_REAL_ADB environment variable.
DEFAULT_REAL_ADB = "/usr/bin/adb"
# ---------------------------------------------------------------

STATE_DIR = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "adbhost"
REGISTRY_FILE = STATE_DIR / "tunnels.json"
LOCK_FILE = STATE_DIR / ".lock"
# Keep the SSH control socket path short (Unix socket paths have length limits).
RUNTIME_BASE = Path(os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir())
CONTROL_DIR = RUNTIME_BASE / f"adbhost-{os.getuid()}"

# Reserve ADB's first-word command names to avoid hijacking normal commands.
ADB_COMMANDS = {
    "version", "help", "devices", "get-state", "get-serialno", "get-devpath",
    "features", "host-features", "wait-for-device", "wait-for-disconnect",
    "start-server", "kill-server", "reconnect", "reconnect-device", "reconnect-offline",
    "connect", "disconnect", "pair", "mdns", "usb", "tcpip", "root", "unroot",
    "remount", "reboot", "sideload", "install", "install-multiple", "install-multi-package",
    "uninstall", "shell", "exec-out", "logcat", "bugreport", "push", "pull", "sync",
    "forward", "reverse", "jdwp", "track-jdwp", "track-devices", "emu", "backup",
    "restore", "disable-verity", "enable-verity", "keygen", "server-status",
    "abb", "burst", "attach", "detach", "transport-id",
}


def find_real_adb() -> str:
    """Find the real ADB without ever recursively running this wrapper."""
    self_path = Path(__file__).resolve()
    candidates = []
    if os.environ.get("ADBHOST_REAL_ADB"):
        candidates.append(os.environ["ADBHOST_REAL_ADB"])
    else:
        # Match the user's normal PATH priority, excluding this wrapper.
        for folder in os.get_exec_path():
            candidates.append(str(Path(folder) / "adb"))
        candidates.append(DEFAULT_REAL_ADB)
    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_file() and os.access(path, os.X_OK) and path.resolve() != self_path:
            return str(path)
    raise RuntimeError(
        "Real adb executable not found. Set ADBHOST_REAL_ADB=/path/to/real/adb."
    )


def validate_host(host: str) -> None:
    # No shell is used, but rejecting whitespace/options avoids SSH surprises.
    if not host or host.startswith("-") or re.search(r"\s", host):
        raise ValueError("Invalid hostname. Use a hostname, SSH alias, IP, or user@host.")


def init_dirs() -> None:
    os.umask(0o077)
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    CONTROL_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if STATE_DIR.stat().st_uid != os.getuid() or CONTROL_DIR.stat().st_uid != os.getuid():
        raise RuntimeError("Tunnel directories must be owned by the current user.")
    if STATE_DIR.stat().st_mode & 0o077 or CONTROL_DIR.stat().st_mode & 0o077:
        raise RuntimeError("Tunnel directories must be private (chmod 700).")


def read_registry() -> dict:
    if not REGISTRY_FILE.exists():
        return {}
    try:
        data = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("tunnels"), dict):
            raise ValueError("Invalid registry format")
        return data["tunnels"]
    except (ValueError, OSError) as exc:
        raise RuntimeError(f"Cannot read tunnel registry {REGISTRY_FILE}: {exc}") from exc


def save_registry(registry: dict) -> None:
    # Atomic replace keeps readers in other terminals from seeing partial JSON.
    fd, tmp = tempfile.mkstemp(prefix=".tunnels-", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "tunnels": registry}, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, REGISTRY_FILE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def locked_registry():
    init_dirs()
    fd = os.open(LOCK_FILE, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        registry = read_registry()
        yield registry
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def control_path(host: str) -> Path:
    digest = hashlib.sha256(host.encode("utf-8")).hexdigest()[:20]
    return CONTROL_DIR / f"ctl-{digest}"


def ssh_control(host: str, path: str, action: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["ssh", "-S", path, "-O", action, "-o", "BatchMode=yes", host],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=6,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess([], 1, "", str(exc))


def alive(host: str, entry: dict) -> bool:
    return ssh_control(host, entry["control"], "check").returncode == 0


def unused_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def askpass(prompt: str) -> int:
    """Invoked by OpenSSH itself via SSH_ASKPASS; no password in argv/env."""
    if os.environ.get("ADBHOST_ASKPASS") != "1":
        return 2
    # Don't answer OTP, key-passphrase, host-key verification or other prompts.
    if "password" not in prompt.lower():
        print(f"adbhost: refusing unexpected SSH prompt: {prompt}", file=sys.stderr)
        return 1
    if SSH_PASSWORD == "REPLACE_WITH_YOUR_LAB_PASSWORD" or not SSH_PASSWORD:
        print("adbhost: set SSH_PASSWORD in the wrapper first", file=sys.stderr)
        return 1
    print(SSH_PASSWORD)
    return 0


def tunnel_start(host: str, remote_port: int) -> int:
    validate_host(host)
    if not 1 <= remote_port <= 65535:
        raise ValueError("Remote port must be 1–65535.")
    if SSH_PASSWORD == "REPLACE_WITH_YOUR_LAB_PASSWORD" or not SSH_PASSWORD:
        raise ValueError("Edit SSH_PASSWORD near the top of the script before starting tunnels.")

    with locked_registry() as registry:
        entry = registry.get(host)
        if entry and alive(host, entry):
            print(f"{host} already connected on localhost:{entry['port']}")
            return 0
        # An old process/socket may have died without cleaning the registry.
        registry.pop(host, None)
        ctl = control_path(host)
        if ctl.is_socket():
            ctl.unlink()

        for attempt in range(3):
            port = unused_port()
            # The file is itself the SSH_ASKPASS executable. SSH prompts are
            # satisfied without needing pexpect or sshpass.
            env = os.environ.copy()
            env["SSH_ASKPASS"] = str(Path(__file__).resolve())
            env["SSH_ASKPASS_REQUIRE"] = "force"
            env["ADBHOST_ASKPASS"] = "1"
            try:
                result = subprocess.run(
                    [
                        "ssh", "-M", "-S", str(ctl), "-fN",
                        "-o", "BatchMode=no",
                        "-o", "NumberOfPasswordPrompts=1",
                        "-o", "ExitOnForwardFailure=yes",
                        "-o", "StrictHostKeyChecking=accept-new",
                        "-o", "ServerAliveInterval=30",
                        "-o", "ServerAliveCountMax=3",
                        "-L", f"127.0.0.1:{port}:127.0.0.1:{remote_port}",
                        host,
                    ],
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=90,
                )
            except FileNotFoundError as exc:
                raise RuntimeError("OpenSSH client not found in PATH") from exc
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("SSH connection timed out (90 seconds)") from exc

            if result.returncode == 0:
                entry = {"port": port, "remote_port": remote_port, "control": str(ctl)}
                registry[host] = entry
                save_registry(registry)
                print(f"Connected {host} -> localhost:{port} -> {host}:{remote_port}")
                return 0

            errors = result.stderr.strip() or result.stdout.strip() or "Unknown SSH error"
            if ("Address already in use" in errors or "cannot listen to port" in errors) and attempt < 2:
                continue
            raise RuntimeError(f"SSH tunnel to {host} failed:\n{errors}")
    return 1


def tunnel_list() -> int:
    if not REGISTRY_FILE.exists():
        print("No tunnels registered.")
        return 0
    with locked_registry() as registry:
        if not registry:
            print("No tunnels registered.")
            return 0
        print(f"{'HOST':<32} {'LOCAL PORT':<12} {'REMOTE PORT':<12} STATUS")
        for host, entry in sorted(registry.items()):
            state = "active" if alive(host, entry) else "stale"
            print(f"{host:<32} {entry['port']:<12} {entry['remote_port']:<12} {state}")
    return 0


def tunnel_status(host: str) -> int:
    if not REGISTRY_FILE.exists():
        print(f"{host}: no tunnel registered")
        return 1
    with locked_registry() as registry:
        entry = registry.get(host)
        if not entry:
            print(f"{host}: no tunnel registered")
            return 1
        state = "active" if alive(host, entry) else "stale"
        print(f"{host}: {state} (127.0.0.1:{entry['port']} -> 127.0.0.1:{entry['remote_port']})")
        return 0 if state == "active" else 1


def tunnel_stop_one(host: str, registry: dict) -> bool:
    entry = registry.get(host)
    if not entry:
        print(f"{host}: no tunnel registered", file=sys.stderr)
        return False
    if alive(host, entry):
        result = ssh_control(host, entry["control"], "exit")
        if result.returncode != 0:
            print(f"{host}: unable to close SSH tunnel: {result.stderr.strip()}", file=sys.stderr)
            return False
    registry.pop(host, None)
    print(f"Stopped {host}")
    return True


def tunnel_stop(host: str | None = None, all_hosts: bool = False) -> int:
    if not REGISTRY_FILE.exists():
        print("No tunnels registered.")
        return 0
    with locked_registry() as registry:
        hosts = list(registry) if all_hosts else [host]
        ok = True
        for name in hosts:
            ok = tunnel_stop_one(name, registry) and ok
        save_registry(registry)
        return 0 if ok else 1


def handle_tunnel(args: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="adb tunnel", description="Manage remote ADB SSH tunnels")
    sub = parser.add_subparsers(dest="action", required=True)
    start = sub.add_parser("start", help="Create an SSH tunnel (automated password)")
    start.add_argument("host", help="Hostname, SSH alias, IP, or user@host")
    start.add_argument("--remote-port", type=int, default=REMOTE_ADB_PORT)
    sub.add_parser("list", help="List current host-to-port mappings")
    status = sub.add_parser("status", help="Check a tunnel")
    status.add_argument("host")
    stop = sub.add_parser("stop", help="Stop a tunnel")
    targets = stop.add_mutually_exclusive_group(required=True)
    targets.add_argument("host", nargs="?")
    targets.add_argument("--all", action="store_true", dest="all_hosts")
    ns = parser.parse_args(args)
    if ns.action == "start":
        return tunnel_start(ns.host, ns.remote_port)
    if ns.action == "list":
        return tunnel_list()
    if ns.action == "status":
        return tunnel_status(ns.host)
    if ns.action == "stop":
        return tunnel_stop(ns.host, ns.all_hosts)
    return 2


def run_adb(argv: list[str]) -> None:
    real = find_real_adb()
    if not argv:
        os.execv(real, [real])

    first = argv[0]
    explicit_remote = first.startswith("@") and len(first) > 1
    host = first[1:] if explicit_remote else first
    # "adb devices", "adb version", etc. remain unmodified, even if a host
    # somehow has the same name. "adb @devices ..." is always unambiguous.
    if first.startswith("-") or (first in ADB_COMMANDS and not explicit_remote):
        os.execv(real, [real, *argv])

    registry = read_registry() if REGISTRY_FILE.exists() else {}
    entry = registry.get(host)
    if entry is None:
        if explicit_remote:
            raise ValueError(f"No active tunnel for {host}. Run: adb tunnel start {host}")
        os.execv(real, [real, *argv])

    if not alive(host, entry):
        raise RuntimeError(f"Tunnel to {host} is disconnected. Restart: adb tunnel start {host}")

    # ADB_SERVER_SOCKET may override -H/-P on some builds; remove for remote.
    os.environ.pop("ADB_SERVER_SOCKET", None)
    os.execv(real, [real, "-H", "127.0.0.1", "-P", str(entry["port"]), *argv[1:]])


def main() -> int:
    # The same executable serves as the private OpenSSH askpass helper.
    if os.environ.get("ADBHOST_ASKPASS") == "1":
        return askpass(sys.argv[1] if len(sys.argv) > 1 else "")
    if len(sys.argv) > 1 and sys.argv[1] == "tunnel":
        return handle_tunnel(sys.argv[2:])
    run_adb(sys.argv[1:])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"adb wrapper: {exc}", file=sys.stderr)
        sys.exit(1)
