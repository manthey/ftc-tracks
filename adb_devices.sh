#!/usr/bin/env bash
# Download Android platform-tools into the home directory if needed, then
# run an adb command against the Windows adb server (started by
# adb_server_win.py on the Windows host).
#
# Usage: adb_devices.sh [adb arguments]
#        adb_devices.sh                  -> runs `adb devices`
#        adb_devices.sh shell ls /sdcard -> runs that through the Windows server
#
# Environment overrides:
#   ADB_HOST  Windows host address (default: host.docker.internal, falling
#             back to the DNS server from /etc/resolv.conf)
#   ADB_PORT  adb server port        (default: 5037)
set -euo pipefail

PORT="${ADB_PORT:-5037}"
HOST="${ADB_HOST:-}"

if [ -z "$HOST" ]; then
    HOST=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1; exit}')
fi
if [ -z "$HOST" ]; then
    HOST=$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)
fi
if [ -z "$HOST" ]; then
    echo "error: cannot determine the Windows host address; set ADB_HOST" >&2
    exit 1
fi

# Find adb: on PATH, or the copy downloaded into ~/platform-tools.
ADB_BIN=""
if command -v adb >/dev/null 2>&1; then
    ADB_BIN="$(command -v adb)"
elif [ -x "$HOME/platform-tools/adb" ]; then
    ADB_BIN="$HOME/platform-tools/adb"
fi

if [ -z "$ADB_BIN" ]; then
    echo "platform-tools not found, downloading..."
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    URL="https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
    if command -v curl >/dev/null 2>&1; then
        curl -fL "$URL" -o "$TMP/platform-tools.zip"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$TMP/platform-tools.zip" "$URL"
    else
        echo "error: neither curl nor wget is available to download platform-tools" >&2
        exit 1
    fi
    # unzip may not be installed in the container; python3 zipfile works too.
    if command -v unzip >/dev/null 2>&1; then
        unzip -q "$TMP/platform-tools.zip" -d "$HOME"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -m zipfile -e "$TMP/platform-tools.zip" "$HOME"
    else
        echo "error: neither unzip nor python3 is available to extract platform-tools" >&2
        exit 1
    fi
    if [ ! -x "$HOME/platform-tools/adb" ]; then
        echo "error: download succeeded but $HOME/platform-tools/adb is missing" >&2
        exit 1
    fi
    ADB_BIN="$HOME/platform-tools/adb"
fi

echo "using adb: $ADB_BIN"
echo "server:    $HOST:$PORT"

# Auto-detect the port the server actually listens on (adb_server_win.py
# falls back to 5038-5040 when 5037 is taken, e.g. by the REV Hardware
# Client).  An adb server answers any TCP client with "OKAY" for the
# "host:version" request.
if command -v python3 >/dev/null 2>&1; then
    DETECTED=$(python3 - "$HOST" "$PORT" 5038 5039 5040 5050 5060 5070 <<'PROBE'
import socket, sys
host, ports = sys.argv[1], [int(p) for p in sys.argv[2:]]
timeouts = []
for port in ports:
    try:
        sock = socket.create_connection((host, port), timeout=3)
        sock.sendall(b"000Chost:version")
        data = sock.recv(1024)
        sock.close()
        if data.startswith(b"OKAY"):
            print(port)
            sys.exit(0)
    except ConnectionRefusedError:
        pass  # nothing listening there; try the next port
    except (socket.timeout, TimeoutError):
        timeouts.append(port)
    except OSError:
        pass
if timeouts:
    print(f"note: TCP connections to {host} ports "
          f"{', '.join(str(p) for p in timeouts)} time out instead of being "
          "refused, so something is dropping the packets - almost always",
          file=sys.stderr)
    print("note: Windows Defender.  Add the inbound rule from "
          "adb_server_win.py --help and try again.", file=sys.stderr)
sys.exit(1)
PROBE
    ) || DETECTED=""
    if [ -n "$DETECTED" ] && [ "$DETECTED" != "$PORT" ]; then
        echo "note: adb server found on port $DETECTED instead of $PORT; using it."
        PORT="$DETECTED"
    elif [ -z "$DETECTED" ]; then
        echo "note: no adb server answered on ports $PORT 5038-5040 5050-5070;"
        echo "note: is adb_server_win.py running on Windows?"
    fi
fi

if [ $# -eq 0 ]; then
    set -- devices
    # `devices` should never hang: cap it when a firewall silently drops
    # packets (adb's own connect timeout is very long).
    if command -v timeout >/dev/null 2>&1; then
        TIMEOUT_CMD=(timeout 60)
    fi
else
    TIMEOUT_CMD=()
fi

OUTPUT=$("${TIMEOUT_CMD[@]}" "$ADB_BIN" -H "$HOST" -P "$PORT" "$@" 2>&1) || RC=$?
if [ "${RC:-0}" -ne 0 ]; then
    printf '%s\n' "$OUTPUT"
    if grep -qi "doesn't match this client\|cannot kill server" <<<"$OUTPUT"; then
        echo "hint: the Windows adb server is older than this client." >&2
        echo "hint: re-run adb_server_win.py on Windows WITHOUT --no-download so it" >&2
        echo "hint: downloads a matching platform-tools, or re-download here with:" >&2
        echo "hint:   rm -rf ~/platform-tools && ./adb_devices.sh" >&2
    fi
    exit "$RC"
fi
printf '%s\n' "$OUTPUT"
