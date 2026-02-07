const STORAGE_KEY = 'gs-dashboard';
const GRID_COLS = 12;
const SPEED_VALUES = { '-6': 0.01, '-5': 0.02, '-4': 0.05, '-3': 0.1, '-2': 0.2, '-1': 0.5, 0: 1, 1: 2, 2: 5, 3: 10, 4: 20 };
const LDASH = ['solid', 'dot', 'dashdot', 'longdash'];
const RDASH = ['dash', 'longdashdot', '5,3,1,3', '1,4'];
const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

let Grid;
let GridEditMode = false;
let Logs = {};
const MapSettings = {
  field: ['decode2.png', 72, 72, 72, 72],
  robots: [['decodebot33dpi.png', 8.25, 8.75, 8.25, 8.75]],
  parts: [['indexer5inraddark.png', 5, 5, 5, 5]],
};
const State = {
  time: 0,
  playing: false,
  continuous: false,
  baseTime: 0, // the scrubber time when the referenceTime references
  referenceTime: Date.now(),
  graphs: [{ x: 'time', category: undefined, left: ['Flywheel velocity'], right: ['Indexer Position'] }],
};

const DEFAULT_LAYOUT = [
  { x: 0, y: 0, w: 4, h: 2, id: 'control' },
  { x: 0, y: 2, w: 4, h: 1, id: 'playback' },
  { x: 0, y: 3, w: 4, h: 9, id: 'telemetry' },
  { x: 4, y: 0, w: 8, h: 4, id: 'graph' },
  { x: 4, y: 4, w: 8, h: 8, id: 'field' },
];

class LogRecord {
  constructor(rawdata, filename) {
    this.filename = filename;
    this.displayname = (filename.includes('_') ? filename.split('_').slice(1).join('_') : filename).split('.')[0].replace(/_/g, ' ');
    this.init = {};
    this.ikeys = {};
    this.data = [];
    this.telemetry = [];
    this.tkeys = {};
    const keys = {};
    this.orderedKeys = [];
    let telemetry;
    let record;
    let t0 = undefined;
    let count = 0;
    for (const rawline of rawdata.split(/\r?\n/)) {
      const line = this.parseLine(rawline);
      if (line.length < 5) {
        continue;
      }
      const key = line[3];
      if (key === 'loop time') {
        record = record ? (this.data.push({ ...record }), { ...record }) : {};
        // we only log changes in telemetry values, which means we can't tell if we skipped logging a value or it
        // did not change
        telemetry = telemetry ? (this.telemetry.push({ ...telemetry }), { ...telemetry }) : {};
        const t = parseFloat(line[0]);
        t0 = t0 ?? t;
        keys.time = keys.time !== undefined ? keys.time : Object.keys(keys).length;
        keys.count = keys.count || Object.keys(keys).length;
        record.time = t - t0;
        this.duration = record.time;
        record.count = this.data.length;
      }
      if (t0 === undefined) {
        if (key !== 'caption') {
          if (this.ikeys[key] === undefined) {
            this.ikeys[key] = Object.keys(this.ikeys).length;
          }
          this.init[key] = line[4];
        }
        continue;
      }
      if (this.tkeys[key] === undefined) {
        this.tkeys[key] = Object.keys(this.tkeys).length;
      }
      telemetry[key] = line[4];
      let nums = null;
      if (!/[a-zA-Z][0-9+\-.]/.test(line[4])) {
        const match = line[4].replace(/[^0-9+\-.]+/g, ' ').trim();
        if (match) {
          nums = match.split(/\s+/).map(parseFloat);
        }
      }
      if (!nums || nums.length <= 1) {
        keys[key] = keys[key] || Object.keys(keys).length;
        record[key] = nums?.length ? nums[0] : line[4];
      } else {
        nums.forEach((n, i) => {
          const k = `${key} ${i + 1}`;
          keys[k] = keys[k] || Object.keys(keys).length;
          record[k] = n;
        });
      }
    }
    if (record) {
      this.data.push(record);
      this.telemetry.push(telemetry);
      this.keys = keys;
    }
    if (this.data.length < 2) {
      this.data = undefined;
    }
  }

  parseLine(line) {
    const fields = [];
    let currentField = '';
    let insideQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];
      if (char === '"') {
        if (insideQuotes && nextChar === '"') {
          currentField += '"';
          i++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        fields.push(currentField);
        currentField = '';
      } else {
        currentField += char;
      }
    }
    fields.push(currentField);
    return fields;
  }

  getIndex(time) {
    let low = 0;
    let high = this.data.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      this.data[mid].time > time ? (high = mid) : (low = mid + 1);
    }
    return low - 1;
  }

  getTelemetry(time) {
    if (time < 0) {
      return this.init;
    }
    return this.telemetry[this.getIndex(time)];
  }
}

