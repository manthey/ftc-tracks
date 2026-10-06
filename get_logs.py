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
import select
import shutil
import subprocess
import tempfile
import time

import pythoncom
import win32com.client
from pyffmpeg import FFmpeg


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
    """Convert a Windows MTP display path to an adb-readable path.

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
    """
    total = 0
    last = time.monotonic()
    proc = subprocess.Popen([adb, 'exec-out', 'cat', source],
                            stdout=subprocess.PIPE)
    fd = proc.stdout.fileno()
    try:
        with open(staged, 'wb') as out:
            while True:
                if select.select([fd], [], [], 0.1)[0]:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    out.write(chunk)
                    total += len(chunk)
                    last = time.monotonic()
                elif proc.poll() is not None:
                    break
                elif time.monotonic() - last >= stall:
                    print(f'stalled reading {source}')
                    break
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
    return total


def adb_pull(adb, source, dest, is_dir):
    os.makedirs(dest, exist_ok=True)
    parent = os.path.dirname(os.path.abspath(dest)) or os.curdir
    tmp = tempfile.mkdtemp(prefix='.get_logs-', dir=parent)
    try:
        if is_dir:
            # adb pull of a directory creates <tmp>/<basename>.
            result = subprocess.run([adb, 'pull', source, tmp])
            pulled = os.path.join(tmp, os.path.basename(source.rstrip('/')))
            if result.returncode != 0 or not os.path.isdir(pulled):
                print(f'adb pull failed for {source}')
                return False
            for root, _dirs, files in os.walk(pulled):
                rel = os.path.relpath(root, pulled)
                outdir = dest if rel == os.curdir else os.path.join(dest, rel)
                os.makedirs(outdir, exist_ok=True)
                for name in sorted(files):
                    final = os.path.join(outdir, name)
                    if os.path.exists(final):
                        continue
                    print(name)
                    os.replace(os.path.join(root, name), final)
        else:
            final = os.path.join(dest, os.path.basename(source.rstrip('/')))
            if os.path.exists(final):
                return True
            staged = os.path.join(tmp, os.path.basename(source.rstrip('/')))
            if not adb_pull_through_cat(adb, source, staged):
                print(f'adb pull failed for {source}')
                return False
            print(os.path.basename(final))
            os.replace(staged, final)
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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


def mtp_copy(shell, source, dest):
    """Copy every item in an MTP folder into dest, skipping existing files."""
    os.makedirs(dest, exist_ok=True)
    folder = shell.Namespace(os.path.abspath(dest))
    for _itemname, item in sorted((item.Name, item) for item in source.Items()):
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
    if not adb_pull(adb, source, args.dest, is_dir=True):
        return False
    if args.video:
        video_source = android_path(args.source.replace('telemetry', 'videos'))
        if not adb_pull(adb, video_source, os.path.join(args.dest, 'videos'), is_dir=True):
            return False
    return True


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
        else:
            com_read(args)
    if args.convert:
        video_dir = os.path.join(args.dest, 'videos')
        for filename in sorted(os.listdir(video_dir)):
            if filename.endswith('.mjpeg') or filename.endswith('.avi'):
                input_path = os.path.join(video_dir, filename)
                output_path = os.path.join(video_dir, os.path.splitext(filename)[0] + '.mp4')
                if not os.path.exists(output_path):
                    print(f'Converting {filename} to MP4...')
                    mjpeg_to_mp4(input_path, output_path)


if __name__ == '__main__':
    main()
