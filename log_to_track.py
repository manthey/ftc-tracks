import argparse
import csv
import math
import os
import re
import sys


AprilTags = {
    20: {'x': -58.373, 'y': -55.643, 'z': 29.5, 'h': 54.050},
    24: {'x': -58.373, 'y': 55.643, 'z': 29.5, 'h': -54.050},
    # 21: {'x': -73, 'y': 0, 'z': 24, 'h': 0},
    # 22: {'x': -73, 'y': 0, 'z': 24, 'h': 0},
    # 23: {'x': -73, 'y': 0, 'z': 24, 'h': 0},
}

def april_adjust(basepose, repose, april, tagid, rbe):
    if basepose is None:
        return
    try:
        rbe = [float(p) for p in rbe.split()[:3]]
        id = int(tagid.split()[1])
        tag = AprilTags[id]
    except Exception:
        return
    # given RBE ad XYZH, camera is at
    # d = R cos(E)
    # camH = H - B + 180
    # camX = X - d cos(H + B)
    # camY = Y - d sin(H + B)
    # camZ = Z - r sin(E)
    # camera offset is cx, cy, cz, ch
    # robot is at
    # rH = camH - ch
    # rx = camX - cx * sin(rH) - cy * cos(rH)
    # ry = camY + cx * cos(rH) - cy * sin(rH)
    dist = rbe[0] * math.cos(rbe[2] * math.pi / 180)
    netH = repose[2] - april[2] + rbe[1] - 180
    # we need something else for camera angle; RBE doesn't include enough
    camX = tag['x'] + dist * math.cos(netH * math.pi / 180)
    camY = tag['y'] + dist * math.sin(netH * math.pi / 180)
    camZ = tag['z'] - rbe[0] * math.sin(rbe[2] * math.pi / 180)
    # rh = camH - april[2]
    rh = repose[2]
    rx = camX - april[0] * math.sin(rh * math.pi / 180) - april[1] * math.cos(rh * math.pi / 180)
    ry = camY + april[0] * math.cos(rh * math.pi / 180) - april[1] * math.sin(rh * math.pi / 180)
    if abs(rx) > 72 or abs(ry) > 72:
        return
    if ((repose[0] - rx) ** 2 + (repose[1] - ry) ** 2) ** 0.5 > april[5]:
        return
    basepose[0] -= (repose[0] - rx) * april[4]
    basepose[1] -= (repose[1] - ry) * april[4]