function saveState() {
  const items = Grid.save(false).map((n) => ({
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    id: n.id,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ items }));
}

function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (d && d.items && d.items.length) {
      if (!d.items.find((i) => i.id === 'control')) {
        d.items.unshift(DEFALT_LAYOUT[0]);
      }
      return d;
    }
  } catch (e) {}
  return { items: DEFAULT_LAYOUT, editMode: GridEditMode };
}

function buildContent(id) {
  const elem = document.getElementById(id.split('-')[0] + 'panel');
  let html;
  if (elem) {
    html = $(elem.outerHTML).removeClass('alwayshidden')[0].outerHTML;
  } else {
    html = `<button class="close-btn hidden" data-id="${id}">X</button><span class="panel-label">${id}</span>`;
  }
  return html;
}

function fitGrid(allowInEditMode) {
  const items = Grid.getGridItems();
  if ((GridEditMode && !allowInEditMode) || !items.length) {
    return;
  }
  const tiles = [];
  items.forEach((el) => {
    const node = el.gridstackNode;
    tiles.push({ el, id: node.id, x: node.x, y: node.y, w: node.w, h: node.h });
  });
  tiles.sort((a, b) => a.y - b.y);
  tiles.forEach((tile) => {
    tile.y = tiles.reduce((maxY, other) => (other !== tile && tile.x < other.x + other.w && tile.x + tile.w > other.x && other.y + other.h <= tile.y ? Math.max(maxY, other.y + other.h) : maxY), 0);
  });
  tiles.forEach((tile) => {
    tile.w = tiles.reduce((maxWidth, other) => (other !== tile && tile.y < other.y + other.h && tile.y + tile.h > other.y && other.x >= tile.x + tile.w ? Math.min(maxWidth, other.x - tile.x) : maxWidth), GRID_COLS - tile.x);
  });
  tiles.forEach((tile) => {
    let minX = tiles.reduce((minX, other) => (other !== tile && tile.y < other.y + other.h && tile.y + tile.h > other.y && other.x + other.w <= tile.x ? Math.max(minX, other.x + other.w) : minX), 0);
    tile.w += tile.x - minX;
    tile.x = minX;
  });
  const maxY = Math.max(Math.max(...tiles.map((tile) => tile.y + tile.h)), 6);
  tiles.forEach((tile) => {
    tile.h = tiles.reduce((maxHeight, other) => (other !== tile && tile.x < other.x + other.w && tile.x + tile.w > other.x && other.y >= tile.y + tile.h ? Math.min(maxHeight, other.y - tile.y) : maxHeight), maxY - tile.y);
  });
  const cellH = Math.floor(window.innerHeight / maxY);
  Grid.batchUpdate();
  Grid.cellHeight(cellH);
  tiles.forEach((tile) => Grid.update(tile.el, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }));
  Grid.batchUpdate(false);
  if (State.map) {
    State.map.size({ width: State.map.node().width(), height: State.map.node().height() });
  }
  Plotly.Plots.resize(document.getElementById('graph-plot'));
}

function toggleEdit(editMode) {
  GridEditMode = editMode !== undefined ? editMode : !GridEditMode;
  Grid.enableMove(GridEditMode);
  Grid.enableResize(GridEditMode);
  $('#editgrid').toggleClass('hidden', GridEditMode);
  $('#lockgrid').toggleClass('hidden', !GridEditMode);
  $('#resetgrid').toggleClass('hidden', !GridEditMode);
  showAddButtons();
  Grid.getGridItems().forEach((el) => {
    $('.close-btn', el).toggleClass('hidden', !GridEditMode);
  });
  fitGrid();
  saveState();
}

function showAddButtons() {
  if (!GridEditMode) {
    $('.addgrid').addClass('hidden');
  } else {
    // enable to show video panels                   $('#addvideo.addgrid').removeClass('hidden');
    // switch to this to have any number of graphs   $('#addgraph.addgrid').removeClass('hidden');
    $('#addgraph.addgrid').toggleClass(
      'hidden',
      Grid.getGridItems().some((el) => el.gridstackNode.id === 'graph'),
    );
    $('#addfield.addgrid').toggleClass(
      'hidden',
      Grid.getGridItems().some((el) => el.gridstackNode.id === 'field'),
    );
    $('#addtelemetry.addgrid').toggleClass(
      'hidden',
      Grid.getGridItems().some((el) => el.gridstackNode.id === 'telemetry'),
    );
  }
}

function addPanel(id) {
  const baseId = id;
  let num = 1;
  while (Grid.getGridItems().some((el) => el.gridstackNode.id === id) && num < 10) {
    num += 1;
    id = `${baseId}-${num}`;
  }
  const el = Grid.addWidget({ w: GRID_COLS, h: 2, id: id, autoPosition: true });
  el.querySelector('.grid-stack-item-content').innerHTML = buildContent(id);
  fitGrid(true);
  showAddButtons();
  $('.close-btn', el).toggleClass('hidden', !GridEditMode);
  saveState();
}

