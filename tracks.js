const defaultSettings = {
  maxSpeed: 60,  // inches per second
  defaultSpeed: 0.75,  // driveTo default
  stopTime: 0.5,  // seconds when driveTo stops
  asArrows: false,  // how to render robot
  matsAs24: true, // true to pretend mats are 24 inches rather than 23.625
  showText: true,
  showArrows: true,
  showPath: true,
  playInitialPause: 3,
  playFinalPause: 3,
  fullSpeedDistance: 12,
  noStopFullSpeedDistance: 12,
  minSpeed: 0.1,
  timeToSpeedUp: 0.5,
  field: ['intothedeep.png', 72, 72, 72, 72],  // url, left, top, right, bot
  robots: [  // url, left, front, right, back
    ['robot30dpi282x365.png', 9.4, 12.166, 9.3, 8.9],
    ['robot_ext30dpi261x572.png', 8.7, 19.066, 8.6, 8.666]
  ]
};

/* Decode query components into a dictionary of values.
 *
 * @returns {object}: the query parameters as a dictionary.
 */
function getQuery() {
  var query = document.location.search.replace(/(^\?)/, '').split(
    '&').map(function (n) {
    n = n.split('=');
    if (n[0]) {
      this[decodeURIComponent(n[0].replace(/\+/g, '%20'))] = decodeURIComponent(n[1].replace(/\+/g, '%20'));
    }
    return this;
  }.bind({}))[0];
  return query;
}

/* Encode a dictionary of parameters to the query string, setting the window
 * location and history.  This will also remove undefined values from the
 * set properties of params.
 *
 * @param {object} params The query parameters as a dictionary.
 * @param {boolean} [updateHistory] If true, update the browser history.  If
 *    falsy, replace the history state.
 */
function setQuery(params, updateHistory) {
  $.each(params, function (key, value) {
    if (value === undefined) {
      delete params[key];
    }
  });
  var newurl = window.location.protocol + '//' + window.location.host +
      window.location.pathname + '?' + $.param(params);
  if (updateHistory) {
    window.history.pushState(params, '', newurl);
  } else {
    window.history.replaceState(params, '', newurl);
  }
}

function syncSliderWithInput(slider, input) {
  slider.addEventListener('input', () => {
    input.value = slider.value;
  });
  input.addEventListener('input', () => {
    slider.value = input.value;
  });
}

function updateImage(project, track) {
  var markers = track.layer().features()[6];
  if (!markers) {
    return;
  }
  mdata = markers.data();
  const quadData = project.quadData;
  while (quadData.length > mdata.length + 1 && quadData.length > 2) {
    quadData.pop();
  }
  while (quadData.length < mdata.length + 1) {
    quadData.push(Object.assign({}, quadData[quadData.length-1]));
  }
  let tpos = project.track.calculateTimePosition(project.track.endTime(), undefined, true);
  mdata.forEach((mdat, idx) => {
    if (!mdat[0].show || project.settings.asArrows) {
      quadData[idx + 1].ur = quadData[idx + 1].lr = quadData[idx + 1].ll = quadData[idx + 1].ul = {x: -1000, y: -1000};
      return;
    }
    var pos = markers.position()(mdat, idx);
    if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.angle) || pos.x < -100 || pos.x > 100 || pos.y < -100 || pos.y > 100) {
      quadData[idx + 1].ur = quadData[idx + 1].lr = quadData[idx + 1].ll = quadData[idx + 1].ul = {x: -1000, y: -1000};
      return;
    }
    pos.angle = markers.style('rotation')(mdat, idx);
    let rnum = project.track.data()[idx][tpos[idx].posidx !== undefined ? tpos[idx].posidx : (tpos[idx].factor0 >= 0.5 ? tpos[idx].posidx0 : tpos[idx].posidx1)].imgnum || 0;
    if (rnum >= project.settings.length) {
      rnum = 0;
    }
    var left = project.settings.robots[rnum][1];
    var front = project.settings.robots[rnum][2];
    var right = project.settings.robots[rnum][3];
    var back = project.settings.robots[rnum][4];
    quadData[idx + 1].image = project.settings.robots[rnum][0];
    quadData[idx + 1].ur = {
      x: pos.x + front * Math.cos(pos.angle) - right * Math.sin(pos.angle),
      y: pos.y + front * Math.sin(pos.angle) + right * Math.cos(pos.angle)};
    quadData[idx + 1].lr = {
      x: pos.x + -back * Math.cos(pos.angle) - right * Math.sin(pos.angle),
      y: pos.y + -back * Math.sin(pos.angle) + right * Math.cos(pos.angle)};
    quadData[idx + 1].ll = {
      x: pos.x + -back * Math.cos(pos.angle) - -left * Math.sin(pos.angle),
      y: pos.y + -back * Math.sin(pos.angle) + -left * Math.cos(pos.angle)};
    quadData[idx + 1].ul = {
      x: pos.x + front * Math.cos(pos.angle) - -left * Math.sin(pos.angle),
      y: pos.y + front * Math.sin(pos.angle) + -left * Math.cos(pos.angle)};
  });
  project.quads.data(quadData);
  mdata.forEach((mdat, idx) => {
    project.quads.cacheUpdate(idx + 1);
  });
  const settings = project.settings;
  const matScale = settings.matsAs24 ? 24.0 / 23.75 : 1;
  project.quadData[0].ll = {x: -settings.field[1] * matScale, y: settings.field[4] * matScale};
  project.quadData[0].ur = {x: settings.field[3] * matScale, y: -settings.field[2] * matScale};
  if (project.quadData[0].image !== settings.field[0]) {
    project.quadData[0].image = settings.field[0];
  }
  project.quads.cacheUpdate(0);
  project.quads.layer().map().draw();
}

