# Homebridge Aiper Surfer S2

[![Build & Test](https://github.com/NightPants/Homebridge-Aiper-Surfer2/actions/workflows/build.yml/badge.svg)](https://github.com/NightPants/Homebridge-Aiper-Surfer2/actions/workflows/build.yml)
[![Homebridge v1.8 / v2.0](https://img.shields.io/badge/homebridge-1.8%20%7C%202.0-purple?logo=homebridge)](https://homebridge.io)
[![Node.js](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-339933?logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A full-featured [Homebridge](https://homebridge.io) platform plugin that integrates and controls the **Aiper Surfer S2 Solar Pool Skimmer** (and compatible Aiper Surfer series skimmers) in **Apple HomeKit**.

Communicates directly with the official Aiper Cloud REST API and **AWS IoT real-time MQTT** device shadow & command channels — giving you instant HomeKit status updates, Siri voice control, solar-charging battery telemetry, navigation path switching, debris-basket full alerts, and HomeKit automation triggers.

---

## Features

- **Start & Stop Skimming from Apple Home or Siri**: Start manual skimming (`AT+MODE=1`) or stop/park (`AT+MODE=0`) directly from the Home app, Control Center, Apple Watch, or Siri.
- **Choice of Primary HomeKit Tile (`Switch` or `Fanv2`)**:
  - **Switch Mode (Default)**: Clean one-tap tile optimized for Siri commands (*"Hey Siri, turn on Pool Skimmer"*).
  - **Fan / Impeller Mode**: Animated spinning propeller icon in Apple Home while skimming, plus a built-in **Manual / Auto** segmented control mapped directly to **S-Shaped** vs. **Adaptive** navigation.
- **Solar-Aware Battery Service**:
  - Live **Battery Percentage** (`0–100%`) and configurable **Low Battery** threshold.
  - Reports **Charging** accurately for both **DC adapter charging** and **on-pool Solar Charging** (`solar_status = 1` while floating in water).
- **Clean Path Navigation Control (`S-Shaped` vs. `Adaptive`)**:
  - Toggle between **S-Shaped** (`0`) and **Adaptive** (`1`) skimming paths using the companion **Adaptive Path** switch (or Fan `Auto`/`Manual` mode), backed by both `/equipmentCleanPathSetting` REST persistence and immediate `AT+AUTO=0|1` MQTT updates.
- **MicroMesh Filter & Propeller Maintenance (`FilterMaintenance`)**:
  - Tracks remaining life percentage for the Surfer S2 **MicroMesh Filter** and **Propeller** consumables.
  - Automatically triggers HomeKit's **Change / Clean Filter** indicator when consumable life drops to `<= 10%` or when the skimmer reports **`E3` (Debris Basket / Filter Full)**.
- **Problem & Debris Basket Alert Sensor (`ContactSensor`)**:
  - Opens (`Contact Not Detected`) when the Surfer S2 reports hardware warnings (`E1` Stuck, `E2` Lifted, `E3` Debris Basket / Filter Full, `E4` Low Battery, `E5` Out of Water), unlocking native **iOS / macOS Apple Home push notifications**.
- **Optional Solar Charging Sensor (`OccupancySensor`)**:
  - Triggers HomeKit automations based on active solar charging on the water.
- **Dynamic Water Temperature Sensor (`TemperatureSensor`)**:
  - Automatically registers a HomeKit Pool Water Temperature sensor when your firmware reports `Machine.temp` (or force-enable/disable in settings).
- **Optional HomePod Doorbell Chimes (`Doorbell`)**:
  - Whole-home audio chime announcements on HomePods / Apple TV when a skimming cycle finishes or when the skimmer gets stuck / needs its basket emptied.
- **Multi-Region Cloud Auto-Discovery**:
  - Automatically detects and connects to **Americas** (`apiamerica.aiper.com`), **Europe / UK / MEA** (`apieurope.aiper.com`), or **Asia-Pacific / Australia** (`apiasia.aiper.com`) accounts.
- **Zero External Crypto Dependencies**:
  - Implements Aiper's RSA-PKCS1v15 + AES-128-CBC zero-padded REST envelope, CRC16 (`0x9966` / `0xA001`) `downChan` checksums, and XOR+Base64 MQTT decoding natively with Node's built-in `node:crypto`.

---

## HomeKit Accessories & Services Overview

Assuming your skimmer is named **`Pool Skimmer`** in the Aiper app:

| Accessory | HomeKit Service | Default | Behavior |
| :--- | :--- | :---: | :--- |
| **Pool Skimmer** | `Switch` *(or `Fanv2`)* + `Battery` + `FilterMaintenance` | Enabled | **On / Active** = Skimming, **Off / Inactive** = Idle/Stopped. Includes live battery %, solar/DC charging indicator, and MicroMesh Filter / Propeller life. |
| **Pool Skimmer Adaptive Path** | `Switch` | Enabled | **Off** = S-Shaped path (`0`), **On** = Adaptive path (`1`). |
| **Pool Skimmer Alert** | `ContactSensor` | Enabled | **Closed** = Normal, **Open** = Warning active (`Stuck`, `Lifted`, `Debris Basket Full`, `Low Battery`, `Out of Water`). |
| **Pool Skimmer Solar Charging** | `OccupancySensor` | Optional | **Detected** = Actively solar-charging on the pool. |
| **Pool Skimmer Water Temperature** | `TemperatureSensor` | Auto | Reports pool water temperature in °C/°F when present in device telemetry. |
| **Pool Skimmer Finished Skimming** | `Doorbell` | Optional | Rings HomePod chime when an automatic skimming cycle completes (>= 5 min run, not manually stopped). |
| **Pool Skimmer Needs Attention** | `Doorbell` | Optional | Rings HomePod chime when a warning (`Stuck`, `Basket Full`, etc.) occurs. |

---

## Requirements

- **Node.js**: `v20.18+`, `v22.10+`, or `v24.0+`
- **Homebridge**: `v1.8.0+` or `v2.0.0+`
- An **Aiper** account with an **Aiper Surfer S2** (or Surfer series) pool skimmer paired to Wi-Fi in the official Aiper mobile app.

> **Tip — Dedicated Shared Account (Optional)**: Like all Aiper cloud integrations, Aiper's backend allows **one active login session per account** at a time. Opening the official Aiper app on your phone invalidates the previous token; this plugin detects session-conflict code `402` and automatically pauses cloud REST calls for **3 minutes** so it never logs you out while you use the mobile app (while existing MQTT telemetry continues). If you open the Aiper app frequently, you can create a second Aiper account and **Share** your Surfer S2 to it for uninterrupted dual access.

---

## Installation

### Option 1: Homebridge UI (Recommended)

1. Open **Homebridge Config UI X** in your browser.
2. Navigate to the **Plugins** tab.
3. Search for **`homebridge-aiper-surfer2`** (or install from GitHub URL `https://github.com/NightPants/Homebridge-Aiper-Surfer2`).
4. Click **Install**, enter your **Aiper Email** and **Password** in the settings modal, click **Save**, and restart Homebridge.

### Option 2: Command Line (npm / GitHub)

```bash
# Install directly from GitHub
sudo npm install -g github:NightPants/Homebridge-Aiper-Surfer2

# Or once published to npm
sudo npm install -g homebridge-aiper-surfer2
```

### Option 3: Local Clone & Link (Development)

```bash
git clone https://github.com/NightPants/Homebridge-Aiper-Surfer2.git
cd Homebridge-Aiper-Surfer2
npm install
npm run build
npm link
```

---

## Configuration

### Configuring via Homebridge UI

Open **Plugins -> Aiper Surfer S2 -> Settings** in Homebridge Config UI X. Every option is documented in a visual form with sensible defaults — only **Email** and **Password** are required.

### Manual `config.json` Example

Add the platform block to the `"platforms"` array of your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AiperSurfer2",
      "name": "Aiper Surfer S2",
      "email": "you@example.com",
      "password": "your-aiper-password",
      "region": "auto",
      "accessoryType": "switch",
      "exposeCleanPathSwitch": true,
      "exposeWarningSensor": true,
      "exposeSolarSensor": false,
      "exposeWaterTemperature": "auto",
      "enableDoorbellAlerts": false,
      "lowBatteryThreshold": 20,
      "pollIntervalSeconds": 300,
      "debugMqtt": false
    }
  ]
}
```

### Configuration Reference

| Property | Type | Required | Default | Description |
| :--- | :---: | :---: | :---: | :--- |
| `platform` | `string` | **Yes** | `"AiperSurfer2"` | Must always be `"AiperSurfer2"`. |
| `name` | `string` | **Yes** | `"Aiper Surfer S2"` | Display name shown in Homebridge logs. |
| `email` | `string` | **Yes** | — | Email address for your Aiper mobile app account. |
| `password` | `string` | **Yes** | — | Password for your Aiper mobile app account. |
| `region` | `string` | No | `"auto"` | Cloud server region: `"auto"`, `"us"` (`apiamerica.aiper.com`), `"eu"` (`apieurope.aiper.com`), or `"asia"` (`apiasia.aiper.com`). |
| `deviceId` | `string` | No | `""` | Optional serial number (`sn`) or device name to target a single skimmer. Leave blank to auto-discover all Surfer devices on the account. |
| `accessoryType` | `string` | No | `"switch"` | Primary HomeKit tile style: `"switch"` (recommended for Siri) or `"fan"` (animated spinning propeller icon + Manual/Auto Clean Path toggle). |
| `exposeCleanPathSwitch` | `boolean` | No | `true` | Expose a dedicated `<Name> Adaptive Path` switch (`Off` = S-Shaped, `On` = Adaptive). |
| `exposeWarningSensor` | `boolean` | No | `true` | Expose a `<Name> Alert` Contact Sensor for native Apple Home push notifications when stuck or when the debris basket is full. |
| `exposeSolarSensor` | `boolean` | No | `false` | Expose a `<Name> Solar Charging` Occupancy Sensor that turns active while solar-charging. |
| `exposeWaterTemperature` | `string` | No | `"auto"` | Water temperature sensor exposure: `"auto"` (registers automatically if `temp` is reported), `"always"`, or `"never"`. |
| `enableDoorbellAlerts` | `boolean` | No | `false` | Expose HomeKit Doorbell accessories so HomePods chime on cycle completion or warning states. |
| `lowBatteryThreshold` | `integer` | No | `20` | Battery percentage (`5–50`) at or below which HomeKit sets `StatusLowBattery`. |
| `pollIntervalSeconds` | `integer` | No | `300` | Background cloud sync & AWS credential health-check interval (`60–3600` seconds). Real-time updates arrive instantly over MQTT. |
| `debugMqtt` | `boolean` | No | `false` | Log redacted MQTT shadow/`upChan` payloads and command envelopes for diagnostics. |

---

## Siri Commands & Apple Home Tips

### Siri Examples
- *"Hey Siri, turn on Pool Skimmer."* — Starts manual skimming (`AT+MODE=1`).
- *"Hey Siri, turn off Pool Skimmer."* — Stops skimming (`AT+MODE=0`).
- *"Hey Siri, what's the Pool Skimmer battery level?"* — Reads live battery percentage.
- *"Hey Siri, turn on Pool Skimmer Adaptive Path."* — Switches navigation from S-Shaped to Adaptive.
- *"Hey Siri, what's the Pool Skimmer Water Temperature?"* — Reads pool temperature (when supported by firmware).

### Enabling Push Notifications for Basket Full / Stuck Alerts
1. Open the **Apple Home** app on iPhone/iPad.
2. Long-press **Pool Skimmer Alert** -> **Accessory Settings** -> **Status and Notifications**.
3. Turn on **Activity Notifications**. You will receive an instant iOS banner whenever the Surfer S2 gets stuck or its debris basket fills up.

### Helpful HomeKit Automations
- **Pause Skimmer When Pool Cover Closes / Pump High-Speed Runs**: Trigger *Pool Skimmer -> Off* whenever your pool cover or high-suction cleaner turns on.
- **Morning Solar Skim**: When **Pool Skimmer Solar Charging** becomes *Detected* and battery is above 50%, turn on **Pool Skimmer** and **Pool Skimmer Adaptive Path**.

---

## Surfer S2 Protocol & Architecture Notes

The **Aiper Surfer S2** (`Surfer_S2`) differs in several important ways from floor/wall pool robots (such as the Scuba S1 / N1 series). This plugin implements the hardware-verified Surfer S2 protocol contract:

1. **High-Bit Status Mask (`0x80` / `0x7F`)**:
   - Surfer S2 sets bit 7 (`0x80 = 128`) on `Machine.status` while encoding operational state in the lower 7 bits (`rawStatus & 0x7F`):
     - `128` (`0x80 | 0`) -> **Idle / Stopped**
     - `129` (`0x80 | 1`) -> **Skimming / Cleaning**
     - `130` (`0x80 | 2`) -> **Returning**
     - `131` (`0x80 | 3`) -> **DC Charging**
     - `132` (`0x80 | 4`) -> **Charged**
     - `133` (`0x80 | 5`) -> **Error**
2. **Read-Only Mode Context (`Machine.mode`)**:
   - Unlike Scuba cleaners (`1=Smart, 2=Floor, 3=Wall, 4=Waterline`), sending `AT+MODE=2/3/4/5` to a Surfer S2 returns `+ERROR`.
   - On Surfer S2, `Machine.mode` is read-only operational context (`1` = Manual skimming, `5` = Scheduled skimming). When stopped (`status = 128`), the firmware retains `mode = 5` (`+INFO:128,5,...`); this plugin normalizes effective mode to **`Off` (`0`)** whenever the lower 7-bit status is not running.
3. **Verified MQTT Command Channel (`aiper/things/<sn>/downChan`)**:
   - **Start Skimming**: `AT+MODE=1`
   - **Stop Skimming**: `AT+MODE=0`
   - **Clean Path**: `AT+AUTO=0` (S-Shaped) / `AT+AUTO=1` (Adaptive) paired with `/equipmentCleanPathSetting/updateCleanPathSetting`
   - Commands include the compact JSON CRC16 checksum (`init = 0x9966`, `poly = 0xA001`) and correlate `+OK` / `+ERROR` replies on `aiper/things/<sn>/upChan`.
4. **Immediate Shadow Hydration + Proactive Cognito Renewal**:
   - Publishes to `$aws/things/<sn>/shadow/get` immediately after subscribing so HomeKit receives live state on startup without waiting for a state transition, and proactively refreshes temporary AWS Cognito credentials (~50-minute rotation) before WebSocket expiration.
5. **Floating Solar Charging**:
   - Preserves `ChargingState.CHARGING` whenever `Machine.solar_status === 1`, even while `in_water === 1`.

---

## Troubleshooting

| Symptom | Resolution |
| :--- | :--- |
| **`Aiper login rejected`** | Double-check your email and password in the official Aiper app. Leave `region` set to `"auto"` so the plugin probes US, EU, and Asia endpoints automatically. |
| **`Aiper account is active in another session`** | Expected when you open the Aiper mobile app on the same account. The plugin cools down REST requests for 3 minutes so your phone app stays logged in, then resumes automatically. |
| **No devices auto-detected** | Check Homebridge startup logs for `Aiper account device: name="..." model="..." sn=...` and paste your skimmer's name or serial number into `deviceId`. |
| **Skimmer ignores Start command** | Ensure the Surfer S2 is powered on, floating in water (`Out of Water` blocks motor start), and connected to 2.4 GHz Wi-Fi (not Bluetooth-only). Enable `debugMqtt: true` to inspect `+OK` / `+ERROR` responses. |
| **Cloud outage during Homebridge reboot** | Cached HomeKit accessories are restored immediately so your Apple Home room assignments and automations remain intact, and the plugin retries Aiper Cloud connection every 60 seconds. |

---

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript -> dist/
npm run build

# Run ESLint (zero warnings allowed)
npm run lint

# Run unit tests (crypto, Surfer S2 telemetry normalization, HomeKit HAP services)
npm test

# Watch mode with local Homebridge link
npm run watch
```

### Project Structure

```text
Homebridge-Aiper-Surfer2/
├── src/
│   ├── index.ts              # Homebridge platform entry point
│   ├── settings.ts           # Platform/plugin identifiers & regional cloud URLs
│   ├── types.ts              # Config, telemetry, consumable, and accessory types
│   ├── aiperCrypto.ts        # Native RSA + AES-128-CBC envelope, CRC16, XOR MQTT codec
│   ├── surferState.ts        # Surfer S2 0x7F bitmask, solar, +INFO/+WARN, & consumables parser
│   ├── aiperClient.ts        # Multi-region REST + AWS Cognito + AWS IoT MQTT client
│   ├── platform.ts           # Dynamic Homebridge platform & accessory lifecycle manager
│   └── platformAccessory.ts  # HomeKit Switch/Fanv2, Battery, Filter, & Sensor handlers
├── test/
│   ├── aiperCrypto.test.ts
│   ├── surferState.test.ts
│   └── platformAccessory.test.ts
├── config.schema.json        # Homebridge Config UI X schema
└── package.json
```

---

## Credits & Acknowledgments

- Inspired by [richierockskool/homebridge-aiper](https://github.com/richierockskool/homebridge-aiper) for Homebridge platform structure and HomeKit accessory patterns.
- Protocol details, `0x80` high-bit status masking, clean-path endpoints, and live hardware telemetry contracts informed by [kmich/ha-aiper](https://github.com/kmich/ha-aiper) (Home Assistant Aiper integration with verified Surfer S2 hardware profiles).

---

## Disclaimer

This project is an independent community plugin and is **not** affiliated with, endorsed by, or supported by Aiper Intelligent LLC or Apple Inc. All product and company names are trademarks of their respective holders.

## License

Licensed under the [Apache License 2.0](LICENSE).
