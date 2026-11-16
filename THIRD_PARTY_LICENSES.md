# Third-Party Licenses and Attributions

This ledger covers third-party code, assets, model weights, datasets, and other externally authored materials actually incorporated into Intelligensicus. The user has confirmed that the first-party projects in `packages/` (including VQ, Amanuensis, Syllogistic, Climate, and Intelligensicus) are theirs; code copied from those projects is not entered here merely because a package has a proprietary/confidential notice.

Add an entry when third-party material is selected for inclusion. Verify the source and terms rather than relying only on a package's description or a model filename. Preserve required license texts and notices in the release as applicable.

| Item and version | Material used | Upstream source | License / terms verified | Required notices or attribution | Intelligensicus destination | Verification date |
| --- | --- | --- | --- | --- | --- | --- |
| MapLibre GL JS 5.6.2 | Self-hosted JavaScript and CSS browser map renderer; loaded by `index.html` | https://github.com/maplibre/maplibre-gl-js | 3-Clause BSD; verified from the bundled JavaScript license marker and upstream v5.6.2 `LICENSE.txt` | Preserve all included upstream and component license texts and notices in distributed copies | `intelligensicus-library/assets/maplibre-gl.v5.6.2.js` and `.css`; full license at `LICENSES/MAPLIBRE_GL_JS_LICENSE.txt` | 2026-11-16 |
| fflate 0.8.2 | Browser ESM ZIP encoder used to package a project manifest and original local evidence blobs | https://github.com/101arrowz/fflate | MIT; verified from the existing workspace-resolved package metadata and copied upstream `LICENSE` | Preserve MIT copyright and permission notice in distributions | `vendor/fflate/fflate.browser.js` and `vendor/fflate/LICENSE` | 2026-11-13 |
| WildlifeTools (WildlifeDatasets), commit `31d6016fe197c6a3092ca7179dfed102bb526815` | Upstream `wildlife_tools/` Python package copied for evaluation; `data/dataset.py` hardened to use `ast.literal_eval` for segmentation metadata; no models, data, or dependencies included | https://github.com/WildlifeDatasets/wildlife-tools | MIT; verified from upstream `LICENSE` and `pyproject.toml` | Retain copyright/license; cite the WACV 2024 WildlifeDatasets paper when using the toolkit; separately verify any model-weight and dataset terms | `vendor/wildlife-tools/wildlife_tools/` and `vendor/wildlife-tools/LICENSE` | 2026-11-13 |
| Electron 45.3.2 | Desktop Chromium/Node runtime used by the Windows application wrapper; not used by the web deployment | https://github.com/electron/electron | MIT; package declares MIT and the installer includes Electron/Chromium license notices | Preserve upstream license and bundled Chromium notices with the installer | Build dependency; packaged in `Intelligensicus-Setup-0.1.0-win-x64.exe` | 2026-11-16 |
| electron-builder 26.18.0 | Windows NSIS installer generation tool; build-time only | https://github.com/electron-userland/electron-builder | MIT; package declares MIT | Preserve upstream license notices in the source/build dependency inventory | Build dependency only; not included as app runtime code | 2026-11-16 |

## Review checklist

- Record the exact upstream project/version, commit or release, and the specific code/assets/data/model weights used.
- Verify source-code license separately from model-weight, dataset, API, and media terms.
- Note attribution, notice-preservation, source-disclosure, network-use, and redistribution obligations that apply.
- Include required license texts/notices with the shipped application and show applicable attribution in the app-wide powered-by area.
- Recheck this ledger whenever dependencies, assets, model weights, datasets, or copied upstream code change.
