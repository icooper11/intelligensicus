# Intelligensicus for Windows

Intelligensicus is species-agnostic wildlife research software for recording field media and observations in project timelines centered on confirmed individual animals.

## Install

1. Download `Intelligensicus-Setup-0.1.0-win-x64.exe` from the GitHub Releases page.
2. Run the installer. Choose the install folder or accept the suggested per-user location.
3. Launch Intelligensicus from the desktop or Start Menu shortcut.
4. Create or sign in to a researcher account.

Windows may display a SmartScreen warning because this release is not code-signed. Confirm the publisher/download source and the release SHA-256 shown on the GitHub release page before running it.

## Data location

The desktop app has its own Electron profile under the current Windows user's application data. The account database, browser workspace/media, and local logs are separate from the web app's browser profile and server database. Original media is not uploaded automatically. Export research packages regularly and store backups in a location you control.

## Permissions

Camera and microphone access is requested only when the researcher starts a recording. The app does not scan nearby networks or record in the background. Uploaded files are stored as source evidence; analysis and identity confirmation remain separate researcher-controlled steps.

Core research workflows do not require AI or an LLM. The planned MCP server will expose authorized app capabilities to your own AI agent, whether it runs locally in an editor such as VS Code or is hosted elsewhere. Intelligensicus will not manage that agent's model/runtime. This differs from any future AI inference provided inside Intelligensicus, which would be managed through Spartan. MCP and app-provided AI are not available in version 0.1.0.

## Uninstall

Use Windows Settings → Apps → Installed apps → Intelligensicus → Uninstall. Research data in the app-data directory is kept unless you explicitly remove that directory; export needed records and media before removing it.

## Release verification

- Version: 0.1.0
- Platform: Windows x64
- Installer: `Intelligensicus-Setup-0.1.0-win-x64.exe`
- Verify the installer size and SHA-256 against the GitHub Releases page before running it.
- Signature: unsigned; no code-signing certificate was configured for this release.

The desktop source is in the public `icooper11/intelligensicus` repository. The web product/download pages are maintained by the owner at `intelligensicus.theamanuensis.com` and are not part of this desktop distribution.
