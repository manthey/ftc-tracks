#!/bin/bash
# getlibs.sh - download the JavaScript/CSS libraries that logviewer.html
# normally loads from jsdelivr, placing them next to logviewer.html so the
# viewer works with no internet access (e.g. served by the robot's log web
# server on port 6955). The viewer tries the local copy of each library first
# and falls back to jsdelivr when the local file is missing, so running this
# script is optional. Deploy the downloaded files together with
# logviewer.html, logviewer.js, logviewer.css and the field/robot pngs.
set -e
cd "$(dirname "$0")"

BASE=https://cdn.jsdelivr.net/npm

fetch() {
    local url="$1" dest="$2" size
    if [ -s "$dest" ]; then
        echo "already have $dest ($(wc -c < "$dest") bytes)"
        return
    fi
    echo "fetching $dest"
    curl -fSL --retry 3 -o "$dest.part" "$url"
    size=$(wc -c < "$dest.part")
    # a CDN failure page would be small and not JavaScript
    if [ "$size" -lt 1000 ]; then
        echo "error: $dest is suspiciously small ($size bytes)" >&2
        rm -f "$dest.part"
        exit 1
    fi
    mv "$dest.part" "$dest"
    echo "  $size bytes"
}

fetch "$BASE/gridstack@12.4.2/dist/gridstack.min.css" gridstack.min.css
fetch "$BASE/geojs@1.20.0/geo.min.js" geo.min.js
fetch "$BASE/gridstack@12.4.2/dist/gridstack-all.js" gridstack-all.js
fetch "$BASE/papaparse@5.5.3/papaparse.min.js" papaparse.min.js
fetch "$BASE/plotly.js@3.3.1/dist/plotly.min.js" plotly.min.js

echo "done; deploy these together with logviewer.html/js/css and the pngs"
