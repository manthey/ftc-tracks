#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pywin32",
#     "pyffmpeg",
# ]
# ///
import argparse
import os
import queue
import shlex
import shutil
import subprocess
import tempfile
import threading
import time

import pythoncom
import win32com.client
from pyffmpeg import FFmpeg

# Device mtimes below this are treated as bogus (a Control Hub without a
# valid clock stamps files at epoch 0 plus a little uptime, i.e. dates in
# 1969/1970) and are not copied to the local file.  1990 leaves decades of
# margin over any real recording while covering any plausible uptime.
MIN_PLAUSIBLE_MTIME = 631152000  # 1990-01-01 00:00 UTC


def find_adb():
    """Return a usable adb executable, or None if adb is unavailable.

    Prefers the copy bundled with the REV Hardware Client, then whatever is
    on PATH.  Confirms the executable can start its server before trusting it.
    """
    for adb in [
        'C:\\Program Files (x86)\\REV Robotics\\REV Hardware Client\\android-tools\\adb.exe',
        'C:\\Program Files\\REV Robotics\\REV Hardware Client\\android-tools\\adb.exe',
        'adb',
    ]:
        try:
            if subprocess.run([adb, 'start-server'], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL).returncode == 0:
                return adb
        except OSError:
            continue
    return None


def mtp_scan():
    adb = find_adb()
    if adb is None:
        return
    path = '/sdcard/FIRST/telemetry'
    cmd = [adb, 'shell', 'am', 'broadcast', '-a',
           'android.intent.action.MEDIA_SCANNER_SCAN_WITH_PATH', '--es',
           'android.intent.extra.PATH', path]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('mtp rescan requested')


def android_path(source):
    r"""Convert a Windows MTP display path to an adb-readable path.

    MTP shows the device as e.g. "Control Hub v1.0\\Internal shared
    storage\\FIRST\\telemetry"; adb needs /sdcard/FIRST/telemetry.  The first
    component is the device's MTP name and is dropped; "Internal shared
    storage" maps to the removable-volume mount point used by Control Hubs.
    """
    parts = source.replace('\\', '/').split('/')
    if parts and parts[0] == '':
        # Already an Android path such as /sdcard/FIRST/telemetry.
        return '/' + '/'.join(p for p in parts if p)
    i = next((n for n, p in enumerate(parts)
              if p.lower() == 'internal shared storage'), None)
    if i is None:
        # No MTP volume name; treat the whole path as being under /sdcard.
        return '/sdcard/' + '/'.join(p for p in parts if p)
    tail = [p for p in parts[i + 1:] if p]
    return '/sdcard/' + '/'.join(tail)


def adb_pull_through_cat(adb, source, staged, stall=5.0):
    """Stream a single file to staged via adb, tolerating read stalls.

    adb pull can block on a specific file for minutes when its on-disk state
    was never cleanly closed (a power cycle or code push skips the close).
    Rather than wait, read the bytes over adb exec-out and abandon the read
    after `stall` seconds with no data.  Whatever landed is the best we will
    ever get and is treated as complete.  Returns the number of bytes written.

    The read runs in a helper thread and the main loop waits on a queue with a
    timeout, because select() on Windows only supports sockets and would fail
    immediately on a subprocess pipe.
    """
    total = 0
    last = time.monotonic()
    # adb joins its arguments and passes them to the device shell, so the path
    # must be quoted here or names with spaces or shell punctuation break.
    # Discard remote stderr: over a legacy (non shell-protocol) connection it
    # is merged into stdout and would otherwise be stored as file content.
    # start_new_session lets the kill below take out any descendants holding
    # the pipe open; it is ignored on Windows, where the direct kill suffices.
    proc = subprocess.Popen(
        [adb, 'exec-out', f'cat {shlex.quote(source)} 2>/dev/null'],
        stdout=subprocess.PIPE, start_new_session=True)
    chunks = queue.Queue()

    def reader():
        try:
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                chunks.put(chunk)
        except OSError:
            pass
        finally:
            chunks.put(None)
            # The reader owns the pipe: closing it here cannot deadlock on the
            # reader's own lock, unlike a close from the main thread.
            proc.stdout.close()

    threading.Thread(target=reader, daemon=True).start()
    try:
        with open(staged, 'wb') as out:
            while True:
                try:
                    chunk = chunks.get(timeout=0.1)
                except queue.Empty:
                    if proc.poll() is not None:
                        break
                    if time.monotonic() - last >= stall:
                        print(f'stalled reading {source}')
                        break
                    continue
                if chunk is None:
                    break
                out.write(chunk)
                total += len(chunk)
                last = time.monotonic()
    finally:
        if proc.poll() is None:
            try:
                # 9 is SIGKILL; kill the whole session in case a descendant
                # (not adb itself) is the one holding the pipe open.
                os.killpg(os.getpgid(proc.pid), 9)
            except (AttributeError, OSError):
                proc.kill()
            proc.wait()
    return total


