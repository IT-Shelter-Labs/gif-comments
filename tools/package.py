"""Create browser-specific packages from readable extension source."""
from pathlib import Path
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'extension'
DIST = ROOT / 'dist'
version = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))['version']
for browser in ('firefox', 'chromium'):
    target = DIST / browser
    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(SOURCE, target, dirs_exist_ok=True)
    manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
    if browser == 'chromium':
        manifest.pop('browser_specific_settings', None)
        manifest['background'] = {'service_worker': 'src/sw.js'}
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    archive = DIST / f'gif-comments-{browser}-{version}.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
        for file in sorted(target.rglob('*')):
            if file.is_file():
                output.write(file, file.relative_to(target).as_posix())
    print(archive.relative_to(ROOT))