function removePanel(id) {
  const el = document.querySelector(`[gs-id="${id}"]`);
  if (el) {
    Grid.removeWidget(el);
    showAddButtons();
    saveState();
  }
}

function resetGrid() {
  const items = Grid.getGridItems();
  const tiles = [];
  items.forEach((el) => {
    const node = el.gridstackNode;
    const dl = DEFAULT_LAYOUT.filter((l) => l.id === node.id)[0];
    if (dl) {
      Grid.update(el, { x: dl.x, y: dl.y, w: dl.w, h: dl.h });
    }
  });
  fitGrid(true);
}

function initGrid() {
  State.isdark = !!window?.matchMedia?.('(prefers-color-scheme:dark)')?.matches;
  const state = loadState();
  GridEditMode = state.editMode;
  Grid = GridStack.init({
    column: GRID_COLS,
    cellHeight: 100,
    margin: 5,
    float: true,
    animate: false,
    disableDrag: !GridEditMode,
    disableResize: !GridEditMode,
  });
  state.items.forEach((item) => {
    const el = Grid.addWidget({
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      id: item.id,
    });
    el.querySelector('.grid-stack-item-content').innerHTML = buildContent(item.id);
  });
  Grid.on('change', saveState);
  document.body.addEventListener('click', (e) => {
    if (e.target.id === 'editgrid' || e.target.id === 'lockgrid') {
      toggleEdit(e.target.id === 'editgrid');
    } else if (e.target.id === 'resetgrid') {
      resetGrid();
    } else if (e.target.classList.contains('close-btn')) {
      removePanel(e.target.dataset.id);
    } else if (e.target.classList.contains('addgrid')) {
      addPanel(e.target.dataset.id);
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitGrid();
    }, 150);
  });
  fitGrid();

  document.getElementById('file').onchange = loadFiles;
  document.getElementById('logs').addEventListener('input', () => {
    updateLogs(true);
  });
  document.getElementById('remove').onclick = removeLogs;
  document.getElementById('time').addEventListener('input', () => setTime($('#time').val(), 'time'));
  document.getElementById('time-value').addEventListener('input', () => setTime($('#time-value').val(), 'time-value'));
  document.getElementById('speed').addEventListener('input', () => {
    $('#speed-value').text(`${SPEED_VALUES[$('#speed').val()]}x`);
    State.baseTime = State.time;
    State.referenceTime = Date.now();
  });
  document.getElementById('start-anim').onclick = () => setTime(0);
  document.getElementById('pause-anim').onclick = () => {
    State.playing = State.continuous = false;
  };
  document.getElementById('back-anim').onclick = () => {
    State.playing = State.continuous = false;
    const log = longestSelectedLog();
    if (log) {
      const idx = log.getIndex(State.time);
      setTime(idx ? log.data[idx - 1].time : -1);
    }
  };
  document.getElementById('step-anim').onclick = () => {
    State.playing = State.continuous = false;
    const log = longestSelectedLog();
    if (log) {
      const idx = log.getIndex(State.time);
      if (idx + 1 < log.data.length) {
        setTime(log.data[idx + 1].time);
      }
    }
  };
  document.getElementById('play-anim').onclick = () => {
    State.continuous = false;
    startPlayTimer();
  };
  document.getElementById('play-all-anim').onclick = () => {
    State.continuous = true;
    startPlayTimer();
  };
  addField();
  document.getElementById('cfg-plot').onclick = showGraphDialog;
  // DWM::
}

function sparkline(yidx) {
  /* if we graph based on the x-axis, we can either (a) sort the data so that
   * we reveal coupling between the values, (b) draw mini-line plots which
   * would be previews, (c) plot versus time, or (d) plot versus count; the
   * last two are probably the most obvious of what is going on. */
  const w = 72;
  const h = 18;
  // change this to get time or count explicitly for options (c) or (d)
  // const xkey = State.columns[+document.getElementById('xAxis').value].key;
  const xkey = 'time';
  const ykey = State.columns[yidx].key;
  const paths = [];
  State.sortedLogs.forEach((log) => {
    if (!log.selected) {
      return;
    }
    let pts = log.data.map((r) => ({ x: parseFloat(r[xkey]), y: parseFloat(r[ykey]) })).filter((p) => isFinite(p.x) && isFinite(p.y));
    if (pts.length < 2) {
      return;
    }
    // disable this line for option (b)
    pts.sort((a, b) => a.x - b.x);
    if (pts.length > w * 2) {
      const step = pts.length / w / 2;
      pts = Array.from({ length: w * 2 }, (_, i) => pts[Math.floor(i * step)]);
    }
    const valsx = pts.map((p) => p.x);
    const minx = Math.min(...valsx),
      maxx = Math.max(...valsx),
      rangex = maxx - minx || 1;
    const valsy = pts.map((p) => p.y);
    const miny = Math.min(...valsy),
      maxy = Math.max(...valsy),
      rangey = maxy - miny || 1;
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      // for options all but (b)
      const x = (i / (pts.length - 1)) * w;
      // for option (b)
      // const x = ((pts[i].x - minx) / rangex) * (w - 1);
      const y = h - 1 - ((pts[i].y - miny) / rangey) * (h - 2);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    paths.push(`<path d="${d}" fill="none" stroke="#888" stroke-width="1"/>`);
  });
  return `<svg width="${w}" height="${h}" style="vertical-align:middle;margin-right:4px">` + paths.join('') + '</svg>';
}