def adb_stat(adb, source):
    """Return (size, mtime) of a device file; either may be None if the stat
    failed.
    """
    result = subprocess.run([adb, 'shell', 'stat', '-c', shlex.quote('%s %Y'),
                             shlex.quote(source)],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True)
    parts = result.stdout.split()
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None, None


def adb_pull(adb, source, dest):
    """Pull a single device file into dest, skipping it if already present."""
    os.makedirs(dest, exist_ok=True)
    final = os.path.join(dest, os.path.basename(source.rstrip('/')))
    if os.path.exists(final):
        return True
    parent = os.path.dirname(os.path.abspath(dest)) or os.curdir
    tmp = tempfile.mkdtemp(prefix='.get_logs-', dir=parent)
    try:
        staged = os.path.join(tmp, os.path.basename(source.rstrip('/')))
        total = adb_pull_through_cat(adb, source, staged)
        size, mtime = adb_stat(adb, source)
        # A zero-byte result is either a genuinely empty device file or a
        # failed read; the device-side size tells them apart.  (Legacy
        # exec-out connections do not propagate the remote exit code.)
        if total == 0 and size != 0:
            print(f'adb pull failed for {source}')
            return False
        print(os.path.basename(final))
        os.replace(staged, final)
        if mtime is not None and mtime >= MIN_PLAUSIBLE_MTIME:
            # A Control Hub without a valid clock stamps files at epoch 0
            # plus a little uptime (1969/1970 dates); those carry no
            # information, so the pull time is left in place instead.
            try:
                os.utime(final, (mtime, mtime))
            except OSError:
                pass
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def adb_pull_dir(adb, source, dest):
    """Pull the files of a flat device directory into dest, skipping files
    that already exist locally.

    adb pull of a directory has no incremental mode: it re-transfers every
    file on every run, which over a robot's WiFi link means hundreds of
    megabytes of copying even when nothing is new.  Listing the directory
    first and pulling only the missing files avoids that, and routes each
    file through the stall-tolerant single-file path.  Subdirectories are
    reported and skipped.
    """
    os.makedirs(dest, exist_ok=True)
    result = subprocess.run([adb, 'shell', 'ls', '-1pA', source],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True)
    # With -p, ls appends '/' to directories; with -A it also lists dotfiles.
    # Error lines such as "ls: ...: No such file or directory" carry no name.
    names = []
    errored = False
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.endswith('/'):
            print(f'skipping subdirectory {line}')
        elif line.startswith('ls:'):
            errored = True
        else:
            names.append(os.path.basename(line))
    if not names:
        if errored:
            print(f'adb pull failed for {source}')
            return False
        return True  # an empty directory has nothing to pull
    return adb_pull_files(adb, [source.rstrip('/') + '/' + name
                                for name in sorted(names)], dest)


