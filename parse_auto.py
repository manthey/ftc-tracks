#!/usr/env/bin python

import math
import pprint
import re
import sys

source = []
for f in sys.argv[1:]:
    if not f.startswith('--'):
        source += open(f).readlines()
consts = {}
actions = {}
posdict = {}
curaction = None
for line in source:  # noqa
    constval = re.match(
        r'^\s*(?:(?:public|private|static)\s+)*double\s+(\w+)\s*=\s*([^;,]+);',
        line)
    if constval:
        try:
            consts[constval.groups()[0]] = eval(constval.groups()[1])
        except Exception:
            pass
        consts = {key: consts[key]
                  for key in sorted(consts, key=lambda k: len(k), reverse=True)}
    posval = re.match(
        r'^\s*drivePositions(\w+)\.put\s*\(\s*"([^"]+)"\s*,\s*new\s+double\[\]\s*\{\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,}]+)\s*\}\s*\)',  # noqa
        line)
    if posval:
        dp, where, x, y, h = posval.groups()
        posdict.setdefault(dp, {})
        vals = [x, y, h]
        for idx, val in enumerate(vals):
            for c in consts:
                if c in val:
                    val = val.replace(c, str(consts[c]))
            vals[idx] = eval(val)
        posdict[dp][where] = vals
    posval = re.match(
        r'^\s*drivePositions(\w+)\.put\s*\(\s*"([^"]+)"\s*,\s*robot\.pointTo\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*\)',  # noqa
        line)
    if posval:
        dp, where, x, y, x2, y2 = posval.groups()
        posdict.setdefault(dp, {})
        vals = [float(x), float(y),
                math.atan2(float(y2) - float(y), float(x2) - float(x)) * 180 / math.pi]
        posdict[dp][where] = vals
    actionval = re.match(
        r'^\s*public\s+void\s+action(\w+)\s*\(\)\s*{',
        line)
    if actionval:
        curaction = actionval.groups()[0]
        actions[curaction] = {}
    if re.match(r'^    }\s*$', line):
        curaction = None
    nextval = re.match(r'^\s*nextState\s*=\s*"([^"]+)"\s*;\s*$', line)
    if nextval and curaction:
        actions[curaction].setdefault('next', [])
        actions[curaction]['next'].append(nextval.groups()[0])
    driveval = re.match(
        r'^\s*driveTo\.setTargetPosition\(\s*drivePositions.get\(\s*"([^"]+)"\s*\)\s*(|,\s*([^,)]+)\s*)(|,\s*([^,)]+)\s*)\);',  # noqa
        line)
    if driveval and curaction:
        pos = {}
        actions[curaction].setdefault('positions', [])
        actions[curaction]['positions'].append(pos)
        pos['position'] = driveval.groups()[0]
        val = driveval.groups()[2]
        val2 = driveval.groups()[4]
        if val is None and val2 is not None:
            val, val2 = val2, val
        if val2 is not None:
            pos['stop'] = val2 != 'false'
        if val is not None:
            if val in {'true', 'false'}:
                pos['stop'] = val != 'false'
            else:
                for c in consts:
                    if c in val:
                        val = val.replace(c, str(consts[c]))
                pos['speed'] = eval(val)
    waitval = re.match(
        r'^\s*wait\s*=\s*getRuntime\(\)\s*\+\s*([^,)]+)\s*;',
        line)
    if waitval and curaction:
        val = waitval.groups()[0]
        for c in consts:
            if c in val:
                val = val.replace(c, str(consts[c]))
        actions[curaction]['wait'] = actions[curaction].setdefault('wait', 0) + float(val)


actions['Start'].setdefault('positions', [{'position': 'start'}])
pprint.pprint(consts)
pprint.pprint(posdict)
pprint.pprint(actions)


def track_sequence(name, posname, action, sequences, posnum=0, seq=None):
    if action not in actions:
        return
    if 'next' not in actions[action]:
        return
    pos = None
    if 'positions' in actions[action]:
        if posnum >= len(actions[action]['positions']):
            return
        pos = actions[action]['positions'][posnum]
    if pos and pos['position'] not in posdict[posname]:
        return
    if pos:
        if seq is None:
            seq = []
        else:
            seq = seq[:]
        seq.append([pos['position']])
        seq[-1].extend(posdict[posname][pos['position']])
        if 'speed' in pos:
            seq[-1].append(pos['speed'])
        else:
            seq[-1].append(None)
        if 'stop' in pos:
            seq[-1].append(pos['stop'])
        else:
            seq[-1].append(None)
    if 'wait' in actions[action] and seq is not None and len(seq):
        if len(seq[-1]) == 6:
            seq[-1].append(0)
        seq[-1][6] += actions[action]['wait']
    for nextact in actions[action]['next']:
        if nextact.startswith('action'):
            nextact = nextact[6:]
        if nextact == 'done':
            sequences[name] = seq
        elif len(actions[action]['next']) == 1:
            if nextact not in actions or 'positions' not in actions[nextact] or len(actions[nextact]['positions']) == 1:

                track_sequence(name, posname, nextact, sequences, 0, seq)
            else:
                for posidx in range(len(actions[nextact]['positions'])):
                    track_sequence(name + str(posidx), posname, nextact, sequences, posidx, seq)
        else:
            if nextact not in actions or 'positions' not in actions[nextact] or len(actions[nextact]['positions']) == 1:
                track_sequence(name + nextact, posname, nextact, sequences, 0, seq)
            else:
                for posidx in range(len(actions[nextact]['positions'])):
                    track_sequence(name + nextact + str(posidx), posname, nextact, sequences, posidx, seq)


sequences = {}
for posname in posdict:
    track_sequence(posname, posname, 'Start', sequences)
pprint.pprint(sequences)

tracktext = []
for seqname, seq in sequences.items():
    tracktext.append(f'Path,{seqname}')
    for entry in seq:
        tracktext.append((','.join([
            str(val) if not isinstance(val, bool) and val is not None else
            '' if val is None else str(val).lower() for val in entry])).rstrip(','))
for line in tracktext:
    print(line)
if '--write' in sys.argv[1:]:
    index = open('index.html').read()
    pos = index.index('<textarea')
    pos = index.index('>', pos) + 1
    endpos = index.index('<', pos)
    index = index[:pos] + '\n' + '\n'.join(tracktext) + '\n      ' + index[endpos:]
    open('index.html', 'w').write(index)
