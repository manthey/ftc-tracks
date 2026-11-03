#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

import argparse
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

EPILOG = r"""Firewall (Windows Defender):
  A container reaches this server as an inbound TCP connection, and Defender
  blocks inbound connections from other subnets by default - which is exactly
  what WSL2 and Docker use.  Allow the private 172.16.0.0/12 range (covers
  both the WSL 172.16-172.31.x.x addresses and the Docker bridge 172.17.x.x)
  once, from an elevated PowerShell, then run this script again:

    New-NetFirewallRule -DisplayName "ADBDocker" -Direction Inbound -Action
       Allow -Protocol TCP -LocalPort 5037-5040 -Profile Public -RemoteAddress
       172.16.0.0/12

  To remove the rule later:

    Remove-NetFirewallRule -DisplayName "ADBDocker"

Connecting from the container:
  adb -H <windows-ip> -P <port> devices
  <windows-ip> is the address this script prints when it starts (the address
  that host.docker.internal resolves to inside the container).  The
  adb_devices.sh helper auto-detects the port.

adb version note:
  An adb client refuses to talk to a server older than itself, so the server
  and the container's client should be from the same platform-tools release.
  That is why this script by default downloads the current platform-tools;
  pass --no-download to use the local adb regardless.
"""

DOWNLOAD_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
DOWNLOAD_ROOT = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'ftc-adb')
ADB_CANDIDATES = [
    'C:\\Program Files (x86)\\REV Robotics\\REV Hardware Client\\android-tools\\adb.exe',
    'C:\\Program Files\\REV Robotics\\REV Hardware Client\\android-tools\\adb.exe',
    'adb',
]
# A server older than this may not accept a modern client's handshake.
MIN_VERSION = (31, 0, 0)
# Ports tried after the requested one, in order.
FALLBACK_PORTS = (5038, 5039, 5040, 5050, 5060, 5070)
# Log text that indicates a bind conflict specifically.
BUSY_MARKERS = ('only one usage', 'address already in use', '10048')
DENIED_MARKERS = ('permission denied', 'access denied', '10013')
SMARTSOCKET_REASON = re.compile(r'could not install \*smartsocket\* listener: (.*)')


def downloaded_adb():
    """Path of the platform-tools copy this script manages, if installed."""
    return os.path.join(DOWNLOAD_ROOT, 'platform-tools', 'adb.exe')


def exists(candidate):
    """True if candidate is an existing file or resolves on PATH."""
    if candidate == 'adb':
        return shutil.which('adb') is not None
    return os.path.isfile(candidate)