def extract_frames(path, tmp):
    frames = []
    times = []
    chunk = 65536
    with open(path, 'rb') as fptr:
        data = b''
        while True:
            while b'\xff\xd8' not in data:
                oldlen = len(data)
                data += fptr.read(chunk)
                if len(data) == oldlen:
                    break
            s = data.find(b'\xff\xd8')
            if s == -1:
                break
            data = data[s:]
            while b'\xff\xd9' not in data:
                oldlen = len(data)
                data += fptr.read(chunk)
                if len(data) == oldlen:
                    break
            e = data.find(b'\xff\xd9')
            if e == -1:
                break
            e += 2
            frame = data[:e]
            data = data[e:]
            p = frame.find(b'\xff\xfe')
            t = 0
            if p != -1:
                l = int.from_bytes(frame[p + 2:p + 4], 'big')
                try:
                    t = int(frame[p + 4:p + 2 + l].decode('utf8').strip())
                except Exception:
                    t = 0
            dest = os.path.join(tmp, f'{len(frames):08d}.jpg')
            with open(dest, 'wb') as f:
                f.write(frame)
            frames.append(dest)
            times.append(t)
    return frames, times


def mjpeg_to_mp4(input_path, output_path):
    ffmpeg_bin = FFmpeg().get_ffmpeg_bin()
    with tempfile.TemporaryDirectory() as tmp:
        frames, times = extract_frames(input_path, tmp)
        concat = os.path.join(tmp, 'concat.txt')
        with open(concat, 'w') as out:
            out.write('ffconcat version 1.0\n')
            for idx, path in enumerate(frames):
                path = path.replace('\\', '/')
                out.write(f"file '{path}'\n")
                if idx < len(times) - 1:
                    d = (times[idx + 1] - times[idx]) / 1000
                else:
                    d = (times[-1] - times[-2]) / 1000
                if d <= 0:
                    d = 0.033333
                out.write(f'duration {d:.6f}\n')
            path = frames[-1].replace('\\', '/')
            out.write(f"file '{path}'\n")
            out.write('duration 0.016666\n')
        subprocess.run([
            ffmpeg_bin, '-y', '-f', 'concat', '-safe', '0', '-i', concat,
            '-vf', 'fps=30,colorchannelmixer=0:0:1:0:0:1:0:0:1:0:0',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
            output_path,
        ], check=True)


def mtp_folder(shell, path, label):
    """Navigate the MTP namespace to path, returning the folder or None."""
    folder = shell.Namespace(17)
    for part in path.replace('\\', '/').split('/'):
        found = False
        for item in folder.Items():
            if item.Name == part:
                folder = item.GetFolder
                found = True
                break
        if not found:
            print(f'Failed to find path component "{part}" in "{label}"')
            return None
    return folder


def mtp_copy(shell, source, dest, suffix=None):
    """Copy items in an MTP folder into dest, skipping existing files.

    With suffix set, only items whose name ends with suffix are copied.
    """
    os.makedirs(dest, exist_ok=True)
    folder = shell.Namespace(os.path.abspath(dest))
    for _itemname, item in sorted((item.Name, item) for item in source.Items()):
        if suffix is not None and not item.Name.lower().endswith(suffix):
            continue
        dest_path = os.path.join(dest, item.Name)
        if os.path.exists(dest_path):
            continue
        print(item.Name)
        folder.CopyHere(item, 4 | 16 | 512 | 1024)


def com_read(args):
    """Fallback copy path that uses the Windows COM / MTP shell."""
    mtp_scan()
    pythoncom.CoInitialize()
    try:
        shell = win32com.client.Dispatch('Shell.Application')
        folder = mtp_folder(shell, args.source, args.source)
        if folder is None:
            return
        mtp_copy(shell, folder, args.dest)
        if args.video:
            video_source = args.source.replace('telemetry', 'videos')
            folder = mtp_folder(shell, video_source, video_source)
            if folder is None:
                return
            mtp_copy(shell, folder, os.path.join(args.dest, 'videos'))
    finally:
        pythoncom.CoUninitialize()


def adb_read(adb, args):
    """Preferred copy path that uses adb, avoiding MTP staleness entirely."""
    source = android_path(args.source)
    if not adb_pull_dir(adb, source, args.dest):
        return False
    if args.video:
        video_source = android_path(args.source.replace('telemetry', 'videos'))
        if not adb_pull_dir(adb, video_source, os.path.join(args.dest, 'videos')):
            return False
    return True


