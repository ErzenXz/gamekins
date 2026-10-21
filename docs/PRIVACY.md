# Gamekins data handling

Last reviewed: 2026-10-21. This describes the desktop application's current implementation. Review and publish a stable public policy URL before Microsoft Store submission.

Gamekins connects directly to Epic Games, Steam and GOG when you use their sign-in, library, store and social features. Those services receive requests from your device and process information under their own policies. Sign-in takes place on the service's own page. Gamekins receives session tokens and account information needed for the features you choose.

The app keeps settings, cached game metadata, installed-game paths, play time, collections, custom artwork, download progress and diagnostic logs on your device. Account tokens are saved only when OS credential encryption is available. On Linux the `basic_text` backend is not accepted; without a supported keyring, the session remains in memory and you may need to sign in again after restarting. Embedded store cookies and site storage are managed separately by Chromium/Electron in each provider's partition.

Gamekins can request game metadata, artwork and public reviews from Steam and game completion estimates from HowLongToBeat. Those services receive the corresponding game-title queries and ordinary connection information. Steam and GOG clients handle their own supported game installation and launch handoffs. Epic game files are downloaded directly from the provider's content servers.

The current application includes no Gamekins-operated analytics or advertising SDK, telemetry collector, or automatic log uploader. A third-party store page displayed inside the app can use its own analytics and cookies. Signing in is optional for local games; owned online libraries and social features require the corresponding provider account.

Signing out removes Gamekins's saved provider session and clears that provider's embedded store storage. Locally cached library and game-management records can remain. Uninstalling the launcher may leave user data on disk and does not delete your games. You can remove remaining app data through your operating system after quitting Gamekins, preserving any records you want to keep. The normal data locations are Electron's user-data directories: `%APPDATA%/Gamekins`, `~/Library/Application Support/Gamekins`, and `$XDG_CONFIG_HOME/Gamekins` (usually `~/.config/Gamekins`).

For project questions use the [Gamekins issue tracker](https://github.com/ErzenXz/gamekins/issues). Public issues are visible to others: redact account tokens and personal paths before sharing diagnostic logs. Do not publish private keys or sign-in credentials.

Gamekins is independent of Epic Games, Valve and GOG. Their trademarks and services remain theirs. This document does not describe those providers' own data handling.