function updateSparklines(gr) {
  const lc = document.getElementById('leftYAxis');
  const rc = document.getElementById('rightYAxis');
  lc.innerHTML = '';
  rc.innerHTML = '';
  State.columns.forEach((col, idx) => {
    if (!col.text) {
      const s = sparkline(idx);
      lc.innerHTML += `<label>${s}<input type="checkbox" name="L" value="${col.key}"${gr.left.includes(col.key) ? ' checked' : ''}> ${col.key}</label>`;
      rc.innerHTML += `<label>${s}<input type="checkbox" name="R" value="${col.key}"${gr.right.includes(col.key) ? ' checked' : ''}> ${col.key}</label>`;
    }
  });
}

function showGraphDialog() {
  const gr = State.graphs[0];
  const xAxis = document.getElementById('xAxis');
  const cat = document.getElementById('categoryValue');
  xAxis.innerHTML = '';
  cat.innerHTML = '<option value="">None</option>';
  State.columns.forEach((col, idx) => {
    if (!col.text) {
      xAxis.add(new Option(col.key, col.key, col.key === gr.x, col.key == gr.x));
    }
    if (col.unique) {
      cat.add(new Option(col.key, col.key, col.key == gr.category, col.key == gr.category));
    }
  });
  updateSparklines(gr);
  document.getElementById('graph-modal').classList.add('open');
}

function hideGraphDialog() {
  document.getElementById('graph-modal').classList.remove('open');
}

function applyGraphOptions() {
  hideGraphDialog();
  const gr = State.graphs[0];
  gr.x = document.getElementById('xAxis').value;
  gr.category = document.getElementById('categoryValue').value;
  gr.left = [...document.querySelectorAll('#leftYAxis input[type="checkbox"]:checked')].map((c) => c.value);
  gr.right = [...document.querySelectorAll('#rightYAxis input[type="checkbox"]:checked')].map((c) => c.value);
  drawGraph(0);
}

function addPlotlySeries(log, gr, xVals, ykey, traceIdx, yaxis, dashList, suffix, traces, cats, catCol, catName) {
  let yAll, text, yAll2;
  let hovertemplate = '%{y:.5g}';
  if (!State.columnDict[ykey].text) {
    yAll = log.data.map((r) => parseFloat(r[ykey]));
    if (yAll.every((r) => r >= -10 && r <= 380) && yAll.some((r, ridx) => ridx && Math.abs(r - yAll[ridx - 1]) > 330)) {
      yAll2 = yAll.slice();
      let first = true;
      yAll.forEach((r, ridx) => {
        let transition;
        if (ridx && Math.abs(r - (first ? yAll : yAll2)[ridx - 1]) > 330) {
          first = !first;
          transition = true;
        }
        (first ? yAll2 : yAll)[ridx] = null;
        if (transition) {
          if (yAll[ridx] === null) {
            yAll[ridx] = yAll2[ridx] > yAll[ridx - 1] ? yAll2[ridx] - 360 : yAll2[ridx] + 360;
            yAll2[ridx - 1] = yAll[ridx] > yAll2[ridx - 1] ? yAll[ridx - 1] - 360 : yAll[ridx - 1] + 360;
          } else {
            yAll2[ridx] = yAll[ridx] > yAll2[ridx - 1] ? yAll[ridx] - 360 : yAll[ridx] + 360;
            yAll[ridx - 1] = yAll2[ridx] > yAll[ridx - 1] ? yAll2[ridx - 1] - 360 : yAll2[ridx - 1] + 360;
          }
        }
      });
    }
  } else {
    return;
  }
  const dash = dashList[traceIdx % dashList.length];
  const baseColor = PALETTE[traceIdx % PALETTE.length];
  [yAll, yAll2].forEach((yVals) => {
    if (yVals === undefined) {
      return;
    }
    if (!cats) {
      traces.push({
        x: xVals,
        y: yVals,
        name: ykey + suffix,
        yaxis,
        text: text,
        mode: 'lines',
        line: { dash, width: 2, color: baseColor },
        hovertemplate: hovertemplate,
      });
    } else {
      const segs = [];
      let cur = { cat: cats[0], start: 0 };
      for (let i = 1; i < cats.length; i++) {
        if (cats[i] !== cur.cat) {
          cur.end = i - 1;
          segs.push(cur);
          cur = { cat: cats[i], start: i };
        }
      }
      cur.end = cats.length - 1;
      segs.push(cur);
      segs.forEach((seg, segidx) => {
        const start = segidx > 0 ? seg.start - 1 : seg.start;
        const xf = xVals.slice(start, seg.end + 1);
        const yf = yVals.slice(start, seg.end + 1);
        const cf = cats.slice(start, seg.end + 1);
        traces.push({
          x: xf,
          y: yf,
          name: ykey + suffix,
          showlegend: segidx === 0,
          legendgroup: ykey + yaxis,
          yaxis,
          mode: 'lines',
          line: { dash, width: 2, color: catCol[seg.cat] },
          customdata: cf.map((c) => [catName[c]]),
          hovertemplate: hovertemplate + ' [%{customdata[0]}]',
        });
      });
    }
  });
}

