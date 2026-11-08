const STORAGE_KEY = 'gs-dashboard';
const GRID_COLS = 12;
const SPEED_VALUES = { '-6': 0.01, '-5': 0.02, '-4': 0.05, '-3': 0.1, '-2': 0.2, '-1': 0.5, 0: 1, 1: 2, 2: 5, 3: 10, 4: 20, 5: 50, 6: 100 };
const LDASH = ['solid', 'dot', 'dashdot', 'longdash'];
const RDASH = ['dash', 'longdashdot', '5,3,1,3', '1,4'];
const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
const PART_COLOR = { PRESENT: 1, PURPLE: 2, GREEN: 3 };
/* explicit ordering for known categorical fields. Values listed are at the
 * front in the given order (values that never occur are skipped); an entry of
 * '*' places the remaining values in order of appearance instead of lexical
 * order, and ['*'] alone orders the whole field by appearance. Fields not
 * mentioned are lexical. */
const CATEGORY_ORDER = {
  'Blue hive state': ['UNKNOWN'],
  'Red hive state': ['UNKNOWN'],
};
const MAX_LEGEND_ENTRIES = 9;

let Grid;
let GridEditMode = false;
let Logs = {};
const MapSettings = {
  field: ['biobuzz.png', 72, 72, 72, 72],
  robots: [
    ['decodebot33dpi.png', 8.25, 8.75, 8.25, 8.75],
    ['decodebot2.png', 8.25, 8.75, 8.25, 8.75],
  ],
  parts: [
    ['indexer5inraddark.png', 5.3, 5.3, 5.3, 5.3],
    ['artifactgray.png', 2.5, 5.75, 2.5, -0.75],
    ['artifactpurple.png', 2.5, 5.75, 2.5, -0.75],
    ['artifactgreen.png', 2.5, 5.75, 2.5, -0.75],
  ],
};
const State = {
  time: 0,
  playing: false,
  continuous: false,
  baseTime: 0, // the scrubber time when the referenceTime references
  referenceTime: Date.now(),
  graphs: [{ x: 'time', category: undefined, left: ['Flywheel velocity'], right: ['Indexer Position'] }],
  videos: {},
};

/* Live log following: poll a robot or simulator log web server (port 6955,
 * see the BioBuzz LogWebServer) and keep the most recent telemetry log loaded
 * as the robot appends to it, switching to a newer log file when one starts.
 * The file tail is polled at pollMs (20 Hz) and the file listing at listMs
 * (1 Hz); new bytes are appended to the parsed LogRecord incrementally, so
 * per-poll cost is proportional to the new data, not the whole log. */
const Live = {
  active: false,
  base: '', // origin of the log web server, e.g. http://192.168.43.1:6955
  file: null, // name of the log file being followed
  log: null, // the LogRecord being built incrementally
  offset: 0, // bytes of the followed file already consumed into log
  pending: '', // complete lines held back because a quoted field spans a fetch boundary
  busy: false, // a poll is in flight; skip overlapping polls
  timer: null,
  uiTimer: null,
  pollMs: 50, // 20 Hz tail
  listMs: 1000, // listing only needs to notice new files
  listedAt: 0,
  nextPoll: 0, // absolute time the next poll is due (self-correcting pacing)
};

