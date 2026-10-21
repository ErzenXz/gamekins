# Gamekins Privacy Policy

Effective date: 2026-10-21.

Gamekins is published by Quad Labs Technologies LLC. This policy explains how the Gamekins desktop application handles information when you use it.

Gamekins connects directly to Epic Games, Steam and GOG when you use their sign-in, library, store and social features. Those services receive requests from your device and process information under their own policies. Sign-in takes place on the service's own page. Gamekins receives session tokens and account information needed for the features you choose.

The app keeps settings, cached game metadata, installed-game paths, play time, collections, custom artwork, download progress, local friend restrictions, and diagnostic logs on your device. Account tokens are saved only when OS credential encryption is available. On Linux the `basic_text` backend is not accepted; without a supported keyring, the session remains in memory and you may need to sign in again after restarting. Embedded store cookies and site storage are managed separately by Chromium/Electron in each provider's partition.

Gamekins can request game metadata, artwork and public reviews from Steam and game completion estimates from HowLongToBeat. Those services receive the corresponding game-title queries and ordinary connection information. Steam and GOG clients handle their own supported game installation and launch handoffs. Epic game files are downloaded directly from the provider's content servers.

In the Microsoft Store edition, unrestricted store catalogs open in your default browser, remote catalog artwork and rich descriptions are withheld, and native chat is disabled. Provider sign-in windows are used only for authentication. Friend restrictions apply locally to this Gamekins profile; they do not block a person on the provider’s service. Safety reports open a pre-addressed message in your email application. You choose the details and send the message; Gamekins does not automatically send a report or attach logs. Reports you send to Quad Labs are received by email and used to investigate and respond to your concern.

The current application includes no Gamekins-operated analytics or advertising SDK, telemetry collector, or automatic log uploader. A third-party store page displayed inside the app can use its own analytics and cookies. Signing in is optional for local games; owned online libraries and social features require the corresponding provider account.

Signing out removes Gamekins's saved provider session and clears that provider's embedded store storage. Locally cached library and game-management records can remain. Uninstalling the launcher may leave user data on disk and does not delete your games. You can remove remaining app data through your operating system after quitting Gamekins, preserving any records you want to keep. The normal data locations are Electron's user-data directories: `%APPDATA%/Gamekins`, `~/Library/Application Support/Gamekins`, and `$XDG_CONFIG_HOME/Gamekins` (usually `~/.config/Gamekins`).

For privacy questions or requests, contact [erzen@quad-labs.com](mailto:erzen@quad-labs.com). For project support use the [Gamekins issue tracker](https://github.com/ErzenXz/gamekins/issues). Public issues are visible to others: redact account tokens and personal paths before sharing diagnostic logs. Do not publish private keys or sign-in credentials.

Gamekins is independent of Epic Games, Valve and GOG. Their trademarks and services remain theirs. This document does not describe those providers' own data handling.