function updateSelectedTracks(project) {
  let selected = $('#tracks').val();
  project.trackdata.forEach((t) => {
    t[0].show = selected.includes(t[0].path);
  });
  project.track.modified();
  project.used.inuse = [];
  selected.forEach((key) => {
    project.used.inuse = project.used.inuse.concat(project.used[key]);
  });
  project.markers.modified();
  project.text.modified();
  project.map.draw();
  project.map.scheduleAnimationFrame(() => {
    const track = project.track,
      startctl = document.getElementById('start'),
      endctl = document.getElementById('end');
      startvalctl = document.getElementById('start-value'),
      endvalctl = document.getElementById('end-value');
    startctl.setAttribute('max', track.timeRange().maximum || 30);
    endctl.setAttribute('max', track.timeRange().maximum || 30);
    startvalctl.setAttribute('max', track.timeRange().maximum || 30);
    endvalctl.setAttribute('max', track.timeRange().maximum || 30);
    updateImage(project, track);
    project.map.draw();
  });
};

function computePathTime(d, m, f, fm, ta, sd) {
  // Straight drive would be
  // return d / (m * f);
  // distance, maxSpeed, speedFactor, minSpeedFactor, accelerationTime,
  // stoppingDistance
  const delt = 0.01;  // time delta
  let s = 0;
  let t = 0;
  while (s < d) {
    let vf = Math.min(f, ta ? t / ta : f);
    vf = Math.min(vf, (d - s) / sd);
    vf = Math.max(vf, fm);
    s += vf * m * delt;
    t += delt;
  }
  return t;
}

