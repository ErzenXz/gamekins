# Desktop releases

Gamekins 0.1.0 is an early release. Packaging support does not mean a Store submission has passed certification. Review the smoke checklist below before distribution.

## Supported channels

| Platform | Output | Release requirement |
| --- | --- | --- |
| macOS Intel + Apple Silicon | Universal DMG | Developer ID Application certificate and Apple notarization |
| Windows x64 | NSIS setup EXE | Authenticode certificate for direct distribution |
| Microsoft Store x64 | AppX | Reserved product and exact Partner Center identity; Microsoft signs the submitted package |
| Linux x64 (ARM64 optional) | AppImage and deb | Native Linux build and desktop testing |

macOS uses direct Developer ID distribution. The app installs and runs other programs, so this repository does not implement a sandboxed Mac App Store target. Linux supports Steam handoffs and local native executables; Epic installation/launch needs a compatibility runner that is not bundled. GOG on Linux supports browsing/account access and manual downloads; add a native executable as a local game. Steam's client handles native/Proton support. Linux startup is configured through the desktop environment. Flatpak Steam launch options are not supported by Gamekins.

## Reproducible dependencies

Use Node 24 and pnpm 12.14.0 (the latest verified on 2026-10-21). `packageManager` pins the exact version; update it deliberately when adopting a newer release. Do not create an npm/yarn lockfile.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
pnpm audit --audit-level high
```

`pnpm-workspace.yaml` enforces a strict one-day publication delay, trust downgrade checks, blocked exotic transitive sources, lockfile integrity and explicit build-script permissions. Electron and esbuild are the only allowed dependency install scripts. Old tooling published more than a year ago is exempt from provenance downgrade checks because many legacy packages predate provenance; package integrity remains locked. There is no blanket script approval or release-age bypass. The compatible http-cache-semantics override and Vite patch fix advisories in the original development toolchain. A moderate advisory remains in optional build-only `sprintf-js`, with no published fix at preparation time; no production dependency advisories were reported. Recheck before each release.

## Local packaging

Build on the target operating system. Before a large install or build, check `df -h /System/Volumes/Data` on macOS; stop for owner input below 20 GB free. Unsigned validation is explicit and labels installers `UNSIGNED`; never present these files as signed releases.

```sh
pnpm dist:mac --unsigned --arch=arm64 --dir # small local package smoke check
pnpm dist:mac                             # universal, signed and notarized
pnpm dist:win                            # signed x64 installer
pnpm dist:store                          # Store x64 submission package
pnpm dist:linux                          # x64 AppImage and deb
node scripts/release-checksums.cjs
```

For Windows validation use `pnpm dist:win --unsigned`; Linux can optionally select `--arch=arm64`. A Store package always requires real product identity, including during validation. `--check` checks settings without building; `--dir` produces an unpacked application for local testing. All packaging commands explicitly disable publishing. The scripts validate current signing results and block missing release credentials. Keep one verified release build; remove old disposable output and do not commit binaries.

### macOS signing and the “key thing”

The signing certificate proves the publisher's identity. Notarization separately sends the signed app to Apple for scanning. Both are required for the release path. The local Keychain already contained a valid Developer ID Application identity at preparation time; private keys are never exported by these scripts.

Choose one signing method:

- Existing Keychain identity: set `CSC_NAME` to the complete Developer ID Application name.
- CI/imported identity: set `CSC_LINK` to the certificate P12 path or base64 value and `CSC_KEY_PASSWORD` to its password.

Choose one notarization method:

- Existing credentials stored by `xcrun notarytool store-credentials`: `APPLE_KEYCHAIN_PROFILE`, with optional `APPLE_KEYCHAIN`.
- Apple account: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- App Store Connect API key: `APPLE_API_KEY` (path to the P8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Store secrets in Keychain or GitHub environment secrets. Never paste private keys into issues, logs or version control. Keep the P8 in its existing private location; the release script reads the path directly. `codesign`, Gatekeeper assessment and staple validation must pass. Verify both Intel and Apple Silicon hardware before calling the universal artifact tested.

### Windows and Partner Center

For direct NSIS signing set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` (or `CSC_LINK`/`CSC_KEY_PASSWORD`). Do not use Apple's certificate. Microsoft Store packaging uses three **non-secret** values copied exactly from Partner Center → product → Product identity:

```text
WINDOWS_STORE_IDENTITY_NAME
WINDOWS_STORE_PUBLISHER
WINDOWS_STORE_PUBLISHER_DISPLAY_NAME
```

Reserve Gamekins first if no product exists. Signing, a successful AppX build and Store certification are separate states. Submission packages are unsigned for Microsoft to sign; they are not sideload-ready packages. Test installation through Partner Center's test/distribution process and run the Windows App Certification Kit. Store sandbox/virtualization and elevation restrictions need testing with game installation and prerequisite flows. Do not claim Store approval before certification succeeds.

## GitHub Actions

`Desktop checks` runs `pnpm check` on macOS, Windows and Linux for pull requests and main, then builds unsigned Windows/macOS validation artifacts and Linux packages with three-day retention. `Prepare desktop release artifacts` is manually dispatched; it uploads build artifacts and checksums for review and does not create a GitHub Release or submit to stores. Workflows pin action revisions. Configure the `desktop-release` environment with review protection before enabling real releases.

GitHub environment secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, Apple account notarization secrets listed above, and `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`. Configure the three Store identity values as environment variables. The Linux deb maintainer currently uses the repository owner's GitHub noreply address; choose a real support contact before public distribution. Local Keychain profiles cannot be used on hosted runners; provision the corresponding CI credentials there. Store packaging is optional in the manual workflow.

## Native acceptance checklist

- Clean install, first launch, minimum window size, Library/Store/Downloads/Settings navigation, offline start, close/tray/reopen/quit, gamekins URL handoff, and uninstall of the launcher.
- Sign in/out with Epic, Steam and GOG; confirm owned library and friends. A locked/missing OS keyring keeps tokens in memory instead of writing plaintext; Linux `basic_text` is refused. Legacy plaintext sessions require sign-in again. Store webview cookies remain managed by Chromium; test with a real Linux keyring.
- Install a small owned Epic game on Windows/macOS; pause, quit, resume, repair, update, launch/stop and confirm tracking. Interrupt finalization and resume: pending commit journals must prevent launch/move/uninstall until recovery succeeds. Test disconnected drives and cross-volume moves.
- Test Steam handoff on each OS, Linux Proton/native games, GOG client handoff on Windows/macOS and Linux native local games. Game download bandwidth and disk capacity belong to the tester; no large games are downloaded automatically.
- On Windows test standard-user NSIS installation, Store package deployment and Windows App Certification Kit. On macOS verify signing/notarization and launch from the downloaded DMG on a clean machine. On Linux test AppImage/deb on supported desktops and tray behavior.
- Capture fresh release screenshots at the actual shipping version; existing screenshots and mock data are development references. Verify all store copy against implemented behavior.

## Official references

- [electron-builder 26 macOS options](https://www.electron.build/v26/docs/mac/)
- [Apple Developer ID](https://developer.apple.com/developer-id/)
- [Microsoft desktop distribution](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store)
- [Microsoft package requirements and Store signing](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/package-version-numbering)
- [pnpm supply-chain protections](https://pnpm.io/supply-chain-security)

## Built application smoke check

After packaging, `pnpm exec electron scripts/smoke.cjs dist/mac-arm64/Gamekins.app/Contents/Resources/app.asar` loads the packaged source in the same Electron version with isolated temporary app data, checks preload/IPC and sandbox settings, and confirms the library shell renders. It prevents protocol/autostart registration. This harness does not replace launching the signed application binary or testing real accounts. It prints the temporary directory to remove after exit.