def first_root_path(source):
    """Return the device path of the FIRST storage folder that contains the
    given telemetry path.  Robot configuration files live there as <name>.xml
    (see AppUtil.CONFIG_FILES_DIR in the FTC SDK).
    """
    parts = source.rstrip('/').split('/')
    while parts and parts[-1] in ('', '.'):
        parts.pop()
    return '/'.join(parts[:-1])


def adb_pull_files(adb, paths, dest):
    """Pull individual device files into dest, skipping existing files."""
    ok = True
    for source in paths:
        if not adb_pull(adb, source, dest):
            ok = False
    return ok


def adb_pull_configs(adb, args):
    """Pull the robot configuration xml files from the FIRST folder.

    The FTC SDK stores configuration files as <name>.xml directly in
    AppUtil.CONFIG_FILES_DIR; there is no settings subfolder on shared
    storage (app settings live in SharedPreferences).
    """
    root = first_root_path(android_path(args.source))
    dest = os.path.join(args.dest, 'configs')
    os.makedirs(dest, exist_ok=True)
    result = subprocess.run([adb, 'shell', 'ls', '-1', root + '/*.xml'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True)
    # The device shell expands the glob, so ls reports full device paths.
    # Error lines such as "ls: ...: No such file or directory" are ignored.
    names = sorted({os.path.basename(line.strip())
                    for line in result.stdout.splitlines()
                    if line.strip().endswith('.xml') and
                    not line.strip().startswith('ls:')})
    if not names:
        print(f'no configuration xml files found in {root}')
        return False
    return adb_pull_files(adb, [root + '/' + name for name in names], dest)


def com_read_configs(args):
    """Fallback copy of the configuration xml files via the MTP shell.
    """
    mtp_scan()
    pythoncom.CoInitialize()
    try:
        shell = win32com.client.Dispatch('Shell.Application')
        first = first_root_path(args.source.replace('\\', '/'))
        folder = mtp_folder(shell, first, first)
        if folder is None:
            return
        mtp_copy(shell, folder, os.path.join(args.dest, 'configs'), suffix='.xml')
    finally:
        pythoncom.CoUninitialize()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--source', '--src',
        default='Control Hub v1.0\\Internal shared storage\\FIRST\\telemetry',
        help='Path on device.  Default is "Control Hub v1.0\\Internal '
        'shared storage\\FIRST\\telemetry"',
    )
    parser.add_argument(
        '--dest', default='C:\\temp\\telemetry',
        help='Local destination path.  Default is "C:\\temp\\telemetry"')
    parser.add_argument(
        '--video', '-v', action='store_true',
        help='Also pull videos.')
    parser.add_argument(
        '--config', '-f', action='store_true',
        help='Also back up the robot configuration xml files and the '
        'settings folder from the FIRST storage.')
    parser.add_argument(
        '--convert', '-c', action='store_true',
        help='Convert pulled videos.')
    parser.add_argument(
        '--noread', action='store_true',
        help='Skip reading from the robot.')
    args = parser.parse_args()
    if args.convert and not args.video:
        print('error: --convert requires --video')
        return
    if not args.noread:
        adb = find_adb()
        if adb is not None:
            if not adb_read(adb, args):
                print('error: adb copy failed')
            if args.config and not adb_pull_configs(adb, args):
                print('error: configuration copy failed')
        else:
            com_read(args)
            if args.config:
                com_read_configs(args)
    if args.convert:
        video_dir = os.path.join(args.dest, 'videos')
        for filename in sorted(os.listdir(video_dir)):
            if filename.endswith(('.mjpeg', '.avi')):
                input_path = os.path.join(video_dir, filename)
                output_path = os.path.join(video_dir, os.path.splitext(filename)[0] + '.mp4')
                if not os.path.exists(output_path):
                    print(f'Converting {filename} to MP4...')
                    mjpeg_to_mp4(input_path, output_path)


if __name__ == '__main__':
    main()