function parsePaths(project) {
  const settings = project.settings;
  var pathtext = $('#paths').val();
  const lines = pathtext.split(/\r?\n/); // Split by newlines
  let paths = [];
  let currentPath = null;

  Object.keys(settings).forEach(key => delete settings[key]);
  Object.assign(settings, defaultSettings);
  settings.robots = settings.robots.slice();
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const fields = line.split(/\s*,\s*/); // Split by commas, ignoring surrounding whitespace

    if (fields[0] === 'Path' && fields.length === 2) {
      currentPath = fields[1];
      if (!paths.length || paths[paths.length - 1].length) {
        paths.push([]); // Start a new path
      }
    } else if ((fields[0] === 'Setting' || fields[0] === 'Settings') && fields.length === 3) {
      if (settings[fields[1]] !== undefined && !Array.isArray(settings[fields[1]])) {
        try {
          if (typeof settings[fields[1]] == 'boolean' || isFinite(fields[2])) {
            settings[fields[1]] = (typeof settings[fields[1]] == 'boolean') ? (fields[2].toLowerCase() === 'true') : parseFloat(fields[2]);
          }
        } catch (err) { }
      }
    } else if (fields[0] === 'Field' && fields.length === 6) {
      if (isFinite(fields[3]) && isFinite(fields[4]) && isFinite(fields[6]) && isFinite(fields[7])) {
        try {
          settings.field = [fields[1], parseFloat(fields[2]), parseFloat(fields[3]), parseFloat(fields[4]), parseFloat(fields[5])];
        } catch (err) { }
      }
    } else if (fields[0] === 'Robot' && fields.length === 7) {
      try {
        const rnum = parseInt(fields[1], 10);
        if (isFinite(fields[4]) && isFinite(fields[5]) && isFinite(fields[6]) && isFinite(fields[7]) && rnum >= 0) {
          while (rnum >= settings.robots.length) {
            settings.robots.push(settings.robots[0]);
          }
          settings.robots[rnum] = [fields[2], parseFloat(fields[3]), parseFloat(fields[4]), parseFloat(fields[5]), parseFloat(fields[6])];
        }
      } catch (err) { }
    } else if (currentPath && fields.length >= 4) {
      let [id, x, y, heading, speed, stop, delay, imgnum] = fields;

      x = parseFloat(x);
      y = parseFloat(y);
      let rotation = -parseFloat(heading) * (Math.PI / 180);
      speed = (speed !== undefined && speed !== '') ? parseFloat(speed) : null;
      stop = (stop !== undefined && stop !== '') ? stop.toLowerCase() === 'true' : true;
      delay = (delay !== undefined && delay !== '') ? parseFloat(delay) : 0;
      imgnum = (imgnum !== undefined && imgnum !== '') ? parseInt(imgnum, 10) : 0;

      if (
        id &&
        !isNaN(x) && !isNaN(y) && !isNaN(rotation) &&
        (speed === null || !isNaN(speed)) &&
        (imgnum === null || (!isNaN(imgnum) && imgnum >= 0))
      ) {
        paths[paths.length - 1].push({
          path: currentPath,
          id,
          x,
          y,
          rotation,
          speed,
          stop,
          delay: 0,
          imgnum
        });
        if (delay) {
          paths[paths.length - 1].push({
            path: currentPath,
            id,
            x,
            y,
            rotation,
            speed,
            stop,
            delay,
            imgnum
          });
        }
      }
    }
  }
  if (paths.length && !paths[paths.length - 1].length) {
    paths.pop();
  }
  var alllocs = {};
  paths.forEach((locs) => {
    project.used[locs[0].path] = locs;
    locs.forEach((loc, idx) => {
      key = loc.path + '_' + loc.id;
      alllocs[key] = loc;
      if (!idx) {
        loc.t = 0;
        return;
      }
      let d = Math.sqrt((locs[idx - 1].x - loc.x) ** 2 + (locs[idx - 1].y - loc.y) ** 2);
      let m = settings.maxSpeed;
      let f = locs[idx].speed || settings.defaultSpeed;
      let fmin = settings.minSpeed;
      let tacc = locs[idx - 1].stop ? settings.timeToSpeedUp : 0;
      let sdec = locs[idx].stop ? settings.fullSpeedDistance : settings.noStopFullSpeedDistance;
      let t = computePathTime(d, m, f, fmin, tacc, sdec);
      loc.t = (
        locs[idx - 1].t + t +
        (locs[idx].stop && !locs[idx].delay ? settings.stopTime : 0) +
        locs[idx].delay);
    });
  });
  project.trackdata = paths;
  project.track.data(paths);
  var markdata = Object.values(alllocs).map((loc) => {
    return {
      x: loc.x,
      y: loc.y,
      loc: loc,
      radius: 10,
      strokeWidth: 5,
      symbol: geo.markerFeature.symbols.arrow,
      // symbolValue: [],
      fillColor: {r: 0, g: 0, b: 0},
      fillOpacity: 1,
      strokeColor: {r: 0, g: 0, b: 0},
      strokeOpacity: 0,
      rotation: loc.rotation
    };
  });
  project.markers.data(markdata);
  var textdata = Object.values(alllocs).map((loc) => {
    return {
      x: loc.x,
      y: loc.y,
      loc: loc,
      name: loc.id
    }
  });
  project.text.data(textdata);
  $('#tracks option').each((idx, opt) => {
    var val = $(opt).attr('value');
    if (!paths.some((path) => path.length && val === path[0].path)) {
      $(opt).remove();
    }
  });
  paths.forEach((path) => {
    if (!path.length) {
      return;
    }
    let pathtext = path[0].path + ' (' + (path[path.length - 1].t).toFixed(2) + 's)';
    if (!$('#tracks option[value="' + path[0].path + '"]').length) {
      $('#tracks').append($('<option>').attr('value', path[0].path).text(pathtext));
    } else {
      $('#tracks option[value="' + path[0].path + '"]').text(pathtext);
    }
  });
  if (!$('#tracks option:selected').length) {
    $('#tracks option:first').attr('selected', 'selected');
  }
  $('#tracks').attr('size', Math.max(2, paths.length + 1));
  project.markers.visible(settings.showArrows);
  project.text.visible(settings.showText);
  project.track.visible(settings.showPath);
  updateSelectedTracks(project);
}