function drawGraph(graphNumber) {
  const gr = State.graphs[graphNumber];
  if (!gr.x || !(gr.left.length + gr.right.length)) {
    document.getElementById('graph-plot').innerHTML = '';
    return;
  }
  const logs = State.sortedLogs.filter((log) => log.selected);
  const traces = [];
  logs.forEach((log) => {
    const xVals = log.data.map((r) => {
      const v = r[gr.x];
      return isFinite(+v) ? +v : v;
    });
    let cats;
    let catCol = {};
    let catName;
    if (gr.category) {
      catName = Object.keys(State.columnDict[gr.category].unique).sort();
      const catDict = Object.fromEntries(catName.map((s, i) => [s, i]));
      catName.forEach((c, i) => (catCol[c] = PALETTE[i % PALETTE.length]));
      cats = log.data.map((r) => catDict[r[gr.category]]);
    }
    gr.left.forEach((ykey, idx) => {
      addPlotlySeries(log, gr, xVals, ykey, traces.length, 'y', LDASH, '', traces, cats, catCol, catName);
    });
    gr.right.forEach((ykey, idx) => {
      addPlotlySeries(log, gr, xVals, ykey, traces.length, 'y2', RDASH, ' (R)', traces, cats, catCol, catName);
    });
  });

  Plotly.react(
    'graph-plot',
    traces,
    {
      autosize: true,
      margin: { l: 80, r: 80, t: 30, b: 30 },
      hovermode: 'x unified',
      xaxis: {
        title: State.columns[gr.x],
        showspikes: true,
        spikemode: 'across',
        spikethickness: 1,
        spikecolor: '#999',
        spikedash: 'solid',
      },
      yaxis: { title: gr.left.join(', ') },
      yaxis2: { title: gr.right.join(', '), overlaying: 'y', side: 'right', showgrid: false },
      legend: { orientation: 'h', y: 1, x: 0.5, xanchor: 'center', yanchor: 'bottom' },
    },
    { responsive: true },
  );
}

function addField() {
  if (!$('#fieldpanel:not(.alwayshidden) #map').length) {
    return;
  }
  State.map = geo.map({
    node: $('#fieldpanel:not(.alwayshidden) #map')[0],
    ingcs: '+proj=longlat +axis=esu',
    gcs: '+proj=longlat +axis=enu',
    maxBounds: { left: -80, top: -80, right: 80, bottom: 80 },
    unitsPerPixel: 1,
    center: { x: 0, y: 0 },
    min: 0,
    max: 6,
    zoom: 0,
    clampBoundsX: true,
    clampBoundsY: true,
    clampZoom: true,
  });
  State.map.geoOn(geo.event.mousemove, function (evt) {
    $('#fieldpanel #info').text('x: ' + evt.geo.x.toFixed(3) + ', y: ' + -evt.geo.y.toFixed(3));
  });
  State.quadData = [
    {
      ll: { x: -MapSettings.field[1], y: MapSettings.field[4] },
      ur: { x: MapSettings.field[3], y: -MapSettings.field[2] },
      image: MapSettings.field[0],
    },
  ];
  var layer = State.map.createLayer('feature', {
    features: ['quad', 'marker'],
  });
  State.quads = layer.createFeature('quad');
  State.quads.data(State.quadData);

  State.track = layer
    .createFeature('track')
    .data([])
    .style({
      strokeWidth: 3,
      strokeColor: State.isdark ? '#404040' : 'black',
    })
    .markerStyle({ radius: 0, strokeWidth: 0 })
    .futureStyle({ strokeOpacity: 0 })
    .track((t) => t.data)
    .time((d) => d.time)
    .position((d, i, t, j) => (!State.sortedLogs[j].selected ? { x: -10000, y: -10000 } : { x: d['Field position 1'], y: -d['Field position 2'], angle: (d['Field position 3'] * Math.PI) / 180 }))
    .startTime(0)
    .endTime(0);
  State.map.draw();
}

