# Casa Provisioning Card

A custom Lovelace card for Home Assistant to handle Casa provisioning via QR code and Bluetooth (BLE).

## Installation via HACS

1. Go to **HACS** in your Home Assistant instance.
2. Click on **Frontend**.
3. Click the three dots (menu) in the top right corner and select **Custom repositories**.
4. Add your GitHub repository URL (e.g., `https://github.com/yourusername/casa-card`) and select **Dashboard** (or **Lovelace**) as the category.
5. Click **Add** and then **Download** the new Casa Provisioning Card repository that appears.
6. When prompted, reload your browser.

## Manual Installation

1. Download `index.js` from the latest release.
2. Copy `index.js` into your `<config>/www/casa-card/` directory.
3. Add the resource reference in your Home Assistant configuration (Settings -> Dashboards -> Resources):
   - URL: `/local/casa-card/index.js`
   - Type: JavaScript Module

## Usage
Add the custom card to your dashboard configuration:
```yaml
type: custom:casa-provision-card
# Add your configuration variables here
```