function animate(project) {
  if (!project.animate) {
    return;
  }
  let cur = (Date.now() - project.animate_start) / 1000;
  let selected = $('#tracks').val();
  let maxtime = 0;
  let tnum = 0;
  project.trackdata.forEach((t, idx) => {
    if (selected.includes(t[0].path)) {
      tnum = idx;
      maxtime = Math.max(maxtime, t[t.length - 1].t);
      project.animate_end = project.animate_start + maxtime * 1000;
    }
  });
  if (cur < 0) {
    cur = 0;
  }
  if (cur + 0.001 <= maxtime) {
    project.animate_loop = true;
    $('#end').val(cur);
    $('#end-value').val(cur);
    project.animate_loop = false;
    project.track.endTime(cur).draw();
    updateImage(project, project.track);
    window.setTimeout(() => animate(project), 1);
  } else if (project.animate !== 'all') {
    project.animate = false;
  } else if (project.animate_end && Date.now() < project.animate_end + project.settings.playFinalPause * 1000) {
    window.setTimeout(() => animate(project), 1);
  } else {
    document.getElementById('tracks').selectedIndex = -1;
    tnum = tnum + 1;
    if (tnum >= project.track.data().length) {
      tnum = 0;
    }
    document.getElementById('tracks').selectedIndex = tnum;
    $('#end').val(0);
    $('#end-value').val(0);
    project.animate_start = Date.now() + project.settings.playInitialPause * 1000;
    updateSelectedTracks(project);
    window.setTimeout(() => animate(project), 1);
  }
}