function startPlayTimer() {
  State.playing = true;
  if (!State.animationTimer) {
    State.animationTimer = window.requestAnimationFrame(playUpdate);
  }
  State.baseTime = State.time;
  State.referenceTime = Date.now();
}

function playUpdate() {
  State.animationTimer = null;
  if (!State.playing) {
    return;
  }
  let speed = SPEED_VALUES[$('#speed').val()] || 1;
  let newTime = (Date.now() - State.referenceTime) * 0.001 * speed + State.baseTime;
  setTime(Math.min(State.maxDuration, newTime), undefined, false, true);
  if (newTime >= State.maxDuration) {
    if (!State.continuous) {
      State.playing = false;
    } else if (newTime >= State.maxDuration + 3) {
      const logsElement = document.getElementById('logs');
      const logOptions = [...logsElement.options];
      const selectedIndexes = logOptions.reduce((acc, opt, idx) => (opt.selected && acc.push(idx), acc), []);
      const targetIndex = !logOptions.length ? -1 : !selectedIndexes.length || selectedIndexes.length === logOptions.length ? 0 : selectedIndexes.at(-1) < logOptions.length - 1 ? selectedIndexes.at(-1) + 1 : logOptions.findIndex((opt) => !opt.selected) || 0;
      logOptions.forEach((opt) => (opt.selected = false));
      if (targetIndex >= 0) {
        logOptions[targetIndex].selected = true;
      }
      updateLogs(true);
      setTime(0, undefined, true);
      State.baseTime = State.time;
      State.referenceTime = Date.now();
      updateNow();
    }
  }
  if (State.playing) {
    State.animationTimer = window.requestAnimationFrame(playUpdate);
  }
}

function firstSelectedLog() {
  return State.sortedLogs.filter((log) => log.selected)[0];
}

function longestSelectedLog() {
  let picked;
  State.sortedLogs.forEach((log) => {
    if (log.selected && (!picked || log.duration > picked.duration)) {
      picked = log;
    }
  });
  return picked;
}

function setTime(time, id, skipUpdate, skipBaseSet) {
  if (isFinite(time)) {
    State.time = parseFloat(time);
    if (!skipBaseSet) {
      State.baseTime = State.time;
      State.referenceTime = Date.now();
    }
    if (id !== 'time-value') {
      $('#time-value').val(State.time.toFixed(3));
    }
    if (id !== 'time') {
      $('#time').val(State.time);
    }
    if (!skipUpdate) {
      updateNow();
    }
  }
}

function removeLogs() {
  Object.keys(Logs).forEach((key) => {
    if (Logs[key].selected) {
      delete Logs[key];
    }
  });
  updateLogs();
}

function updateLogs(skipRerender) {
  const sel = document.getElementById('logs');
  $('option', sel).each(function () {
    const key = $(this).attr('value');
    if (Logs[key]) {
      Logs[key].selected = $(this).is(':selected');
    }
  });
  const items = Object.values(Logs).sort((a, b) => a.displayname.localeCompare(b.displayname));
  State.sortedLogs = items;
  if (!skipRerender) {
    sel.innerHTML = items.map((i) => `<option value="${i.filename}"${i.selected ? ' selected' : ''}>${i.displayname} (${i.duration.toFixed(2)}s)</option>`).join('');
    if (items.length && !items.some((i) => i.selected)) {
      items[0].selected = true;
      sel.options[0].selected = true;
    }
  }
  telemetryKeys();
  State.maxDuration = Object.values(Logs).reduce((duration, log) => Math.max(duration, log.selected ? log.duration : 0), 0);
  $('#time').attr('max', State.maxDuration);
  if (State.time > State.maxDuration) {
    setTime(State.maxDuration, undefined, true);
  }
  if (State.track) {
    State.track.data(State.sortedLogs);
  }
  categorizeColumns();
  drawGraph(0);
  // DWM::
  console.log(State); // DWM::
  updateNow();
}

/**
 * Update all the data based on the time.
 */
function updateNow() {
  updateTelemetry();
  if (State.track) {
    State.track.endTime(State.time);
    updateRobotImages();
    State.track.draw();
  }
  updateGraphCursor();
  // DWM::
}