def adb_version(adb):
    """Version string such as 35.0.2 from `adb --version`, or None."""
    try:
        result = subprocess.run(
            [adb, '--version'], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in result.stdout.splitlines():
        if line.startswith('Version '):
            return line.split()[1]
    return None


def version_tuple(version):
    numbers = re.findall(r'\d+', version)
    return tuple(int(n) for n in numbers[:3]) if numbers else (0,)


def find_adb():
    """Return the best existing adb executable, or None.

    Prefers the copy this script downloaded (so the server version matches
    the container's current client), then the REV Hardware Client bundled
    copy, then whatever is on PATH.
    """
    for candidate in [downloaded_adb(), *ADB_CANDIDATES]:
        if exists(candidate):
            return candidate
    return None


def download_platform_tools():
    """Download current Windows platform-tools and return its adb path."""
    os.makedirs(DOWNLOAD_ROOT, exist_ok=True)
    zip_path = DOWNLOAD_ROOT + '.zip'
    print(f'downloading current platform-tools to {DOWNLOAD_ROOT} ...')
    urllib.request.urlretrieve(DOWNLOAD_URL, zip_path)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(DOWNLOAD_ROOT)
    os.remove(zip_path)
    adb = downloaded_adb()
    if not os.path.isfile(adb):
        msg = f'{adb} missing after extraction'
        raise RuntimeError(msg)
    return adb


def smartsocket(port, command, timeout=2.0):
    """Send one smartsocket request to 127.0.0.1:port and return the reply
    payload.

    The smartsocket protocol is a 4-digit hex length followed by the
    request text; replies are OKAY, a 4-digit hex length, then the payload.
    Returns None if nothing is listening, 'other' if the port is held by
    something that does not speak the adb protocol.
    """
    message = command.encode()
    try:
        with socket.create_connection(('127.0.0.1', port),
                                      timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(f'{len(message):04x}'.encode() + message)
            data = b''
            while len(data) < 8:
                chunk = sock.recv(256)
                if not chunk:
                    break
                data += chunk
            if len(data) < 8 or not data.startswith(b'OKAY'):
                return 'other'
            payload_length = int(data[4:8], 16)
            while len(data) < 8 + payload_length:
                chunk = sock.recv(256)
                if not chunk:
                    break
                data += chunk
            return data[8:8 + payload_length].decode('ascii', 'replace')
    except ConnectionRefusedError:
        return None
    except (OSError, ValueError):
        return 'other'


def find_server(ports):
    """Look for an adb server among the candidate ports.

    Returns (port, version, others): the port and version of the first adb
    server found (None if there is none), and the ports held by something
    that is not an adb server.
    """
    port = version = None
    others = []
    for candidate in ports:
        answer = smartsocket(candidate, 'host:version')
        if answer is None:
            continue
        if answer == 'other':
            others.append(candidate)
        elif port is None:
            port, version = candidate, answer.strip()
    return port, version, others


def wait_server_gone(port, timeout=5.0):
    """Wait until nothing answers on port; True once the port is quiet."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if smartsocket(port, 'host:version') is None:
            return True
        time.sleep(0.25)
    return smartsocket(port, 'host:version') is None


def check_or_stop(args):
    """Implement --check and --stop without needing the adb binary."""
    ports = [args.port] + [p for p in FALLBACK_PORTS if p != args.port]
    port, version, others = find_server(ports)
    for other in others:
        print(f'note: something that is not an adb server is listening on '
              f'port {other}', file=sys.stderr)
    listed = ', '.join(str(p) for p in ports)
    if args.check:
        if port is None:
            print(f'no adb server is running (checked ports {listed})')
            return 1
        print(f'adb server is running on tcp:127.0.0.1:{port} '
              f'(server version {version})')
        return 0
    if port is None:
        print(f'no adb server is running (checked ports {listed})')
        return 0
    print(f'stopping the adb server on port {port} ...')
    smartsocket(port, 'host:kill')
    if wait_server_gone(port):
        print(f'adb server on port {port} stopped')
        return 0
    print(f'error: the adb server on port {port} did not stop; try '
          f'"adb -H localhost -P {port} kill-server"', file=sys.stderr)
    return 1


def stop_server(adb, port=None):
    """Stop an adb server: default socket, or a specific port via -H.

    When the server runs on a fallback port, plain `adb kill-server` would
    target whatever holds 5037 (e.g. the REV Hardware Client's server)
    instead of ours.
    """
    cmd = [adb]
    if port is not None:
        cmd += ['-H', 'localhost', '-P', str(port)]
    cmd.append('kill-server')
    subprocess.run(cmd, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)


def show_devices(adb, port, timeout=15.0):
    """Print `adb devices` output from the server we started."""
    try:
        result = subprocess.run([adb, '-H', 'localhost', '-P', str(port),
                                 'devices'], timeout=timeout,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True)
        print(result.stdout.strip())
    except subprocess.TimeoutExpired:
        print('warning: adb devices timed out')


def port_bindable(port):
    """True if this process can bind 0.0.0.0:port right now.

    Catches both a port held by another program and a port inside a Windows
    reserved range, before adb even starts.
    """
    for address in ('0.0.0.0', '127.0.0.1'):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind((address, port))
        except OSError:
            return False
    return True


def start_server(adb, port, log):
    """Start the server in the foreground on all interfaces; returns the
    process.

    Every adb build supports `adb -a -P <port>` for listening on all
    interfaces.  No adb build accepts a hostname in a listen spec - not
    even 0.0.0.0 - so ADB_SERVER_SOCKET/-L cannot be used for this.
    """
    return subprocess.Popen([adb, '-a', '-P', str(port), 'nodaemon', 'server'],
                            stdout=log, stderr=log)


def log_tail(log_path, lines=15):
    """Last few lines of the server log, or '' if there is nothing."""
    with open(log_path, encoding='utf-8', errors='replace') as read:
        content = read.read().strip()
    if not content:
        return ''
    return '\n'.join(content.splitlines()[-lines:])


def local_addresses():
    """Best-effort list of this machine's IPv4 addresses a container could
    use as -H.
    """
    addresses = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET, socket.SOCK_STREAM):
            addresses.append(info[4][0])
    except OSError:
        pass
    # A UDP "connect" picks the interface that would route out; the socket
    # sends nothing, so any public destination works.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('8.8.8.8', 53))
            addresses.append(probe.getsockname()[0])
    except OSError:
        pass
    seen, unique = set(), []
    for address in addresses:
        if address not in seen and not address.startswith('127.'):
            seen.add(address)
            unique.append(address)
    return unique


def pick_adb(args):
    """Choose the adb to run the server with, downloading if needed."""
    adb = find_adb()
    version = adb_version(adb) if adb else None
    too_old = (adb is not None and not args.download and
               (version is None or version_tuple(version) < MIN_VERSION))
    if args.download or adb is None or too_old:
        if args.no_download:
            if too_old:
                print(f'warning: adb {version} is old; a current container '
                      'client will refuse to talk to it (use the download '
                      'default or match client versions)', file=sys.stderr)
        else:
            try:
                adb = download_platform_tools()
                version = adb_version(adb)
            except Exception as exc:  # - report and fall back
                print(f'warning: download failed ({exc}); using local adb',
                      file=sys.stderr)
                adb = find_adb()
    return adb, version


def start_first_port(adb, port, log, log_path):
    """Start the server, falling back to other ports on a bind conflict.

    Returns (process, port) on success or (None, last_port) on failure.
    """
    ports = [port] + [p for p in FALLBACK_PORTS if p != port]
    server = None
    for candidate in ports:
        log.seek(0)
        log.truncate()
        if not port_bindable(candidate):
            print(f'note: port {candidate} cannot be bound from this process '
                  '(held by another program or inside a Windows reserved '
                  'range); skipping.', file=sys.stderr)
            continue
        print(f'starting server on tcp:0.0.0.0:{candidate} ...')
        server = start_server(adb, candidate, log)
        time.sleep(1.5)
        if server.poll() is None:
            return server, candidate
        tail = log_tail(log_path)
        if tail:
            print(tail, file=sys.stderr)
        reason = SMARTSOCKET_REASON.search(tail)
        if reason:
            print(f'note: adb could not listen on port {candidate}: '
                  f'{reason.group(1).strip()}', file=sys.stderr)
        server.wait()
        server = None
    return None, ports[-1]


def run(args):  # noqa
    if args.check or args.stop:
        return check_or_stop(args)
    adb, version = pick_adb(args)
    if adb is None:
        print('error: no adb found; install platform-tools or the REV '
              'Hardware Client', file=sys.stderr)
        return 1
    print(f'adb: {adb}')
    print(f'adb version: {version}')
    # A server may already be listening on 127.0.0.1:5037 (started by any
    # plain adb call).  It would keep the port busy, so stop it first.
    stop_server(adb)
    if args.bind not in ('0.0.0.0', '*', ''):
        print(f'warning: adb cannot listen on a specific address ({args.bind}); '
              'listening on all interfaces instead.', file=sys.stderr)
    log_fd, log_path = tempfile.mkstemp(prefix='adb-server-', suffix='.log')
    log = os.fdopen(log_fd, 'w', encoding='utf-8', errors='replace')
    stopping = False
    try:
        server, port = start_first_port(adb, args.port, log, log_path)
        if server is None:
            print(f'error: could not start the adb server on ports '
                  f'{args.port}-{FALLBACK_PORTS[-1]}.', file=sys.stderr)
            print('If the notes above say "Only one usage" or "address '
                  'already in use", another adb server holds the ports - '
                  'usually the REV Hardware Client app.  Close it and try '
                  'again.', file=sys.stderr)
            print('If they say "permission denied", the ports are inside a '
                  'Windows reserved range: check with "netsh interface ipv4 '
                  'show excludedportrange protocol=tcp", then reboot, or '
                  'free the range with "net stop winnat" (as admin; it '
                  'restarts on demand).', file=sys.stderr)
            return 1
        if port != args.port:
            print(f'note: using port {port} instead of {args.port}.  In the '
                  f'container, run with ADB_PORT={port} (adb_devices.sh also '
                  'auto-detects it).')

        show_devices(adb, port)
        for address in local_addresses():
            print(f'from a container: adb -H {address} -P {port} devices')

        def request_stop(_signum, _frame):
            nonlocal stopping
            stopping = True

        for name in ('SIGINT', 'SIGTERM', 'SIGBREAK'):
            num = getattr(signal, name, None)
            if num is not None:
                try:
                    signal.signal(num, request_stop)
                except (OSError, ValueError):
                    pass
        while not stopping and server.poll() is None:
            time.sleep(0.25)
        if not stopping and server.returncode != 0:
            tail = log_tail(log_path)
            if tail:
                print(tail, file=sys.stderr)
            print(f'error: adb server exited with code {server.returncode}',
                  file=sys.stderr)
            return 1
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        if stopping or server is not None:
            # The nodaemon process is the server itself, so terminating it
            # stops the server; kill-server catches anything left over.
            if not args.keep:
                stop_server(adb, port)
                print('adb server stopped')
            elif server is not None:
                print(f'adb server left running on tcp:0.0.0.0:{port}')
        log.close()
        try:
            os.remove(log_path)
        except OSError:
            pass
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Run the Windows adb server on all interfaces so WSL '
        'distributions and containers can use it over TCP.  Runs until '
        'interrupted (Ctrl+C), then stops the server again.',
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--port', '-p', type=int, default=5037,
        help='TCP port for the adb server.  Default: 5037.  If the port is '
        'taken, 5038-5040 are tried automatically.')
    parser.add_argument(
        '--bind', '-b', default='0.0.0.0',
        help='Address to listen on.  Default and only useful value: 0.0.0.0 '
        '(all interfaces); adb cannot listen on a specific address.')
    parser.add_argument(
        '--check', action='store_true',
        help='Report whether an adb server is listening on the default port '
        'or any fallback port, then exit.  Exit status 0 means a server is '
        'running, 1 means none.')
    parser.add_argument(
        '--stop', action='store_true',
        help='Stop a running adb server (on the default port or any '
        'fallback port) and exit.  Exit status 0 if nothing was running or '
        'the server stopped, 1 on failure.')
    parser.add_argument(
        '--keep', action='store_true',
        help='Leave the server running when this script exits instead of '
        'stopping it.')
    parser.add_argument(
        '--download', action='store_true',
        help='Download the current platform-tools even if an adb is already '
        'available.')
    parser.add_argument(
        '--no-download', action='store_true',
        help='Never download; use the local adb even if it is old.')
    args = parser.parse_args()
    if args.check and args.stop:
        parser.error('--check and --stop cannot be used together')
    sys.exit(run(args))


if __name__ == '__main__':
    main()