const DEFAULT_LAYOUT = [
  { x: 0, y: 0, w: 4, h: 2, id: 'control' },
  { x: 0, y: 2, w: 4, h: 1, id: 'playback' },
  { x: 0, y: 3, w: 4, h: 9, id: 'telemetry' },
  { x: 4, y: 0, w: 8, h: 4, id: 'graph' },
  { x: 4, y: 4, w: 5, h: 8, id: 'field' },
  { x: 9, y: 4, w: 3, h: 4, id: 'video' },
  { x: 9, y: 8, w: 3, h: 4, id: 'video-2' },
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
    this.orderedKeys = [];
    // incremental parse state: append() can be called repeatedly with more
    // text (live log tailing) and yields the same result as parsing it all
    // at once would have
    this._pendingSnap = -1; // index in data of the snapshot of the trailing record, -1 when not yet snapshotted
    this._p = { keys: {}, record: undefined, telemetry: undefined, t0: undefined };
    if (rawdata) {
      this.append(rawdata);
    }
  }

  /** True once the record holds at least two complete loop records. */
  get valid() {
    return this.data.length >= 2;
  }

  /** Parse additional CSV text (complete lines) into the record. When strict,
   * returns false without processing if a quoted field is left unterminated
   * (a fetch boundary split it; the caller retries once more text arrives). */
  append(rawdata, strict) {
    if (!rawdata) {
      return true;
    }
    const parsed = Papa.parse(rawdata);
    if (strict && parsed.errors.some((e) => e.code === 'MissingQuotes' || e.code === 'UnterminatedQuote')) {
      return false;
    }
    for (const line of parsed.data) {
      this._processLine(line);
    }
    this._finalize();
    return true;
  }

  _processLine(line) {
    const p = this._p;
    if (line.length < 5) {
      return;
    }
    const key = line[3];
    if (key === 'loop time') {
      if (p.record) {
        this.data.push({ ...p.record });
        this.telemetry.push({ ...p.telemetry });
        this._pendingSnap = -1;
        p.record = { ...p.record };
        p.telemetry = { ...p.telemetry };
      } else {
        p.record = {};
        p.telemetry = {};
      }
      // we only log changes in telemetry values, which means we can't tell if we skipped logging a value or it
      // did not change
      const t = parseFloat(line[0]);
      p.t0 = p.t0 ?? t;
      p.keys.time = p.keys.time !== undefined ? p.keys.time : Object.keys(p.keys).length;
      p.keys.count = p.keys.count || Object.keys(p.keys).length;
      p.record.time = t - p.t0;
      this.duration = p.record.time;
      p.record.count = this.data.length;
    }
    if (p.t0 === undefined) {
      if (key !== 'caption') {
        if (this.ikeys[key] === undefined) {
          this.ikeys[key] = Object.keys(this.ikeys).length;
        }
        this.init[key] = line[4];
      }
      return;
    }
    if (this.tkeys[key] === undefined) {
      this.tkeys[key] = Object.keys(this.tkeys).length;
    }
    p.telemetry[key] = line[4];
    let nums = null;
    let labels = null;
    if (!/[a-zA-Z][0-9+\-.]/.test(line[4])) {
      const match = line[4].replace(/[^0-9+\-.]+/g, ' ').trim();
      if (match) {
        nums = match.split(/\s+/).map(parseFloat);
      }
      // when every number is prefixed by a word label (e.g. "LX 0.000" or
      // "left: 0"), remember the labels so the exposed keys can use them
      if (nums && nums.length > 1) {
        const pairs = [];
        let pending = null;
        let ok = true;
        line[4].trim().split(/\s+/).forEach((tok) => {
          const lbl = tok.match(/^([A-Za-z]+)[:=]?$/);
          if (lbl) {
            if (pending !== null) {
              ok = false;
            }
            pending = lbl[1];
            return;
          }
          const n = parseFloat(tok);
          if (isFinite(n)) {
            pairs.push([pending, n]);
            pending = null;
          } else {
            ok = false;
          }
        });
        if (ok && pending === null && pairs.length === nums.length && pairs.every((pr) => pr[0] !== null) && new Set(pairs.map((pr) => pr[0])).size === pairs.length) {
          labels = pairs.map((pr) => pr[0]);
        }
      }
    }
    if (!nums || nums.length <= 1) {
      p.keys[key] = p.keys[key] || Object.keys(p.keys).length;
      p.record[key] = nums?.length ? nums[0] : line[4];
    } else {
      nums.forEach((n, i) => {
        const k = labels ? `${key} ${labels[i]}` : `${key} ${i + 1}`;
        p.keys[k] = p.keys[k] || Object.keys(p.keys).length;
        p.record[k] = n;
      });
    }
  }

  _finalize() {
    const p = this._p;
    if (!p.record) {
      return;
    }
    if (this._pendingSnap >= 0) {
      // the trailing record was already snapshotted by a previous append and
      // more rows continued it, so update the snapshot in place
      Object.assign(this.data[this._pendingSnap], p.record);
      Object.assign(this.telemetry[this._pendingSnap], p.telemetry);
    } else {
      this.data.push({ ...p.record });
      this.telemetry.push({ ...p.telemetry });
      this._pendingSnap = this.data.length - 1;
    }
    this.keys = p.keys;
    // Keys that only appear before the OpMode starts (start position,
    // alliance, ...) are never logged again, so they get flushed from the
    // record stream and the initial conditions are lost.  Seed their final
    // pre-start values into every record; keys that do continue after start
    // already carry their values through the change based logging.
    if (this.data.length) {
      Object.keys(this.init).forEach((k) => {
        if (this.tkeys[k] === undefined) {
          // + 2000 orders these after all regular and space prefixed keys in
          // the telemetry table (telemetryKeys adds 1000 for space prefixed
          // keys), so the initial conditions read as a block at the end
          this.tkeys[k] = Object.keys(this.tkeys).length + 2000;
          p.keys[k] = Object.keys(p.keys).length;
          this.data.forEach((r) => {
            r[k] = this.init[k];
          });
          this.telemetry.forEach((t) => {
            t[k] = this.init[k];
          });
        }
      });
    }
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
    $('#addtelemetry.addgrid').removeClass('hidden');
    $('#addfield.addgrid').removeClass('hidden');
    $('#addgraph.addgrid').removeClass('hidden');
    $('#addvideo.addgrid').removeClass('hidden');
    // switch to this to have any number of graphs
    // $('#addgraph.addgrid').removeClass('hidden');
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
    // Clean up video resources
    if (State.videos && State.videos[id]) {
      const videoInfo = State.videos[id];
      if (videoInfo.fileUrl) {
        URL.revokeObjectURL(videoInfo.fileUrl);
      }
      delete State.videos[id];
    }
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
    if (item.id.startsWith('video')) {
      initVideoTile(item.id);
    }
  });
  Grid.on('change', saveState);
  // Initialize video tiles when added to grid
  Grid.on('added', (el) => {
    const id = el.gridstackNode.id;
    if (id.startsWith('video')) {
      initVideoTile(id);
    }
  });
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
  document.getElementById('live-host').value = localStorage.getItem('live-host')
    // when the viewer itself was served by the robot's log web server,
    // default the host to that same address
    || (/^https?:/.test(location.protocol) ? location.host : '');
  document.getElementById('live-host').addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') {
      toggleLive();
    }
  });
  document.getElementById('live').onclick = toggleLive;
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
  document.getElementById('graph-plot').addEventListener('click', graphClickTime);
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
    let pts;
    let cats = uniqueOrder(ykey);
    if (cats) {
      pts = log.data.map((r) => ({ x: parseFloat(r[xkey]), y: cats.order[r[ykey]] })).filter((p) => isFinite(p.x) && isFinite(p.y));
    } else {
      pts = log.data.map((r) => ({ x: parseFloat(r[xkey]), y: parseFloat(r[ykey]) })).filter((p) => isFinite(p.x) && isFinite(p.y));
    }
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
    if (!col.text || col.unique) {
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

function addPlotlySeries(log, gr, xVals, ykey, traceIdx, yaxis, dashList, suffix, traces, cats, traceMeta) {
  let yAll, text, yAll2;
  let hovertemplate = '%{y:.5g}';
  if (!State.columnDict[ykey]) {
    return;
  }
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
            let val = yAll2[ridx] > yAll[ridx - 1] ? yAll2[ridx] - 360 : yAll2[ridx] + 360;
            yAll[ridx] = val >= -30 && val <= 390 && isFinite(val) ? val : yAll[ridx];
            val = yAll[ridx] > yAll2[ridx - 1] ? yAll[ridx - 1] - 360 : yAll[ridx - 1] + 360;
            yAll2[ridx - 1] = val >= -30 && val <= 390 && isFinite(val) ? val : yAll2[ridx - 1];
          } else {
            let val = yAll[ridx] > yAll2[ridx - 1] ? yAll[ridx] - 360 : yAll[ridx] + 360;
            yAll2[ridx] = val >= -30 && val <= 390 && isFinite(val) ? val : yAll2[ridx];

            val = yAll2[ridx] > yAll[ridx - 1] ? yAll2[ridx - 1] - 360 : yAll2[ridx - 1] + 360;
            yAll[ridx - 1] = val >= -30 && val <= 390 && isFinite(val) ? val : yAll2[ridx];
          }
        }
      });
    }
  } else if (State.columnDict[ykey].unique) {
    const cats = uniqueOrder(ykey);
    yAll = log.data.map((r) => cats.order[r[ykey]]);
    text = log.data.map((r) => r[ykey]);
    hovertemplate = '%{text}';
  } else {
    return;
  }
  const dash = dashList[traceIdx % dashList.length];
  const baseColor = PALETTE[traceIdx % PALETTE.length];
  [yAll, yAll2].forEach((yVals, yAllIdx) => {
    if (yVals === undefined) {
      return;
    }
    if (!cats) {
      traces.push({
        x: xVals,
        y: yVals,
        name: ykey + suffix,
        showlegend: yAllIdx === 0,
        legendgroup: ykey + yaxis,
        yaxis,
        text: text,
        mode: 'lines',
        line: { dash, width: 2, color: baseColor },
        hovertemplate: hovertemplate,
      });
      if (traceMeta) {
        traceMeta.push({ log: log.filename, ykey, yaxis });
      }
    } else {
      const segs = [];
      let cur = { cat: cats.values[0], start: 0 };
      for (let i = 1; i < cats.values.length; i++) {
        if (cats.values[i] !== cur.cat) {
          cur.end = i - 1;
          segs.push(cur);
          cur = { cat: cats.values[i], start: i };
        }
      }
      cur.end = cats.values.length - 1;
      segs.push(cur);
      segs.forEach((seg, segidx) => {
        const start = segidx > 0 ? seg.start - 1 : seg.start;
        const xf = xVals.slice(start, seg.end + 1);
        const yf = yVals.slice(start, seg.end + 1);
        const cf = cats.values.slice(start, seg.end + 1);
        traces.push({
          x: xf,
          y: yf,
          name: ykey + suffix,
          showlegend: segidx === 0 && yAllIdx === 0,
          legendgroup: ykey + yaxis,
          yaxis,
          mode: 'lines',
          line: { dash, width: 2, color: cats.colors[seg.cat] },
          customdata: cf.map((c) => [cats.names[c]]),
          hovertemplate: hovertemplate + ' [%{customdata[0]}]',
        });
        if (traceMeta) {
          traceMeta.push(null); // segmented traces cannot be extended incrementally
        }
      });
    }
  });
}

