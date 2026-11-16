# Intelligensicus

Species-agnostic animal research and record software for connecting media, observations, and sessions to individual-animal histories and project timelines. It supports wildlife research and can also suit trainers and breeders who need longitudinal animal records.

This public repository is the source for the downloadable Electron desktop app. The hosted web product, download page, and company/product pages are maintained separately by the project owner and are not part of this repository.

## Windows desktop app

Download the per-user Windows x64 installer from [GitHub Releases](https://github.com/icooper11/intelligensicus/releases). Install to a selected folder and launch from the Start Menu or desktop shortcut. The installer is currently unsigned, so Windows may show a SmartScreen warning. Verify its SHA-256 against the release notes before running it.

See [DESKTOP_INSTALL.md](DESKTOP_INSTALL.md) for installation, data storage, permission, and uninstall details.

## What it does

- Organizes projects, photo/video/audio/document/text evidence, and dated field observations.
- Connects evidence to project timelines and confirmed individual-animal histories.
- Supports researcher-controlled identity, annotations, roles, and provenance-aware exports.
- Keeps original media in the local profile by default. Sharing project records does not automatically transfer source media.

Automated species/individual identification, pose, and persistent visual re-identification are not implemented in this release. WildlifeTools is evaluation-only and is not included in the running inference path. No wildlife model weights or datasets are bundled.

No AI or LLM is required for core research workflows. A planned MCP server will expose authorized app capabilities to your own AI agent, whether it runs locally in an editor such as VS Code or is hosted elsewhere. Intelligensicus will not manage that agent's model/runtime. This is separate from any future AI inference provided inside Intelligensicus, which would be managed through Spartan. MCP and app-provided AI are not available in release 0.1.0.

## Development

Requirements: Node.js 22.13 or later and npm.

```powershell
npm install
npm test
npm start
```

The local web service binds to loopback. For desktop development, install dependencies and run:

```powershell
npm run desktop
```

To build the Windows installer on a Windows machine with Electron's build prerequisites installed:

```powershell
npm run dist:win
```

The packaging script redirects Electron Builder caches and output to a drive with sufficient free space when possible. The Electron desktop profile is isolated under Electron's per-user application data folder.

See [BUILD_SECURITY.md](BUILD_SECURITY.md) for the current audit status of build-only dependencies.

## Open-source components

See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for component and notice details. First-party source is licensed under AGPL-3.0-only; see [LICENSE](LICENSE). Third-party licenses remain applicable to their respective components.
