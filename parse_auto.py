#!/usr/env/bin python

import math
import pprint
import re
import sys

source = []
for f in sys.argv[1:]:
    source += open(f).readlines()
consts = {}
actions = {}
pos = {}
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
    posval = re.match(
        r'^\s*drivePositions(\w+)\.put\s*\(\s*"([^"]+)"\s*,\s*new\s+double\[\]\s*\{\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,}]+)\s*\}\s*\)',  # noqa
        line)
    if posval:
        dp, where, x, y, h = posval.groups()
        pos.setdefault(dp, {})
        vals = [x, y, h]
        for idx, val in enumerate(vals):
            for c in consts:
                if c in val:
                    val = val.replace(c, str(consts[c]))
            vals[idx] = eval(val)
        pos[dp][where] = vals
    posval = re.match(
        r'^\s*drivePositions(\w+)\.put\s*\(\s*"([^"]+)"\s*,\s*robot\.pointTo\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*\)',  # noqa
        line)
    if posval:
        dp, where, x, y, x2, y2 = posval.groups()
        pos.setdefault(dp, {})
        vals = [float(x), float(y),
                math.atan2(float(y2) - float(y), float(x2) - float(x)) * 180 / math.pi]
        pos[dp][where] = vals
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
        actions[curaction]['position'] = driveval.groups()[0]
        val = driveval.groups()[2]
        val2 = driveval.groups()[4]
        if val is None and val2 is not None:
            val, val2 = val2, val
        if val2 is not None:
            actions[curaction]['stop'] = val2 != 'false'
        if val is not None:
            if val in {'true', 'false'}:
                actions[curaction]['stop'] = val != 'false'
            else:
                for c in consts:
                    if c in val:
                        val = val.replace(c, str(consts[c]))
                actions[curaction]['speed'] = eval(val)

actions['Start']['position'] = 'start'
pprint.pprint(consts)
pprint.pprint(pos)
pprint.pprint(actions)


def track_sequence(name, posname, action, sequences, seq=None):
    if action not in actions:
        return
    if 'next' not in actions[action]:
        return
    if 'position' in actions[action] and actions[action]['position'] not in pos[posname]:
        return
    if 'position' in actions[action]:
        if seq is None:
            seq = []
        else:
            seq = seq[:]
        seq.append([actions[action]['position']])
        seq[-1].extend(pos[posname][actions[action]['position']])
        if 'speed' in actions[action]:
            seq[-1].append(actions[action]['speed'])
        if 'stop' in actions[action]:
            if len(seq[-1]) < 5:
                seq[-1].append(None)
            seq[-1].append(actions[action]['stop'])
    for nextact in actions[action]['next']:
        if nextact.startswith('action'):
            nextact = nextact[6:]
        if nextact == 'done':
            sequences[name] = seq
        elif len(actions[action]['next']) == 1:
            track_sequence(name, posname, nextact, sequences, seq)
        else:
            track_sequence(name + nextact, posname, nextact, sequences, seq)


sequences = {}
for posname in pos:
    track_sequence(posname, posname, 'Start', sequences)
pprint.pprint(sequences)

for seqname, seq in sequences.items():
    print(f'Path,{seqname}')
    for entry in seq:
        print(','.join([
            str(val) if not isinstance(val, bool) and val is not None else
            '' if val is None else str(val).lower() for val in entry]))
