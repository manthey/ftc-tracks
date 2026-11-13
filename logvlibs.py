# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""getlibs.py - download the JavaScript/CSS libraries that logviewer.html
normally loads from jsdelivr, placing them next to logviewer.html so the
viewer works with no internet access (e.g. served by the robot's log web
server on port 6955). The viewer tries the local copy of each library first
and falls back to jsdelivr when the local file is missing, so running this
script is optional. Deploy the downloaded files together with
logviewer.html, logviewer.js, logviewer.css and the field/robot pngs.

Run with no internet-restricted steps via `uv run getlibs.py` or, after
`pip install requests`, plain `python getlibs.py`.
"""

import sys
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = 'https://cdn.jsdelivr.net/npm'
# (url path under BASE, destination filename)
FILES = [
    ('gridstack@12.4.2/dist/gridstack.min.css', 'gridstack.min.css'),
    ('geojs@1.20.0/geo.min.js', 'geo.min.js'),
    ('gridstack@12.4.2/dist/gridstack-all.js', 'gridstack-all.js'),
    ('papaparse@5.5.3/papaparse.min.js', 'papaparse.min.js'),
    ('plotly.js@3.3.1/dist/plotly.min.js', 'plotly.min.js'),
]
# a CDN failure page would be small and not JavaScript
MIN_SIZE = 1000


def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(['GET']),
    )
    session.mount('https://', HTTPAdapter(max_retries=retry))
    return session


def fetch(session: requests.Session, url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f'already have {dest.name} ({dest.stat().st_size} bytes)')
        return
    print(f'fetching {dest.name}')
    part = dest.with_suffix(dest.suffix + '.part')
    response = session.get(url, stream=True, timeout=60)
    response.raise_for_status()
    size = 0
    with part.open('wb') as f:
        for chunk in response.iter_content(chunk_size=64 * 1024):
            f.write(chunk)
            size += len(chunk)
    if size < MIN_SIZE:
        print(f'error: {dest.name} is suspiciously small ({size} bytes)', file=sys.stderr)
        part.unlink(missing_ok=True)
        sys.exit(1)
    part.replace(dest)
    print(f'  {size} bytes')


def main() -> None:
    dest_dir = Path(__file__).resolve().parent
    session = make_session()
    for path, name in FILES:
        fetch(session, f'{BASE}/{path}', dest_dir / name)
    print('done; deploy these together with logviewer.html/js/css and the pngs')


if __name__ == '__main__':
    main()