function main() {
  const settings = Object.assign({}, defaultSettings);
  const project = {settings: settings};

  project.trackdata = [];

  project.map = geo.map({
    node: '#map',
    ingcs: '+proj=longlat +axis=esu',
    gcs: '+proj=longlat +axis=enu',
    maxBounds: {left: -90, top: -90, right: 90, bottom: 90},
    unitsPerPixel: 1,
    center: {x: 0, y: 0},
    min: 0,
    max: 6,
    zoom: 0,
    clampBoundsX: true,
    clampBoundsY: true,
    clampZoom: true,
  });

  project.map.geoOn(geo.event.mousemove, function (evt) {
    $('#info').text('x: ' + evt.geo.x.toFixed(6) + ', y: ' + -evt.geo.y.toFixed(6));
  });
  const matScale = settings.matsAs24 ? 24.0 / 23.625 : 1;
  project.quadData = [
    {
      ll: {x: -settings.field[1] * matScale, y: settings.field[4] * matScale},
      ur: {x: settings.field[3] * matScale, y: -settings.field[2] * matScale},
      image: settings.field[0],
    },
    {
      ll: {x: 0, y: 0},
      lr: {x: 0, y: 0},
      ul: {x: 0, y: 0},
      ur: {x: 0, y: 0},
      image: settings.robots[0][0],
    },
  ];
  var layer = project.map.createLayer('feature', {
    features: ['quad', 'marker'],
  });
  var tlayer = project.map.createLayer('feature', {
    features: ['text'],
  });
  project.quads = layer.createFeature('quad');
  project.quads.data(project.quadData);
  project.markers = layer.createFeature('marker');
  project.text = tlayer.createFeature('text');
  var markdata = [];
  var textdata = [];
  project.used = {inuse: []};
  project.markers
    .data(markdata)
    .position((d) => ({x: d.x, y: -d.y}))
    .style({
      radius: (d) => d.radius,
      strokeWidth: (d) => d.strokeWidth,
      symbol: (d) => d.symbol,
      symbolValue: (d) => d.symbolValue,
      fillColor: (d) => d.fillColor,
      fillOpacity: (d) => project.used.inuse.includes(d.loc) ? d.fillOpacity : 0,
      strokeColor: (d) => d.strokeColor,
      strokeOpacity: (d) => d.strokeOpacity,
      rotation: (d) => d.rotation,
      scaleWithZoom: geo.markerFeature.scaleMode.none,
      rotateWithMap: true,
    });
  project.text
    .data(textdata)
    .position((d) => ({x: d.x, y: -d.y}))
    .text((d) => d.name)
    .style({
      color: '#00008040',
      textOpacity: (d) => project.used.inuse.includes(d.loc) ? 1 : 0,
    });

  project.track = layer
    .createFeature('track')
    // set the data to our example data
    .data(project.trackdata)
    // set some style to our lines
    .style({
      strokeWidth: 3,
      strokeColor: 'black',
    })
    .position((d, i, e) => (e[0].show === false ? {x: -10000, y: -10000} : {x: d.x, y: -d.y}))
    .markerStyle({
      symbol: (d) => project.settings.asArrows ? geo.markerFeature.symbols.arrow : geo.markerFeature.symbols.rectangle,
      symbolValue: (d) => project.settings.asArrows ? [1, 1, 0, true] : 1,
      radius: (d) => project.settings.asArrows ? 15 : 12.72 * 0.001, // 13.03, // seems like it should be 12.72
      scaleWithZoom: (d) => project.settings.asArrows ? false : true,
      rotation: function (d, i) {
        let pos = project.track._headPosition(d, i);
        if (pos.posidx !== undefined) {
          return d[pos.posidx].rotation;
        }
        let r1 = d[pos.posidx0].rotation;
        let r2 = d[pos.posidx1].rotation;
        r1 = ((r1 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        r2 = ((r2 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        if (Math.abs(r1 - r2) > Math.PI) {
            if (r1 > r2) {
                r1 -= Math.PI * 2;
            } else {
                r2 -= Math.PI * 2;
            }
        }
        return r1 * pos.factor0 + r2 * pos.factor1;
      },
    });
  project.track.startTime(0).endTime(40).futureStyle('strokeOpacity', 0);
  updateImage(project, project.track);

  project.map.draw();

  var startctl = document.getElementById('start'),
    endctl = document.getElementById('end');
    startvalctl = document.getElementById('start-value'),
    endvalctl = document.getElementById('end-value');
  startctl.setAttribute('max', project.track.timeRange().maximum);
  startctl.setAttribute('min', project.track.timeRange().minimum);
  startctl.setAttribute('value', project.track.timeRange().startTime);
  endctl.setAttribute('min', project.track.timeRange().minimum);
  endctl.setAttribute('max', project.track.timeRange().maximum);
  endctl.setAttribute('value', project.track.timeRange().endTime);
  startvalctl.setAttribute('max', project.track.timeRange().maximum);
  startvalctl.setAttribute('min', project.track.timeRange().minimum);
  startvalctl.setAttribute('value', project.track.timeRange().startTime);
  endvalctl.setAttribute('min', project.track.timeRange().minimum);
  endvalctl.setAttribute('max', project.track.timeRange().maximum);
  endvalctl.setAttribute('value', project.track.timeRange().endTime);

  var query = getQuery();
  var origPaths = $('#paths').val();
  if (query.paths) {
    try {
  	/* Strip out white space and plusses, then convert ., -, and _ to /, +,
  	 * =.  By removing whitespace, the url is more robust against email
  	 * handling.  The others keep things short. */
  	let src = query.paths.replace(/(\s|\+)/g, '').replace(/\./g, '/').replace(/-/g, '+').replace(/_/g, '=');
  	src = new Uint8Array(atob(src).split('').map((c) => c.charCodeAt(0)));
  	src = pako.inflate(src, {to: 'string', raw: true});
      $('#paths').val(src);
    } catch (err) { }
  }

  parsePaths(project);
  startctl.addEventListener('input', (event) => {
    project.track.startTime(event.target.value).draw();
  });
  endctl.addEventListener('input', (event) => {
    project.track.endTime(event.target.value).draw();
    updateImage(project, project.track);
    if (!project.animate_loop) {
      project.animate_start = Date.now() - parseFloat(event.target.value) * 1000;
    }
  });
  startvalctl.addEventListener('input', (event) => {
    project.track.startTime(event.target.value).draw();
  });
  endvalctl.addEventListener('input', (event) => {
    project.track.endTime(event.target.value).draw();
    updateImage(project, project.track);
    if (!project.animate_loop) {
      project.animate_start = Date.now() - parseFloat(event.target.value) * 1000;
    }
  });
  syncSliderWithInput(startctl, startvalctl);
  syncSliderWithInput(endctl, endvalctl);

  function updatePaths() {
    parsePaths(project);
    var src = $('#paths').val();
    if (src === origPaths) {
      setQuery({paths: undefined}, true);
      return;
    }
    src = src.trim().replace(/ [ ]*\n/g, '\n');
    let comp = pako.deflate(src, {to: 'string', level: 9, raw: true});
    comp = btoa(String.fromCharCode.apply(null, comp));
    /* instead of using regular base64, convert /, +, and = to ., -, and _
     * so that they don't need to be escaped on the url.  This reduces the
     * average length of the url by 6 percent. */
    comp = comp.replace(/\//g, '.').replace(/\+/g, '-').replace(/=/g, '_');
    setQuery({paths: comp}, true);
  }


  document.getElementById('tracks').addEventListener('input', (event) => {
    updateSelectedTracks(project);
  });

  document.getElementById('paths').addEventListener('input', (event) => {
    updatePaths();
  });

  document.getElementById('play-anim').addEventListener('click', function() {
    project.animate = true;
    project.animate_start = Date.now() - parseFloat($('#end').val()) * 1000;
    animate(project);
  });

  document.getElementById('pause-anim').addEventListener('click', function() {
    project.animate = false;
  });

  document.getElementById('play-all-anim').addEventListener('click', function() {
    project.animate = 'all';
    project.animate_start = Date.now() + project.settings.playInitialPause * 1000;
    $('#end').val(0);
    $('#end-value').val(0);
    animate(project);
  });

  document.getElementById('reset').addEventListener('click', function() {
    $('#paths').val(origPaths);
    updatePaths();
  });

  document.getElementById('jump').addEventListener('click', function() {
    if (!$('#tracks option:selected').length) {
      return;
    }
    let selected = $('#tracks').val()[0];
    const pattern = new RegExp(`^\\s*Path\\s*,\\s*${selected}\\s*$`, 'm');
    const match = $('#paths').val().match(pattern);
    if (match) {
      const position = match.index;
      const textarea = $('#paths')[0];
      textarea.focus();
      textarea.setSelectionRange(position, position);
      // scroll
      textarea.blur();
      textarea.focus();
      console.log(position, match[0].length);
      textarea.setSelectionRange(position, position + match[0].length);
    }
  });

  document.getElementById('expand-docs').addEventListener('click', () => {
    $('#docs-instructions').toggleClass('show');
  });
}

main();

// TODO:
//  improve background image (use stl?)
//  play current, play all, stop