def logs_to_tracks(
        logdir, output, runs, realign=False, oldest=False, useTarget=False,
        showIndexer=False, april=None, suffix=None):  # noqa
    out = ["""Setting,fixedTimes,true
Setting,stopTime,0
Setting,showText,false
Setting,showArrows,false
Robot,0,https://manthey.github.io/ftc-tracks/decodebot33dpi.png,8.25,8.75,8.25,8.75
Part,0,https://manthey.github.io/ftc-tracks/indexer5inraddark.png,5,5,5,5
Field,https://manthey.github.io/ftc-tracks/decode.png,72,72,72,72"""]
    tracks = {}
    lastpose = None
    for file in sorted(os.listdir(logdir), reverse=False):
        if not file.endswith('csv'):
            continue
        try:
            match = re.match(r'^[^_]+_(?P<number>\d{4})_(?P<name>.+)\.csv', file)
            if match is None:
                match = re.match(r'^[^_]+_(\d{4})_(?P<name>[^_]+)_(?P<number>\d+)\.', file)
            number = int(match.group('number'))
            name = match.group('name')
        except Exception:
            continue
        track = []
        basepose = None
        if lastpose is not None and 'Auto' not in name and realign:
            basepose = list(lastpose)
        startpose = None
        t0 = None
        t = 0
        indexerPos = None
        with open(os.path.join(logdir, file), 'r', newline='', encoding='utf-8') as fptr:
            sys.stdout.write(file)
            sys.stdout.flush()
            reader = csv.reader(fptr)
            recpose = [None, None, None, 0]
            lastline = None
            for line in reader:
                if len(line) == 5 and line[3] == 'loop time':
                    if recpose[0] is not None:
                        track.append((t - t0, recpose[0], recpose[1], recpose[2], recpose[3]))
                    t = float(line[0])
                    if t0 is None:
                        t0 = t
                if len(line) == 5 and line[3] == (
                        'Field position' if not useTarget else 'Target position'):
                    x, y, h = (float(v.strip('"')) for v in line[4].strip('"').split())
                    if april and basepose is None:
                        basepose = [x, y, h]
                    if startpose is None and basepose is not None:
                        startpose = (x, y, h, (basepose[2] - h) * math.pi / 180)
                        sys.stdout.write(' - Realigning')
                        sys.stdout.flush()
                    if basepose is not None:
                        x1 = x - startpose[0]
                        y1 = y - startpose[1]
                        h1 = h - startpose[2]
                        x2 = x1 * math.cos(startpose[3]) - y1 * math.sin(startpose[3])
                        y2 = x1 * math.sin(startpose[3]) + y1 * math.cos(startpose[3])
                        x, y, h = round(x2 + basepose[0], 2), round(y2 + basepose[1], 2), round(
                            h1 + basepose[2], 2)
                    recpose[0:3] = [x, y, h]
                    lastpose = (x, y, h)
                    if abs(x) > 72 or abs(y) > 72:
                        lastpose = None
                if len(line) == 5 and line[3] == 'Indexer Position':
                    recpose[3] = float(line[4])
                if april and len(line) == 5 and line[3] == 'AprilTag' and lastline and lastline[3] == 'RBE':
                    april_adjust(basepose, recpose, april, line[4], lastline[4])
                lastline = line
            if recpose[0] is not None and len(track) and t - t0 != track[-1][0]:
                track.append((t - t0, recpose[0], recpose[1], recpose[2], recpose[3]))
        sys.stdout.write(f' - {t - t0 if t0 is not None else 0:4.2f}\n')
        if len(track) < 2:
            continue
        tracks[number] = {'name': name, 'track': track, 'number': number}
    for number in sorted(tracks, reverse=not oldest):
        name = tracks[number]['name']
        track = tracks[number]['track']
        skip = runs and number not in runs
        if not skip:
            sys.stderr.write(f'{number:3d} {track[-1][0]:7.3f} {name} {"- skipped" if skip else ""}\n')
        if skip:
            continue
        out.append(f'Path,{name}-{number}{suffix or ""}')
        last = 0
        for idx, (t, x, y, h, ip) in enumerate(track):
            if (idx and idx != len(track) - 1 and
                    abs(x - track[last][1]) <= 0.02 and
                    abs(y - track[last][2]) <= 0.02 and
                    abs(h - track[last][3]) <= 0.05 and
                    abs(ip - track[last][4]) <= 0.1):
                continue
            out.append(f'P{idx},{x},{y},{h},,,{t - track[last][0]:.6f}'.rstrip('0'))
            if showIndexer:
                out[-1] += f',,0:0:1.75:{-ip:.2f}'
            last = idx
    if output:
        open(output, 'w').write('\n'.join(out) + '\n')


