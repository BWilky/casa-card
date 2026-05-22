# Casa Provisioning Card

A Home Assistant Lovelace card to provision Casa devices via QR code or Bluetooth (BLE). It can be rendered as a card on your dashboard, hidden to run in the background via URL parameters/hashes, or triggered from other cards.

## Installation

### HACS
1. In Home Assistant, navigate to **HACS** > **Frontend**.
2. Click the three dots in the top right, select **Custom repositories**.
3. Add the URL of this repository and select **Dashboard** as the category.
4. Click **Add**, click **Download**, and reload your browser when prompted.

### Manual
1. Download `index.js` from the latest release.
2. Save it to `<config>/www/casa-card/index.js`.
3. In Home Assistant, go to **Settings** > **Dashboards** > **Resources**.
4. Add a new resource:
   - **URL:** `/local/casa-card/index.js`
   - **Type:** `JavaScript Module`

---

## Configuration

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `type` | string | **Required** | Must be `custom:casa-provision-card`. |
| `hidden` | boolean | `false` | Hides the card button (runs in the background waiting for hash/query parameters). |
| `hash_url` | string | `qr-code` | The hash or query parameter name that triggers the popup (e.g. `?qr-code` or `#qr-code`). |
| `intro_timeout` | number | `30` | Seconds to display the welcome screen before advancing (set to `0` to disable). |
| `intro_app` | boolean | `true` | Show the app store download pane before provisioning. |
| `ios_url` | string | `https://apps.apple.com` | iOS App Store URL. |
| `android_url` | string | `https://play.google.com` | Android Play Store URL. |
| `ble_progress_entity` | string | `sensor.casa_transfer_progress` | Sensor tracking BLE payload progress. |
| `ble_state_entity` | string | `sensor.casa_transponder_state` | Sensor/text entity tracking BLE transponder state. |
| `qr_service` | object | Optional | Configuration for the HA service used to generate provisioning QR codes. |
| `ble_service` | object | Optional | Configuration for the HA service used to start BLE provisioning. |

## Script Wrappers (Recommended for Security)

By default, Home Assistant restricts direct access to the `casa.generate_qr` and `casa.start_ble` services to administrators and system accounts. 

To allow non-admin dashboard users (such as guests or regular users) to trigger provisioning, you should wrap the service calls in a **Home Assistant Script**. Home Assistant scripts support returning response variables, which the card captures and processes automatically.

### 1. Create the Scripts in Home Assistant
Add the following to your scripts configuration:

```yaml
# Generate QR Script
generate_casa_qr:
  sequence:
    - service: casa.generate_qr
      data:
        duration: 300
      response_variable: qr_response
    - stop: "Done"
      response_variable: qr_response

# Start BLE Script
start_casa_ble:
  sequence:
    - service: casa.start_ble
      data:
        duration: 300
      response_variable: ble_response
    - stop: "Done"
      response_variable: ble_response
```

### 2. Configure the Card to Call the Scripts
Reference the scripts in your card configuration:
```yaml
type: custom:casa-provision-card
qr_service:
  service: script.generate_casa_qr
ble_service:
  service: script.start_casa_ble
```

---

## Configuration Examples

### Visible Card (Standard Tile Button)
Displays a standard clickable tile button on the dashboard.
```yaml
type: custom:casa-provision-card
hidden: false
qr_service:
  service: casa.generate_qr
  data:
    duration: 300
ble_service:
  service: casa.start_ble
  data:
    duration: 300
```

### Hidden Card (Background Handler)
Hides the card on the dashboard. It will only open when the specified parameter is in the URL.
```yaml
type: custom:casa-provision-card
hidden: true
hash_url: guest-wifi
qr_service:
  service: casa.generate_qr
  data:
    duration: 300
```

---

## Trigger Methods (For Hidden Cards)

### 1. URL Query Parameter (Recommended)
Add the parameter to your dashboard URL (e.g. `http://ha-ip:8123/lovelace/home?guest-wifi`). The HA router preserves query parameters, making them highly reliable.

To trigger from a dashboard button:
```yaml
type: button
name: Open WiFi Setup
icon: mdi:wifi
tap_action:
  action: navigate
  navigation_path: '?guest-wifi'
```

### 2. URL Hash
Append the hash to the URL (e.g. `http://ha-ip:8123/lovelace/home#guest-wifi`). 

To trigger from a dashboard button:
```yaml
type: button
name: Open WiFi Setup
icon: mdi:wifi
tap_action:
  action: navigate
  navigation_path: '#guest-wifi'
```

### 3. Custom DOM Event
Trigger the card without changing the URL.

To trigger from a dashboard button:
```yaml
type: button
name: Open WiFi Setup
icon: mdi:wifi
tap_action:
  action: fire-dom-event
  casa_action: start
```