function updateGraphCursor() {
  const gr = State.graphs[0];
  let applied;
  if (gr.x === 'time') {
    try {
      let layout = $('#graph-plot')[0]._fullLayout;
      let x = layout.xaxis.l2p(State.time) + layout.margin.l;
      if (isFinite(x) && x >= 0) {
        $('#graph-cursor').css('left', x - 1 + 'px');
        applied = true;
      }
    } catch (err) {
      applied = false;
    }
  }
  $('#graph-cursor').toggleClass('hidden', !applied);
}

function updateTelemetry() {
  const headers = [];
  const values = [];
  State.sortedLogs.forEach((log) => {
    if (log.selected) {
      headers.push(log.displayname);
      values.push(log.getTelemetry(State.time));
    }
  });
  const table = document.getElementById('telemetry-table');
  let thead = table.querySelector('thead') || table.createTHead();
  let tbody = table.querySelector('tbody') || table.createTBody();
  const hRow = document.createElement('tr');
  hRow.appendChild(document.createElement('th'));
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    hRow.appendChild(th);
  });
  thead.textContent = '';
  thead.appendChild(hRow);
  const fragment = document.createDocumentFragment();
  (State.time < 0 ? State.ikeys : State.tkeys).forEach((key) => {
    const tr = document.createElement('tr');
    const keyCell = document.createElement('td');
    keyCell.textContent = key;
    tr.appendChild(keyCell);
    values.forEach((colData) => {
      const td = document.createElement('td');
      td.textContent = colData[key] ?? '';
      tr.appendChild(td);
    });
    fragment.appendChild(tr);
  });
  tbody.textContent = '';
  tbody.appendChild(fragment);
}

function telemetryKeys() {
  ['ikeys', 'tkeys'].forEach((part) => {
    const minValues = {};
    Object.values(Logs).forEach((log) => {
      if (log.selected) {
        Object.entries(log[part]).forEach(([key, value]) => {
          if (key.startsWith(' ')) {
            value += 1000;
          }
          if (!(key in minValues) || value < minValues[key]) {
            minValues[key] = value;
          }
        });
      }
    });
    State[part] = Object.keys(minValues).sort((a, b) => {
      if (minValues[a] !== minValues[b]) {
        return minValues[a] - minValues[b];
      }
      return a < b ? -1 : a > b ? 1 : 0;
    });
  });
}

function categorizeColumns() {
  const columns = {};
  State.sortedLogs.forEach((log) => {
    Object.keys(log.keys)
      .sort((a, b) => log.keys[a] - log.keys[b])
      .forEach((key) => {
        if (!columns[key]) {
          columns[key] = { key: key, unique: {}, text: false, pos: Object.keys(columns).length };
        }
        for (let r = 0; r < log.data.length && (columns[key].unique !== undefined || !columns[key].text); r += 1) {
          const row = log.data[r];
          const val = row[key];
          if (val !== undefined && val !== null && val !== '') {
            columns[key].any = true;
            if (!isFinite(val)) {
              columns[key].text = true;
            }
            if (columns[key].unique !== undefined) {
              columns[key].unique[val] = true;
              if (Object.keys(columns[key].unique).length > 50) {
                columns[key].unique = undefined;
              }
            }
          }
        }
      });
  });
  State.columnDict = columns;
  State.columns = Object.values(columns)
    .sort((a, b) => a.pos - b.pos)
    .filter((col) => col.any);
}

function addRobotImage(quadData, idx, pos, rnum) {
  if (idx <= quadData.length) {
    quadData.push(Object.assign({}, quadData[quadData.length - 1]));
  }
  var left = MapSettings.robots[rnum][1];
  var front = MapSettings.robots[rnum][2];
  var right = MapSettings.robots[rnum][3];
  var back = MapSettings.robots[rnum][4];
  quadData[idx].image = MapSettings.robots[rnum][0];
  quadData[idx].ur = {
    x: pos.x + front * Math.cos(pos.angle) - right * Math.sin(pos.angle),
    y: pos.y + front * Math.sin(pos.angle) + right * Math.cos(pos.angle),
  };
  quadData[idx].lr = {
    x: pos.x + -back * Math.cos(pos.angle) - right * Math.sin(pos.angle),
    y: pos.y + -back * Math.sin(pos.angle) + right * Math.cos(pos.angle),
  };
  quadData[idx].ll = {
    x: pos.x + -back * Math.cos(pos.angle) - -left * Math.sin(pos.angle),
    y: pos.y + -back * Math.sin(pos.angle) + -left * Math.cos(pos.angle),
  };
  quadData[idx].ul = {
    x: pos.x + front * Math.cos(pos.angle) - -left * Math.sin(pos.angle),
    y: pos.y + front * Math.sin(pos.angle) + -left * Math.cos(pos.angle),
  };
  return idx + 1;
}

