const STORAGE_KEY = 'gs-dashboard';
const GRID_COLS = 12;

let Grid;
let GridEditMode = false;
let Logs = {};
const State = {
  time: 0,
};

const DEFAULT_LAYOUT = [
  { x: 0, y: 0, w: 4, h: 2, id: 'control' },
  { x: 0, y: 2, w: 4, h: 9, id: 'telemetry' },
  { x: 0, y: 11, w: 4, h: 1, id: 'playback' },
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
        keys.time = true;
        keys.count = true;
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
        keys[key] = true;
        record[key] = nums?.length ? nums[0] : line[4];
      } else {
        nums.forEach((n, i) => {
          const k = `${key} ${i + 1}`;
          keys[k] = true;
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
}

function toggleEdit(editMode) {
  GridEditMode = editMode !== undefined ? editMode : !GridEditMode;
  Grid.enableMove(GridEditMode);
  Grid.enableResize(GridEditMode);
  $('#editgrid').toggleClass('hidden', GridEditMode);
  $('#lockgrid').toggleClass('hidden', !GridEditMode);
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
    $('#addgraph.addgrid, #addvideo.addgrid').removeClass('hidden');
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

function initGrid() {
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
    const speedValue = { '-6': 0.01, '-5': 0.02, '-4': 0.05, '-3': 0.1, '-2': 0.2, '-1': 0.1, 0: 1, 1: 2, 2: 5, 3: 10 };
    $('#speed-value').text(`${speedValue[$('#speed').val()]}x`);
  });
}

function setTime(time, id, skipUpdate) {
  if (isFinite(time)) {
    State.time = parseFloat(time);
    State.baseTime = State.time;
    State.referenceTime = Date.now();
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
  let maxDuration = Object.values(Logs).reduce((duration, log) => Math.max(duration, log.selected ? log.duration : 0), 0);
  $('#time').attr('max', maxDuration);
  if (State.time > maxDuration) {
    setTime(maxDuration, undefined, true);
  }
  // DWM::
  console.log(State);
  updateNow();
}

/**
 * Update all the data based on the time.
 */
function updateNow() {
  updateTelemetry();
  // DWM::
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