def logs_to_excel(logdir, excelpath, csvpath, runs, stepSummary):  # noqa
    import openpyxl

    tracks = {}
    keyTimes = {}
    for file in os.listdir(logdir):
        if not file.endswith('csv'):
            continue
        try:
            match = re.match(r'^[^_]+_(?P<number>\d{4})_(?P<name>.+)\.csv', file)
            if match is None:
                match = re.match(r'^[^_]+_(\d{4})_(?P<name>[^_]+)_(?P<number>\d+)\.', file)
            number = int(match.group('number') or match.group('number2'))
            name = match.group('name')
        except Exception:
            continue
        track = []
        t0 = None
        state = None
        keys = {}
        skip = runs and number not in runs
        with open(os.path.join(logdir, file), 'r', newline='', encoding='utf-8') as fptr:
            reader = csv.reader(fptr)
            lastT = 0
            lastLoopT = None
            lastKey = None
            for line in reader:
                if len(line) < 5:
                    continue
                key = line[3]
                if key == 'loop time':
                    if state is not None:
                        track.append(state)
                        state = state.copy()
                    else:
                        state = {}
                        lastLoopT = None
                    t = float(line[0])
                    if t0 is None:
                        t0 = t
                    keys['time'] = True
                    state['time'] = t - t0
                    keys['count'] = True
                    state['count'] = len(track)
                if state is None:
                    continue
                if key not in keyTimes:
                    keyTimes[key] = []
                if lastKey is not None and not skip:
                    keyTimes[key].append(float(line[0]) - lastT)
                lastT = float(line[0])
                if key == 'loop time' and not skip:
                    if lastLoopT is not None:
                        if 'loop' not in keyTimes:
                            keyTimes['loop'] = []
                        keyTimes['loop'].append(lastT - lastLoopT)
                    lastLoopT = lastT
                lastKey = key
                nums = None
                try:
                    if not re.search(r'[a-zA-Z][0-9+\-.]', line[4]):
                        nums = [float(v) for v in re.sub(
                            r'[^0-9+\-.]+', ' ', line[4]).strip().split()]
                except Exception:
                    pass
                if nums is None or len(nums) <= 1:
                    keys[key] = True
                    state[key] = line[4] if nums is None or len(nums) < 1 else nums[0]
                else:
                    for idx, v in enumerate(nums):
                        nkey = f'{key} {idx + 1}'
                        keys[nkey] = True
                        state[nkey] = v
            if state is not None:
                track.append(state)
        if len(track) < 2 or skip:
            continue
        tracks[number] = {'name': name, 'track': track, 'number': number, 'keys': keys}
    if excelpath:
        wb = openpyxl.Workbook()
        for widx, number in enumerate(sorted(tracks, reverse=True)):
            name = tracks[number]['name']
            track = tracks[number]['track']
            keys = tracks[number]['keys']
            if not widx:
                ws = wb.active
                ws.title = name
            else:
                ws = wb.create_sheet(name)
            ws.append(list(keys.keys()))
            for row in track:
                ws.append([row.get(k) for k in keys])
        wb.save(excelpath)
    if csvpath:
        for number in sorted(tracks, reverse=True):
            name = tracks[number]['name']
            track = tracks[number]['track']
            keys = tracks[number]['keys']
            trackcsv = f'{csvpath.rsplit(".", 1)[0]}_{number}_{name}.{csvpath.rsplit(".", 1)[1]}'
            with open(trackcsv, mode='w', newline='') as fptr:
                writer = csv.writer(fptr)
                writer.writerow(list(keys.keys()))
                for row in track:
                    writer.writerow([row.get(k) for k in keys])
    if stepSummary:
        if stepSummary == 'mean':
            keyTimes = {
                k: sum(keyTimes[k]) / len(keyTimes[k])
                for k in keyTimes if len(keyTimes[k]) >= 10}
        elif stepSummary == 'median':
            keyTimes = {
                k: sorted(keyTimes[k])[len(keyTimes[k]) // 2]
                for k in keyTimes if len(keyTimes[k]) >= 10}
        elif stepSummary in {'low', 'high'}:
            keyTimes = {
                k: sorted(keyTimes[k], reverse=stepSummary == 'high')[0]
                for k in keyTimes if len(keyTimes[k]) >= 10}
        elif stepSummary in {'quartile1', 'quartile3'}:
            keyTimes = {
                k: sorted(keyTimes[k], reverse=stepSummary == 'quartile3')[len(keyTimes[k]) // 4]
                for k in keyTimes if len(keyTimes[k]) >= 10}
        print(f'Summary: {stepSummary}')
        for k, v in sorted(keyTimes.items(), key=lambda x: -x[1]):
            print(f'{v:7.5f}s {k}')
        print(f'{sum(v for k, v in keyTimes.items() if k != "loop"):7.5f}s')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Convert a diretcory of telemetry logs into a track record')
    parser.add_argument('logdir', help='Log directory')
    parser.add_argument('-o', '--output', help='Track file path')
    parser.add_argument(
        '--realign', action='store_true',
        help='Realign teleop paths to previous path')
    parser.add_argument(
        '--oldest', action='store_true',
        help='Show oldest tracks first')
    parser.add_argument('-x', '--excel', help='Excel file output path')
    parser.add_argument(
        '-c', '--csv',
        help='Base output csv path -- this will have the run numb er added to '
        'it before the extension.')
    parser.add_argument(
        '-r', '--runs',
        help='Comma-separated list of run numbers to process.  Use start-end for inclusive ranges.')
    parser.add_argument(
        '--target', action='store_true', help='Use the target position, not the field position.')
    parser.add_argument(
        '--indexer', action='store_true', help='Add indexer part to the track.')
    parser.add_argument(
        '-s', '--step', choices=['mean', 'median', 'low', 'high', 'quartile1', 'quartile3'],
        help='Print a summary of how log different steps take.')
    parser.add_argument(
        '--april',
        help='Simulate correction based on april tags.  Camera position on '
        'the robot right-offset, forward-offset, bearing, elevation, xy '
        'correction factor, bearing correction factor.')
    parser.add_argument(
        '--suffix', help='Add this to each path name')
    opts = parser.parse_args()
    runs = None
    if opts.runs:
        runs = {n for p in opts.runs.split(',') for n in (
            range(int(p.split('-')[0]), int(p.split('-')[-1]) + 1)
            if '-' in p else [int(p)])}
    if opts.april:
        opts.april = [float(p) for p in opts.april.split(',')]
    logs_to_tracks(opts.logdir, opts.output, runs, opts.realign, opts.oldest, opts.target, opts.indexer, opts.april, opts.suffix)
    logs_to_excel(opts.logdir, opts.excel, opts.csv, runs, opts.step)
