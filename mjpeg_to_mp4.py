# /// script
# requires-python = ">=3.9"
# dependencies = [
#   "pyffmpeg",
# ]
# ///

import argparse
import os
import subprocess
import tempfile
from pyffmpeg import FFmpeg


def extract_frames(path, tmp):
    frames = []
    times = []
    chunk = 65536
    with open(path, 'rb') as fptr:
        data = b''
        offset = 0
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
                except:
                    t = 0
            dest = os.path.join(tmp, f'{len(frames):08d}.jpg')
            open(dest, 'wb').write(frame)
            frames.append(dest)
            times.append(t)
    return frames, times


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('output')
    args = parser.parse_args()
    ffmpeg = FFmpeg().get_ffmpeg_bin()
    with tempfile.TemporaryDirectory() as tmp:
        frames, times = extract_frames(args.input, tmp)
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
        subprocess.run([
            ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-i', concat,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
            '-pix_fmt', 'yuv420p', '-vsync', 'vfr', args.output
        ], check=True)

if __name__ == '__main__':
    main()
