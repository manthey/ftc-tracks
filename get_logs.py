import argparse
import os
import subprocess
import sys
import tempfile

import pythoncom
import win32com.client
from pyffmpeg import FFmpeg


def mtp_scan():
    adb = 'C:\\Program Files (x86)\\REV Robotics\\REV Hardware Client\\android-tools\\adb.exe'
    path = '/Internal shared storage/FIRST/telemetry'
    cmd = [adb, 'shell', 'am', 'broadcast', '-a',
           'android.intent.action.MEDIA_SCANNER_SCAN_WITH_PATH', '--es',
           'android.intent.extra.PATH', path]
    try:
        started = subprocess.run(
            [adb, 'start-server'], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL).returncode == 0
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print('mtp rescan requested')
        if started:
            subprocess.run(
                [adb, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


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
            out.write(f'duration 0.016666\n')
        subprocess.run([
            ffmpeg_bin, '-y', '-f', 'concat', '-safe', '0', '-i', concat,
            '-vf', 'fps=30',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
            output_path
        ], check=True)


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
    args = parser.parse_args()
    if args.convert and not args.video:
        print('error: --convert requires --video')
        return
    mtp_scan()
    pythoncom.CoInitialize()
    shell = win32com.client.Dispatch('Shell.Application')
    folder = shell.Namespace(17)
    for part in args.source.replace('\\', '/').split('/'):
        found = False
        for item in folder.Items():
            if item.Name == part:
                folder = item.GetFolder
                found = True
                break
        if not found:
            print(f'Failed to find path component "{part}" in "{args.source}"')
            pythoncom.CoUninitialize()
            return
    os.makedirs(args.dest, exist_ok=True)
    dest = shell.Namespace(os.path.abspath(args.dest))
    items = sorted((item.Name, item) for item in folder.Items())
    for itemname, item in items:
        dest_path = os.path.join(args.dest, item.Name)
        if os.path.exists(dest_path):
            continue
        print(item.Name)
        dest.CopyHere(item, 4 | 16 | 512 | 1024)
    video_source = args.source.replace('telemetry', 'videos')
    if args.video:
        folder = shell.Namespace(17)
        for part in video_source.replace('\\', '/').split('/'):
            found = False
            for item in folder.Items():
                if item.Name == part:
                    folder = item.GetFolder
                    found = True
                    break
            if not found:
                print(f'Failed to find path component "{part}" in "{video_source}"')
                pythoncom.CoUninitialize()
                return
        video_dest = os.path.join(args.dest, 'videos')
        os.makedirs(video_dest, exist_ok=True)
        dest = shell.Namespace(os.path.abspath(video_dest))
        items = sorted((item.Name, item) for item in folder.Items())
        for itemname, item in items:
            dest_path = os.path.join(video_dest, item.Name)
            if os.path.exists(dest_path):
                continue
            print(item.Name)
            dest.CopyHere(item, 4 | 16 | 512 | 1024)
    pythoncom.CoUninitialize()
    if args.convert:
        video_dir = os.path.join(args.dest, 'videos')
        for filename in os.listdir(video_dir):
            if filename.endswith('.mjpeg') or filename.endswith('.avi'):
                input_path = os.path.join(video_dir, filename)
                output_path = os.path.join(video_dir, os.path.splitext(filename)[0] + '.mp4')
                print(f'Converting {filename} to MP4...')
                mjpeg_to_mp4(input_path, output_path)


if __name__ == '__main__':
    main()