function uniqueOrder(key) {
  if (!State.columnDict[key] || !State.columnDict[key].unique) {
    return;
  }
  const seen = Object.keys(State.columnDict[key].unique);
  const config = CATEGORY_ORDER[key.trim()];
  const list = Array.isArray(config) ? config : config !== undefined ? [config] : [];
  const uni = {};
  uni.names = list.filter((v) => v !== '*' && seen.includes(v));
  const rest = seen.filter((v) => !uni.names.includes(v));
  if (list.includes('*')) {
    uni.names.push(...rest);
  } else {
    uni.names.push(...rest.sort());
  }
  uni.order = Object.fromEntries(uni.names.map((s, i) => [s, i]));
  return uni;
}

function drawGraph(graphNumber) {
  const gr = State.graphs[graphNumber];
  if (!gr.x || !(gr.left.length + gr.right.length)) {
    document.getElementById('graph-plot').innerHTML = '';
    State._graph = undefined;
    updateGraphCursor();
    return;
  }
  const logs = State.sortedLogs.filter((log) => log.selected);
  if (graphNumber === 0 && tryExtendGraph(gr, logs)) {
    updateGraphCursor();
    return;
  }
  const traces = [];
  const traceMeta = [];
  logs.forEach((log) => {
    const xVals = log.data.map((r) => {
      const v = r[gr.x];
      return isFinite(+v) ? +v : v;
    });
    let cats = uniqueOrder(gr.category);
    if (cats) {
      cats.colors = {};
      cats.names.forEach((c, i) => (cats.colors[c] = PALETTE[i % PALETTE.length]));
      cats.values = log.data.map((r) => cats.order[r[gr.category]]);
    }
    gr.left.forEach((ykey, idx) => {
      addPlotlySeries(log, gr, xVals, ykey, traces.length, 'y', LDASH, '', traces, cats, traceMeta);
    });
    gr.right.forEach((ykey, idx) => {
      addPlotlySeries(log, gr, xVals, ykey, traces.length, 'y2', RDASH, ' (R)', traces, undefined, traceMeta);
    });
  });

  Plotly.react(
    'graph-plot',
    traces,
    {
      autosize: true,
      margin: { l: 80, r: 80, t: 30, b: 30 },
      hovermode: 'x unified',
      showlegend: traces.filter((trace) => trace.showlegend !== false).length <= MAX_LEGEND_ENTRIES,
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
  )
    .then(() => {
      // Plotly.react is asynchronous; the cursor cannot be positioned until the
      // new layout has been applied.
      const gd = document.getElementById('graph-plot');
      if (!gd._cursorHooked) {
        gd._cursorHooked = true;
        gd.on('plotly_relayout', updateGraphCursor);
      }
      updateGraphCursor();
    });
  // remember what was drawn so a later live update can extend the traces
  // incrementally instead of redrawing everything
  State._graph = {
    gr: { x: gr.x, category: gr.category, left: [...gr.left], right: [...gr.right] },
    meta: traceMeta,
    lengths: Object.fromEntries(logs.map((log) => [log.filename, log.data.length])),
  };
}

/** Extend the live graph with just the newly appended rows. Returns false (and
 * leaves the drawing alone) whenever anything structural changed, in which
 * case the caller falls back to a full redraw. This keeps the per-update cost
 * proportional to the new data instead of the whole log, which matters once a
 * live log grows large. */
function tryExtendGraph(gr, logs) {
  const prev = State._graph;
  const gd = document.getElementById('graph-plot');
  if (!prev || !gd.data || !gd.data.length) {
    return false;
  }
  if (prev.gr.x !== gr.x || prev.gr.category !== gr.category
      || prev.gr.left.join() !== gr.left.join() || prev.gr.right.join() !== gr.right.join()) {
    return false;
  }
  if (gr.category) {
    return false; // category segmentation: full redraw
  }
  // every previously drawn log must still be selected and only have grown
  if (logs.length !== Object.keys(prev.lengths).length) {
    return false;
  }
  const lengths = {};
  for (const log of logs) {
    const len = prev.lengths[log.filename];
    if (len === undefined || log.data.length < len) {
      return false;
    }
    lengths[log.filename] = log.data.length;
  }
  // every configured series must still be numeric
  for (const ykey of [...gr.left, ...gr.right]) {
    const col = State.columnDict[ykey];
    if (!col || col.text) {
      return false;
    }
  }
  const xArrs = [];
  const yArrs = [];
  const indices = [];
  for (let i = 0; i < gd.data.length; i++) {
    const m = prev.meta[i];
    if (!m) {
      return false;
    }
    const log = Logs[m.log];
    if (!log || !log.selected) {
      return false;
    }
    const start = prev.lengths[m.log];
    if (log.data.length === start) {
      continue; // nothing new for this trace
    }
    const ey = gd.data[i].y;
    for (let k = 0; k < ey.length; k++) {
      if (ey[k] === null) {
        return false; // angle unwrap rewrote history: full redraw
      }
    }
    const xnew = [];
    const ynew = [];
    let last = ey[ey.length - 1];
    for (let r = start; r < log.data.length; r++) {
      const yv = parseFloat(log.data[r][m.ykey]);
      if (!isFinite(yv)) {
        return false; // went nonnumeric: full redraw
      }
      if (Math.abs(yv - last) > 330) {
        return false; // possible angle wrap: full redraw
      }
      const xv = log.data[r][gr.x];
      xnew.push(isFinite(+xv) ? +xv : xv);
      ynew.push(yv);
      last = yv;
    }
    xArrs.push(xnew);
    yArrs.push(ynew);
    indices.push(i);
  }
  if (indices.length) {
    Plotly.extendTraces(gd, { x: xArrs, y: yArrs }, indices);
    // extendTraces does not rescale; keep the live edge in view
    Plotly.relayout(gd, { 'xaxis.autorange': true, 'yaxis.autorange': true, 'yaxis2.autorange': true });
  }
  State._graph.lengths = lengths;
  return true;
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
    .position((d, i, t, j) => {
      if (!State.sortedLogs[j].selected) {
        return { x: -10000, y: -10000 };
      }
      if (!isFinite(d['Field position 1']) || !isFinite(d['Field position 2']) || !isFinite(d['Field position 3'])) {
        // bad or missing positions get the unselected off field sentinel so
        // NaN coordinates are never projected
        return { x: -10000, y: -10000 };
      }
      return { x: d['Field position 1'], y: -d['Field position 2'], angle: (d['Field position 3'] * Math.PI) / 180 };
    })
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

/** True while the log we are following is the one being played back. */
function liveFollowSelected() {
  return Live.active && !!Logs[Live.file]?.selected;
}

function playUpdate() {
  State.animationTimer = null;
  if (!State.playing) {
    return;
  }
  let speed = SPEED_VALUES[$('#speed').val()] || 1;
  // while following a live log, the playback ceiling is that log's own last
  // record time, which advances with every poll; State.maxDuration only
  // refreshes on the throttled dashboard update, so using it alone would
  // make the live edge (telemetry, field, cursor) step in visible bursts
  const liveLog = liveFollowSelected() ? Logs[Live.file] : null;
  const maxTime = liveLog && isFinite(liveLog.duration) ? Math.max(State.maxDuration, liveLog.duration) : State.maxDuration;
  let newTime = (Date.now() - State.referenceTime) * 0.001 * speed + State.baseTime;
  const atEnd = newTime >= maxTime;
  setTime(Math.min(maxTime, newTime), undefined, false, true);
  if (atEnd && liveLog) {
    // following a live log: pin at the live edge and keep rolling instead of
    // pausing; the next poll extends the log and playback continues from
    // there, so a poll that falls behind never looks like the end
  } else if (atEnd) {
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
    // rebuilding the options on every refresh flickers and closes an open
    // dropdown, so only rebuild when the set of logs or their selection
    // changes, and update the existing options' labels in place otherwise
    const signature = items.map((i) => `${i.filename}:${i.selected ? 1 : 0}`).join('|');
    if (sel.dataset.signature === signature) {
      [...sel.options].forEach((opt, idx) => {
        if (items[idx]) {
          opt.textContent = `${items[idx].displayname} (${items[idx].duration.toFixed(2)}s)`;
        }
      });
    } else {
      sel.dataset.signature = signature;
      sel.innerHTML = items.map((i) => `<option value="${i.filename}"${i.selected ? ' selected' : ''}>${i.displayname} (${i.duration.toFixed(2)}s)</option>`).join('');
    }
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
  // console.log(State); // DWM::
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
  syncVideos(State.time);
}

function updateGraphCursor() {
  const gr = State.graphs[0];
  const gd = document.getElementById('graph-plot');
  let applied;
  if (gr.x === 'time' && gd.data && gd.data.length && gd.querySelector('.main-svg')) {
    try {
      let layout = gd._fullLayout;
      let x = layout.xaxis.l2p(State.time) + layout.margin.l;
      if (isFinite(x) && State.time >= 0) {
        $('#graph-cursor').css('left', x - 1 + 'px');
        applied = true;
      }
    } catch (err) {
      applied = false;
    }
  }
  $('#graph-cursor').toggleClass('hidden', !applied);
}

/**
 * Set the current time based on a click on the graph, when the x axis is time.
 */
function graphClickTime(evt) {
  const gr = State.graphs[0];
  if (gr.x !== 'time') {
    return;
  }
  const gd = document.getElementById('graph-plot');
  const layout = gd._fullLayout;
  if (!layout || !gd.data || !gd.data.length) {
    return;
  }
  const rect = gd.getBoundingClientRect();
  const px = evt.clientX - rect.left - layout._size.l;
  const py = evt.clientY - rect.top - layout._size.t;
  // ignore clicks outside the plotting area (mode bar, margins, legend)
  if (px < 0 || px > layout._size.w || py < 0 || py > layout._size.h) {
    return;
  }
  const time = layout.xaxis.p2l(px);
  if (isFinite(time)) {
    setTime(Math.max(0, Math.min(time, State.maxDuration)));
  }
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
  /* Incremental: each log remembers how many rows have already been folded
   * into the column state, so a growing live log only scans its new rows.
   * A full rebuild (from row 0) happens only when the set of loaded logs
   * changes, matching what a from-scratch scan would produce. */
  const signature = State.sortedLogs.map((log) => log.filename).join('|');
  if (!State.columnDict || signature !== State.catSig) {
    State.columnDict = {};
    State.sortedLogs.forEach((log) => {
      log._catScan = { rows: 0, keys: -1 };
    });
    State.catSig = signature;
  }
  const columns = State.columnDict;
  const scanValue = (col, val) => {
    if (col.text && col.unique === undefined) {
      return; // nothing more this column can learn
    }
    if (val !== undefined && val !== null && val !== '' && val !== 'NaN') {
      col.any = true;
      if (!isFinite(val)) {
        col.text = true;
      }
      if (col.unique !== undefined) {
        // count distinct values instead of calling Object.keys().length
        // per row; the enumeration was a large share of load time
        if (col.unique[val] === undefined) {
          col.unique[val] = true;
          col.uniqCount += 1;
        }
        if (col.uniqCount > 50) {
          col.unique = undefined;
        }
      }
    }
  };
  State.sortedLogs.forEach((log) => {
    if (!log._catScan) {
      log._catScan = { rows: 0, keys: -1 };
    }
    const scan = log._catScan;
    const keyList = Object.keys(log.keys).sort((a, b) => log.keys[a] - log.keys[b]);
    if (scan.keys !== keyList.length) {
      // new keys appeared: register their columns and scan their full history
      keyList.forEach((key) => {
        if (!columns[key]) {
          columns[key] = { key: key, unique: {}, text: false, uniqCount: 0, pos: Object.keys(columns).length };
          for (let r = 0; r < log.data.length; r += 1) {
            scanValue(columns[key], log.data[r][key]);
          }
        }
      });
      scan.keys = keyList.length;
    }
    for (let r = scan.rows; r < log.data.length; r += 1) {
      const row = log.data[r];
      keyList.forEach((key) => {
        if (columns[key]) {
          scanValue(columns[key], row[key]);
        }
      });
    }
    scan.rows = log.data.length;
  });
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
    let inventory;
    if (tpos[idx].posidx !== undefined) {
      const ang = log.data[tpos[idx].posidx]['Field position 3'];
      if (!isFinite(ang)) {
        return;
      }
      tpos[idx].angle = -(ang * Math.PI) / 180;
      indexer = log.data[tpos[idx].posidx]['Indexer Position'];
      inventory = log.data[tpos[idx].posidx]['Inventory'];
    } else {
      const ang0 = log.data[tpos[idx].posidx0]['Field position 3'];
      let ang1 = log.data[tpos[idx].posidx1]['Field position 3'];
      if (!isFinite(ang0) || !isFinite(ang1)) {
        return;
      }
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
      inventory = log.data[tpos[idx].posidx0]['Inventory'];
    }
    qidx = addRobotImage(State.quadData, qidx, tpos[idx], log.data[0]["IMU Octoquad"] !== undefined ? 1 : 0);
    qidx = addPartImage(State.quadData, qidx, tpos[idx], [0, 0, 1.75, -indexer]);
    if (inventory) {
      inventory.split(' ').forEach((inv, invidx) => {
        if (PART_COLOR[inv] !== undefined) {
          qidx = addPartImage(State.quadData, qidx, tpos[idx], [PART_COLOR[inv], 0, 1.75, 180 + 120 * invidx - indexer]);
        }
      });
    }
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
  // updateLogs() recategorizes all columns and redraws the graph, which is
  // expensive; only do it once after all the selected files are parsed
  let remaining = 0;
  for (idx = 0; idx < evt.target.files.length; idx += 1) {
    const file = evt.target.files[idx];
    if (!file) {
      return;
    }
    remaining += 1;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const log = new LogRecord(evt.target.result, file.name);
      if (log.valid) {
        if (Logs[log.filename] !== undefined) {
          log.selected = Logs[log.filename].selected;
        }
        Logs[log.filename] = log;
      }
      remaining -= 1;
      if (!remaining) {
        updateLogs();
      }
    };
    reader.readAsText(file);
  }
}

function initVideoTile(tileId) {
  const panelEl = document.querySelector(`[gs-id="${tileId}"] .grid-stack-item-content`);
  if (!panelEl) return;
  if (State.videos[tileId]) {
    return;
  }
  const fileInput = panelEl.querySelector('.video-file-input');
  const videoContainer = panelEl.querySelector('.video-container');
  if (!fileInput || !videoContainer) {
    console.error(`Video tile ${tileId} missing required elements`);
    return;
  }
  let video = videoContainer.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.playsinline = true;
    video.webkitPlaysinline = true;
    video.loop = false;
    video.style.objectFit = 'contain';
    videoContainer.appendChild(video);
  }
  State.videos[tileId] = {
    element: video,
    fileUrl: null,
    duration: NaN,
    offset: 0,
  };
  fileInput.addEventListener('change', (e) => handleVideoFileSelect(e, tileId));
}

function handleVideoFileSelect(event, tileId) {
  const file = event.target.files[0];
  if (!file || !State.videos[tileId]) return;
  const videoInfo = State.videos[tileId];
  // Revoke old URL if exists
  if (videoInfo.fileUrl) {
    URL.revokeObjectURL(videoInfo.fileUrl);
  }
  videoInfo.fileUrl = URL.createObjectURL(file);
  const video = videoInfo.element;
  video.src = videoInfo.fileUrl;

  // Set up metadata loaded listener to get video duration
  const onLoadMetadata = () => {
    videoInfo.duration = video.duration;
    updateVideoOffset(tileId);
  };
  video.addEventListener('loadedmetadata', onLoadMetadata, { once: true });

  // DWM::
  videoInfo.lastSeekTime = -100;
  video.load();
}

function updateVideoOffset(tileId) {
  const videoInfo = State.videos[tileId];
  if (!videoInfo || !isFinite(videoInfo.duration)) return;
  const maxDuration = State.maxDuration || 0;
  videoInfo.offset = videoInfo.duration - maxDuration;
}

function syncVideos(currentTime) {
  if (!State.videos || Object.keys(State.videos).length === 0) return;
  const maxDuration = State.maxDuration || 0;
  Object.entries(State.videos).forEach(([tileId, videoInfo]) => {
    updateVideoOffset(tileId);
  });
  Object.entries(State.videos).forEach(([tileId, videoInfo]) => {
    if (!videoInfo.element) return;
    if (!videoInfo.fileUrl || !isFinite(videoInfo.duration)) return;
    const element = videoInfo.element;
    let videoTime = currentTime + videoInfo.offset;
    if (videoInfo.duration <= maxDuration) {
      if (videoTime < 0) {
        videoTime = 0;
      }
    } else {
      videoTime = Math.min(videoTime, videoInfo.duration);
    }
    const clampedVideoTime = Math.max(0, Math.min(videoTime, videoInfo.duration));
    const tolerance = 0.016;
    const timeDiff = Math.abs(element.currentTime - clampedVideoTime);
    const isSeekingOrLoading = !isFinite(element.currentTime) || element.seeking || element.readyState < 3;

    if (timeDiff > tolerance && !isSeekingOrLoading) {
      element.currentTime = clampedVideoTime;
    }
  });
}

function liveStatus(message) {
  document.getElementById('live-status').textContent = message;
}

function stopLive() {
  Live.active = false;
  clearTimeout(Live.timer);
  clearTimeout(Live.uiTimer);
  Live.timer = null;
  Live.uiTimer = null;
  Live.busy = false;
  $('#live').text('Live');
  liveStatus('');
}

async function toggleLive() {
  if (Live.active) {
    stopLive();
    return;
  }
  const host = document.getElementById('live-host').value.trim();
  if (!host) {
    liveStatus('enter a robot ip');
    return;
  }
  localStorage.setItem('live-host', host);
  // accept a bare host, host:port, or a full origin; the log server's default
  // port is added when no port was entered
  const parsed = host.match(/^(https?:\/\/)?([^/:?#]+)(?::(\d+))?(?:\/.*)?$/);
  if (!parsed) {
    liveStatus('invalid address');
    return;
  }
  Live.base = `${parsed[1] || 'http://'}${parsed[2]}:${parsed[3] || 6955}`;
  Live.active = true;
  Live.file = null;
  Live.log = null;
  Live.offset = 0;
  Live.pending = '';
  Live.listedAt = 0;
  Live.nextPoll = 0;
  $('#live').text('Stop');
  liveStatus('connecting...');
  await livePoll();
}

async function livePoll() {
  if (!Live.active || Live.busy) {
    return;
  }
  Live.busy = true;
  try {
    // refresh the listing only often enough to notice new files; the tail
    // of the followed file is fetched every poll
    const now = Date.now();
    if (!Live.file || now - Live.listedAt >= (Live.file ? Live.listMs : 250)) {
      Live.listedAt = now;
      const response = await fetch(`${Live.base}/api/logs`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const listing = await response.json();
      // the most recent log: file names carry a zero-padded sequence number
      // (log_NNNN_...), so the greatest name is the newest. mtime is not used
      // because the robot clock sometimes starts at epoch 0.
      const newest = listing.reduce(
        (best, entry) => (!best || entry.name > best.name ? entry : best),
        null,
      );
      if (!newest) {
        Live.file = null;
        Live.log = null;
        Live.offset = 0;
        Live.pending = '';
        liveStatus('no logs on robot');
        return;
      }
      if (newest.name !== Live.file) {
        // a newer log started: follow it from the beginning. The previously
        // followed log stays in the list (unselected) so it can still be
        // reviewed after the run.
        const previous = Live.file;
        Live.file = newest.name;
        Live.log = new LogRecord(undefined, newest.name);
        Live.offset = 0;
        Live.pending = '';
        if (previous) {
          if (Logs[previous]) {
            Logs[previous].selected = false;
          }
          // updateLogs() re-reads selection from the DOM select, so the option
          // has to be deselected there as well
          const option = [...document.getElementById('logs').options].find((o) => o.value === previous);
          if (option) {
            option.selected = false;
          }
        }
      }
    }
    if (Live.file) {
      await liveFetchMore();
    }
  } catch (err) {
    liveStatus(`unreachable (${err})`);
  } finally {
    Live.busy = false;
  }
  if (Live.active) {
    // self-correcting pacing: schedule against the absolute due time so a
    // late timer or slow poll does not drift the average rate below pollMs
    const now = Date.now();
    Live.nextPoll = (Live.nextPoll > now - 1000 ? Live.nextPoll : now) + Live.pollMs;
    Live.timer = setTimeout(livePoll, Math.max(0, Live.nextPoll - Date.now()));
  }
}

/** Fetch the followed log from Live.offset onward and feed any new complete
 * lines into the incrementally parsed LogRecord. */
async function liveFetchMore() {
  const name = Live.file;
  const response = await fetch(`${Live.base}/log/${encodeURIComponent(name)}`, {
    headers: { Range: `bytes=${Live.offset}-` },
  });
  if (response.status === 416) {
    return; // range past the end: no new data
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) {
    return;
  }
  const chunk = new TextDecoder().decode(bytes);
  // only consume through the last complete line: the tail of a file being
  // written may end mid-line, and a partial line would parse wrong
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline < 0) {
    return; // nothing complete yet; retry from the same offset next poll
  }
  const complete = Live.pending + chunk.slice(0, lastNewline + 1);
  if (!Live.log.append(complete, true)) {
    // a quoted field spans the fetch boundary; hold the text back and retry
    // it together with the next poll's bytes (give up on very large held
    // back text so a corrupt file cannot stall following forever)
    if (complete.length < 5 * 1024 * 1024) {
      Live.pending = complete;
      return;
    }
    Live.log.append(complete);
  }
  Live.pending = '';
  Live.offset += new TextEncoder().encode(complete).length;
  scheduleLiveUpdate();
}

/** Publish the growing LogRecord into the log list and refresh the UI. The
 * per-poll data ingest is cheap, but the dashboard refresh (log list, graph
 * extension and rescale, track rebind) should not run per poll; 150 ms keeps
 * the updates from pulsing while leaving the main thread mostly free.
 * Telemetry values and the graph cursor also track the live edge every frame
 * via updateNow() from the playback loop. */
function scheduleLiveUpdate() {
  if (Live.uiTimer || !Live.log) {
    return;
  }
  Live.uiTimer = setTimeout(() => {
    Live.uiTimer = null;
    if (!Live.active || !Live.log || !Live.log.valid) {
      return;
    }
    const name = Live.file;
    const existing = Logs[name];
    const fresh = !existing;
    Live.log.selected = existing ? existing.selected : true;
    if (existing !== Live.log) {
      Logs[name] = Live.log;
    }
    updateLogs();
    if (fresh) {
      // first time this log appears: jump to the live edge and start playing
      setTime(Live.log.duration);
      startPlayTimer();
    }
    liveStatus(`live: ${name} (${Live.log.data.length} rows)`);
  }, 150);
}

document.addEventListener('DOMContentLoaded', initGrid);

// TODO:
// realign tracks
// multiple graphs
// hide tracks
// default size based on window aspect ratio
// reset tile positions based on window aspect ratio
// visualize shoot lines
// visualize april tag positions / bearings
// overlay hood / flywheel settings
// test dark mode colors