function addPartImage(quadData, idx, pos, partdata) {
  let pnum = partdata[0];
  let x = pos.x - partdata[1] * Math.sin(pos.angle) + partdata[2] * Math.cos(pos.angle);
  let y = pos.y + partdata[1] * Math.cos(pos.angle) + partdata[2] * Math.sin(pos.angle);
  let angle = pos.angle + partdata[3] * (Math.PI / 180);
  if (!MapSettings.parts[pnum] || !isFinite(x) || !isFinite(y) || !isFinite(angle)) {
    return idx;
  }
  if (idx <= quadData.length) {
    quadData.push(Object.assign({}, quadData[quadData.length - 1]));
  }
  var left = MapSettings.parts[pnum][1];
  var front = MapSettings.parts[pnum][2];
  var right = MapSettings.parts[pnum][3];
  var back = MapSettings.parts[pnum][4];
  quadData[idx].image = MapSettings.parts[pnum][0];
  quadData[idx].ur = {
    x: x + front * Math.cos(angle) - right * Math.sin(angle),
    y: y + front * Math.sin(angle) + right * Math.cos(angle),
  };
  quadData[idx].lr = {
    x: x + -back * Math.cos(angle) - right * Math.sin(angle),
    y: y + -back * Math.sin(angle) + right * Math.cos(angle),
  };
  quadData[idx].ll = {
    x: x + -back * Math.cos(angle) - -left * Math.sin(angle),
    y: y + -back * Math.sin(angle) + -left * Math.cos(angle),
  };
  quadData[idx].ul = {
    x: x + front * Math.cos(angle) - -left * Math.sin(angle),
    y: y + front * Math.sin(angle) + -left * Math.cos(angle),
  };
  return idx + 1;
}

function updateRobotImages() {
  const quadData = State.quadData;
  let qidx = 1;
  let tpos = State.track.calculateTimePosition(State.track.endTime(), undefined, true);
  State.sortedLogs.forEach((log, idx) => {
    if (!log.selected || !isFinite(tpos[idx].x) || tpos[idx].x < -100 || tpos[idx].x > 100 || tpos[idx].y < -100 || tpos[idx].y > 100) {
      return;
    }
    let indexer;
    if (tpos[idx].posidx !== undefined) {
      const ang = log.data[tpos[idx].posidx]['Field position 3'];
      tpos[idx].angle = -(ang * Math.PI) / 180;
      indexer = log.data[tpos[idx].posidx]['Indexer Position'];
    } else {
      const ang0 = log.data[tpos[idx].posidx0]['Field position 3'];
      let ang1 = log.data[tpos[idx].posidx1]['Field position 3'];
      if (Math.abs(ang0 - ang1) > 180) {
        ang1 += ang1 < ang0 ? 360 : -360;
      }
      tpos[idx].angle = -((ang0 * tpos[idx].factor0 + ang1 * tpos[idx].factor1) * Math.PI) / 180;
      const indexer0 = log.data[tpos[idx].posidx0]['Indexer Position'];
      let indexer1 = log.data[tpos[idx].posidx1]['Indexer Position'];
      if (Math.abs(indexer0 - indexer1) > 180) {
        indexer1 += indexer1 < indexer0 ? 360 : -360;
      }
      indexer = indexer0 * tpos[idx].factor0 + indexer1 * tpos[idx].factor1;
    }
    qidx = addRobotImage(State.quadData, qidx, tpos[idx], 0);
    qidx = addPartImage(State.quadData, qidx, tpos[idx], [0, 0, 1.75, -indexer]);
  });
  if (qidx === 1) {
    quadData[qidx].ur = quadData[qidx].lr = quadData[qidx].ll = quadData[qidx].ul = { x: -1000, y: -1000 };
    qidx += 1;
  }
  while (quadData.length > qidx && quadData.length > 2) {
    quadData.pop();
  }
  State.quads.data(State.quadData);
  State.quadData.forEach((qd, idx) => {
    if (idx) {
      State.quads.cacheUpdate(idx);
    }
  });
  State.quads.layer().map().draw();
}

function loadFiles(evt) {
  for (idx = 0; idx < evt.target.files.length; idx += 1) {
    const file = evt.target.files[idx];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      const log = new LogRecord(evt.target.result, file.name);
      if (!log.data) {
        return;
      }
      if (Logs[log.filename] !== undefined) {
        log.selected = Logs[log.filename].selected;
      }
      Logs[log.filename] = log;
      updateLogs();
    };
    reader.readAsText(file);
  }
}

document.addEventListener('DOMContentLoaded', initGrid);

// TODO:
// realign tracks
// multiple graphs
// video
// multiple video
// hide tracks
// default size based on window aspect ratio
// reset tile positions
// visualize shoot lines
// visualize april tag positions / bearings
// overlay hood / flywheel settings
// test dark mode colors
