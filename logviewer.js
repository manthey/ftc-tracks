const STORAGE_KEY = "gs-dashboard";
const GRID_COLS = 12;

let Grid;
let GridEditMode = false;

const DEFAULT_LAYOUT = [
  { x: 0, y: 0, w: 4, h: 2, id: "control" },
  { x: 0, y: 2, w: 4, h: 8, id: "telemetry" },
  { x: 4, y: 0, w: 8, h: 4, id: "graph" },
  { x: 4, y: 4, w: 6, h: 8, id: "field" },
  { x: 0, y: 10, w: 4, h: 2, id: "playback" },
  { x: 10, y: 4, w: 2, h: 8, id: "video" },
];

class LogRecord {
  constructor(rawdata, filename) {
    this.filename = filename;
    this.displayname = (filename.includes('_') ? filename.split('_').slice(1).join('_') : filename).split('.')[0].replace(/_/g, ' ');
    this.init = {};
    this.data = [];
    this.telemetry = [];
    const tkeys = {};
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
      if (key === "loop time") {
        if (telemetry) {
          this.telemetry.push(telemetry);
        }
        record = record ? (this.data.push({ ...record }), { ...record }) : {};
        const t = parseFloat(line[0]);
        t0 = t0 ?? t;
        keys.time = true;
        keys.count = true;
        telemetry = {};
        record.time = t - t0;
        record.count = this.data.length;
      }
      if (t0 === undefined) {
        this.init[key] = line[4];
        continue;
      }
      if (tkeys[key] === undefined) {
        tkeys[key] = Object.keys(tkeys).length;
      }
      telemetry[key] = line[4];
      let nums = null;
      if (!/[a-zA-Z][0-9+\-.]/.test(line[4])) {
        const match = line[4].replace(/[^0-9+\-.]+/g, " ").trim();
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
      this.tkeys = tkeys;
    }
    if (this.data.length < 2) {
      this.data = undefined;
    }
  }

  parseLine(line) {
    const fields = [];
    let currentField = "";
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
      } else if (char === "," && !insideQuotes) {
        fields.push(currentField);
        currentField = "";
      } else {
        currentField += char;
      }
    }
    fields.push(currentField);
    return fields;
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
      if (!d.items.find((i) => i.id === "control")) {
        d.items.unshift(DEFALT_LAYOUT[0]);
      }
      return d;
    }
  } catch (e) {}
  return { items: DEFAULT_LAYOUT, editMode: GridEditMode };
}

function buildContent(id) {
  const elem = document.getElementById(id.split("-")[0] + "panel");
  let html;
  if (elem) {
    html = $(elem.outerHTML).removeClass("hidden")[0].outerHTML;
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
    tile.y = tiles.reduce(
      (maxY, other) =>
        other !== tile &&
        tile.x < other.x + other.w &&
        tile.x + tile.w > other.x &&
        other.y + other.h <= tile.y
          ? Math.max(maxY, other.y + other.h)
          : maxY,
      0,
    );
  });
  tiles.forEach((tile) => {
    tile.w = tiles.reduce(
      (maxWidth, other) =>
        other !== tile &&
        tile.y < other.y + other.h &&
        tile.y + tile.h > other.y &&
        other.x >= tile.x + tile.w
          ? Math.min(maxWidth, other.x - tile.x)
          : maxWidth,
      GRID_COLS - tile.x,
    );
  });
  tiles.forEach((tile) => {
    let minX = tiles.reduce(
      (minX, other) =>
        other !== tile &&
        tile.y < other.y + other.h &&
        tile.y + tile.h > other.y &&
        other.x + other.w <= tile.x
          ? Math.max(minX, other.x + other.w)
          : minX,
      0,
    );
    tile.w += tile.x - minX;
    tile.x = minX;
  });
  const maxY = Math.max(Math.max(...tiles.map((tile) => tile.y + tile.h)), 6);
  tiles.forEach((tile) => {
    tile.h = tiles.reduce(
      (maxHeight, other) =>
        other !== tile &&
        tile.x < other.x + other.w &&
        tile.x + tile.w > other.x &&
        other.y >= tile.y + tile.h
          ? Math.min(maxHeight, other.y - tile.y)
          : maxHeight,
      maxY - tile.y,
    );
  });
  const cellH = Math.floor(window.innerHeight / maxY);
  Grid.batchUpdate();
  Grid.cellHeight(cellH);
  tiles.forEach((tile) =>
    Grid.update(tile.el, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }),
  );
  Grid.batchUpdate(false);
}

function toggleEdit(editMode) {
  GridEditMode = editMode !== undefined ? editMode : !GridEditMode;
  Grid.enableMove(GridEditMode);
  Grid.enableResize(GridEditMode);
  $("#editgrid").toggleClass("hidden", GridEditMode);
  $("#lockgrid").toggleClass("hidden", !GridEditMode);
  showAddButtons();
  Grid.getGridItems().forEach((el) => {
    $(".close-btn", el).toggleClass("hidden", !GridEditMode);
  });
  fitGrid();
  saveState();
}

function showAddButtons() {
  if (!GridEditMode) {
    $(".addgrid").addClass("hidden");
  } else {
    $("#addgraph.addgrid, #addvideo.addgrid").removeClass("hidden");
    $("#addfield.addgrid").toggleClass(
      "hidden",
      Grid.getGridItems().some((el) => el.gridstackNode.id === "field"),
    );
    $("#addtelemetry.addgrid").toggleClass(
      "hidden",
      Grid.getGridItems().some((el) => el.gridstackNode.id === "telemetry"),
    );
  }
}

function addPanel(id) {
  const baseId = id;
  let num = 1;
  while (
    Grid.getGridItems().some((el) => el.gridstackNode.id === id) &&
    num < 10
  ) {
    console.log(num);
    num += 1;
    id = `${baseId}-${num}`;
  }
  const el = Grid.addWidget({ w: GRID_COLS, h: 2, id: id, autoPosition: true });
  el.querySelector(".grid-stack-item-content").innerHTML = buildContent(id);
  fitGrid(true);
  showAddButtons();
  $(".close-btn", el).toggleClass("hidden", !GridEditMode);
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
    el.querySelector(".grid-stack-item-content").innerHTML = buildContent(
      item.id,
    );
  });
  Grid.on("change", saveState);
  document.body.addEventListener("click", (e) => {
    if (e.target.id === "editgrid" || e.target.id === "lockgrid") {
      toggleEdit(e.target.id === "editgrid");
    } else if (e.target.classList.contains("close-btn")) {
      removePanel(e.target.dataset.id);
    } else if (e.target.classList.contains("addgrid")) {
      addPanel(e.target.dataset.id);
    }
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitGrid();
    }, 150);
  });
  fitGrid();

  document.getElementById("file").onchange = loadFiles;
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
      console.log(log);
      /*
    // add to drop down, alphabetize, update displays
    init();
    document.getElementById("cfg").disabled = false;
    show();
    */
    };
    reader.readAsText(file);
  };
}

document.addEventListener("DOMContentLoaded", initGrid);


/*
function orderedUnion(dicts) {
    const minValues = {};
    
    dicts.forEach(dict => {
        Object.entries(dict).forEach(([key, value]) => {
            if (!(key in minValues) || value < minValues[key]) {
                minValues[key] = value;
            }
        });
    });
    
    return Object.keys(minValues).sort((a, b) => {
        if (minValues[a] !== minValues[b]) {
            return minValues[a] - minValues[b];
        }
        return a < b ? -1 : a > b ? 1 : 0;
    });
}
*/