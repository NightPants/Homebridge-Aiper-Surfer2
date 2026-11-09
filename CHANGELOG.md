# Changelog

All notable changes to the **Homebridge Aiper Surfer S2** plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.2] - 2026-11-09

### Added
- **Verified by Homebridge** official badge added to README.
- Configured npm `funding` in `package.json` with PayPal donation link, enabling the native **❤️ Donate** button on the plugin tile in Homebridge UI.
- Added **Support & Donations** section to README.

### Changed
- **Account Lockout Protection**:
  - Automatically halts candidate region probing if Aiper returns a credential or password rejection.
  - Halts the periodic 60-second startup retry loop upon receiving an `AiperAuthenticationError` to avoid locking the user's Aiper mobile app account.
  - Preserves cached HomeKit accessories when startup authentication fails so HomeKit tiles remain stable while the user corrects credentials.

---

## [1.0.1] - 2026-11-01

### Added
- Added `supports-hap` keyword in `package.json` to meet official Homebridge transport declaration requirements.
- High-resolution Apple-style plugin icons (`branding/icon.png`, `branding/icon-100x100.png`, `branding/icon-cyan.png`, `branding/icon-light.png`).
- Branded header banner and icon integration in `config.schema.json`.

### Fixed
- Fixed JSON Schema validation in `config.schema.json` by removing field-level `"required": true` booleans in favor of the root object-level `required: ["name", "email", "password"]` array.
- Excluded extraneous local CLI and development artifacts from npm packaging.
- Updated automated GitHub Actions publish workflow for seamless npm releases.

---

## [1.0.0] - 2026-10-31

### Added
- **Initial Release** of the Homebridge dynamic platform plugin for the **Aiper Surfer S2 Solar Pool Skimmer**.
- **Primary HomeKit Tile**: Choice of one-tap `Switch` (optimized for Siri) or animated `Fanv2` (spinning impeller tile with segmented clean-path control).
- **Solar-Aware Battery Telemetry**: Reports battery level (`0–100%`), low battery status, and charging state for both DC wall charging and on-pool solar charging (`solar_status = 1`).
- **Clean Path Navigation**: Toggle between S-Shaped (`0`) and Adaptive (`1`) skimming paths via companion switch or Fan Auto/Manual mode.
- **Filter & Propeller Consumables**: Exposes `FilterMaintenance` service tracking MicroMesh Filter and Propeller life percentage, automatically alerting when life drops `<= 10%` or debris basket is full (`E3`).
- **Problem & Basket Alerts**: Exposes a HomeKit `ContactSensor` that opens on error codes (`E1` Stuck, `E2` Lifted, `E3` Basket Full, `E4` Low Battery, `E5` Out of Water) for iOS push notifications.
- **Optional Companion Sensors**: Water temperature sensor (`TemperatureSensor`), on-pool solar charging sensor (`OccupancySensor`), and HomePod chime alerts (`Doorbell`).
- **Multi-Region Auto-Discovery**: Automatically discovers and routes between Americas (`apiamerica.aiper.com`), Europe (`apieurope.aiper.com`), and Asia-Pacific (`apiasia.aiper.com`).
- **Zero External Crypto Dependencies**: Built directly on `node:crypto` with RSA-PKCS1v15 + AES-128-CBC zero-padded REST encryption, CRC16 checksums, and XOR+Base64 MQTT decoding.
