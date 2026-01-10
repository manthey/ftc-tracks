import argparse
import csv
import math
import os
import re
import sys


def logs_to_tracks(logdir, output, runs, realign=False, oldest=False):  # noqa
    out = ["""Setting,fixedTimes,true
Setting,stopTime,0
Setting,showText,false
Setting,showArrows,false
Robot,0,https://manthey.github.io/ftc-tracks/decodebot33dpi.png,8.25,8.75,8.25,8.75
Field,https://manthey.github.io/ftc-tracks/decode.png,72,72,72,72"""]
    tracks = {}
    lastpose = None
    for file in sorted(os.listdir(logdir), reverse=False):
        if not file.endswith('csv'):
            continue
        try:
            match = re.match(r'^[^_]+_((?P<number>\d{4})|\d{3})_(?P<name>[^_]+)(|_(?P<number2>\d+))\.', file)
            number = int(match.group('number') or match.group('number2'))
            name = match.group('name')
        except Exception:
            continue
        track = []
        basepose = None
        if lastpose is not None and 'Auto' not in name and realign:
            basepose = tuple(list(lastpose))
        startpose = None
        t0 = None
        with open(os.path.join(logdir, file), 'r', newline='', encoding='utf-8') as fptr:
            print(file)
            reader = csv.reader(fptr)
            for line in reader:
                if len(line) == 5 and line[3] == 'Field position':
                    t = float(line[0])
                    if t0 is None:
                        t0 = t
                    x, y, h = (float(v.strip('"')) for v in line[4].strip('"').split())
                    if startpose is None and basepose is not None:
                        startpose = (x, y, h, (basepose[2] - h) * math.pi / 180)
                        print('Realigning')
                    if basepose is not None:
                        x1 = x - startpose[0]
                        y1 = y - startpose[1]
                        h1 = h - startpose[2]
                        x2 = x1 * math.cos(startpose[3]) - y1 * math.sin(startpose[3])
                        y2 = x1 * math.sin(startpose[3]) + y1 * math.cos(startpose[3])
                        x, y, h = round(x2 + basepose[0], 2), round(y2 + basepose[1], 2), round(
                            h1 + basepose[2], 2)
                    track.append((t - t0, x, y, h))
                    lastpose = (x, y, h)
                    if abs(x) > 72 or abs(y) > 72:
                        lastpose = None
        if len(track) < 2:
            continue
        tracks[number] = {'name': name, 'track': track, 'number': number}
    for number in sorted(tracks, reverse=not oldest):
        name = tracks[number]['name']
        track = tracks[number]['track']
        skip = runs and number not in runs
        sys.stderr.write(f'{number:3d} {track[-1][0]:7.3f} {name} {"- skipped" if skip else ""}\n')
        if skip:
            continue
        out.append(f'Path,{name}')
        last = 0
        for idx, (t, x, y, h) in enumerate(track):
            if (idx and idx != len(track) - 1 and
                    abs(x - track[last][1]) <= 0.02 and
                    abs(y - track[last][2]) <= 0.02 and
                    abs(h - track[last][3]) <= 0.05):
                continue
            out.append(f'P{idx},{x},{y},{h},,,{t - track[last][0]:.6f}'.rstrip('0'))
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
            match = re.match(r'^[^_]+_((?P<number>\d{4})|\d{3})_(?P<name>[^_]+)(|_(?P<number2>\d+))\.', file)
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
                lastKey = key
                nums = None
                try:
                    if not re.search(r'[a-zA-Z][^0-9+\-.]', line[4]):
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
        print(f'{sum(v for v in keyTimes.values()):7.5f}s')


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
    parser.add_argument('-r', '--runs', help='Comma-separated list of run numbers to process.')
    parser.add_argument(
        '-s', '--step', choices=['mean', 'median', 'low', 'high', 'quartile1', 'quartile3'],
        help='Print a summary of how log different steps take.')
    opts = parser.parse_args()
    runs = [int(r) for r in opts.runs.split(',')] if opts.runs is not None else None
    logs_to_tracks(opts.logdir, opts.output, runs, opts.realign, opts.oldest)
    logs_to_excel(opts.logdir, opts.excel, opts.csv, runs, opts.step)
