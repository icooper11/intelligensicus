# Build dependency security

The packaged desktop application does not ship `node_modules`; its runtime uses Node.js built-ins and bundled browser assets. The app manifest has no production npm dependencies.

The standalone npm lockfile currently reports six moderate advisories in `minimatch`, reached through Electron Builder's packaging dependency chain. `npm audit fix` does not resolve them without `--force`; npm proposes downgrading Electron Builder from 26.18.0 to 24.13.3, so that breaking downgrade was not applied. This is a build-tool dependency finding, not a vulnerability in an app runtime dependency. Recheck the lockfile and audit when Electron Builder publishes a compatible fix.

Do not treat this note as proof that the installer is signed or that all future dependency graphs are vulnerability-free. Verify the current lockfile using `npm audit` before each release.
