const LitElement = window.LitElement || Object.getPrototypeOf(customElements.get("ha-panel-lovelace") || customElements.get("hui-masonry-view"));
const html = LitElement.prototype.html;
const css = LitElement.prototype.css;

// ============================================================================
// NATIVE FIRE EVENT
// ============================================================================
const fireEvent = (node, type, detail) => {
    const event = new Event(type, {
        bubbles: true,
        cancelable: false,
        composed: true,
    });
    event.detail = detail;
    node.dispatchEvent(event);
    return event;
};

// ============================================================================
// 1. THE EDITOR ELEMENT
// ============================================================================
export class CasaProvisionCardEditor extends LitElement {
    static get properties() {
        return {
            hass: { attribute: false },
            _config: { state: true }
        };
    }

    setConfig(config) {
        this._config = config;
    }

    get _schema() {
        return [
            { name: 'hidden', selector: { boolean: {} } },
            { name: 'hash_url', selector: { text: {} }, default: 'qr-code' },
            { name: 'intro_timeout', selector: { number: { min: 0, max: 300, mode: 'box' } }, default: 30 },
            { name: 'intro_app', selector: { boolean: {} }, default: true },
            { name: 'ios_url', selector: { text: {} }, default: 'https://apps.apple.com' },
            { name: 'android_url', selector: { text: {} }, default: 'https://play.google.com' },
            { name: 'ble_progress_entity', selector: { entity: { domain: 'sensor' } } },
            { name: 'ble_state_entity', selector: { entity: { domain: 'sensor', domain: 'text' } } },
            { name: 'qr_service', selector: { object: {} } },
            { name: 'ble_service', selector: { object: {} } },
        ];
    }

    _valueChanged(ev) {
        fireEvent(this, 'config-changed', { config: ev.detail.value });
    }

    render() {
        if (!this.hass || !this._config) return html``;

        return html`
      <ha-form
        .hass=${this.hass}
        .data=${this._config}
        .schema=${this._schema}
        .computeLabel=${this._computeLabel}
        @value-changed=${this._valueChanged}
      ></ha-form>
    `;
    }

    _computeLabel(schema) {
        const labels = {
            hidden: 'Hide Tile (Trigger via Hash/Button only)',
            hash_url: 'Trigger Hash URL (e.g., qr-code)',
            intro_timeout: 'Intro Timeout (Seconds, 0 = no timeout)',
            intro_app: 'Show App Download Pane',
            ios_url: 'iOS App Store URL',
            android_url: 'Android Play Store URL',
            ble_progress_entity: 'BLE Progress Sensor Entity ID',
            ble_state_entity: 'BLE State Sensor Entity ID',
            qr_service: 'QR Service YAML Dictionary',
            ble_service: 'BLE Service YAML Dictionary',
        };
        return labels[schema.name] || schema.name;
    }
}

if (!customElements.get('casa-provision-card-editor')) {
    customElements.define('casa-provision-card-editor', CasaProvisionCardEditor);
}

// ============================================================================
// 2. THE MAIN CARD ELEMENT
// ============================================================================
export class CasaProvisionCard extends LitElement {
    static get properties() {
        return {
            hass: { attribute: false },
            config: { state: true },
            activePane: { state: true },
            qrData: { state: true },
            countdown: { state: true },
            isExpired: { state: true },
            appQrUrl: { state: true },
            guestData: { state: true },
            serviceError: { state: true },
            lastAction: { state: true },
            isBleInitializing: { state: true }
        };
    }

    constructor() {
        super();
        this.activePane = 'hidden';
        this.qrData = null;
        this.countdown = 0;
        this.isExpired = false;
        this.countdownTimer = undefined;
        this.appQrUrl = null;
        this.guestData = null;
        this.serviceError = null;
        this.lastAction = null;
        this.isBleInitializing = false;
        this._bleCleared = true;
        this._isAuthenticatingLatch = false;
        this._isSubscribed = false; // Tracks HA subscription state safely
    }

    static async getConfigElement() {
        return document.createElement('casa-provision-card-editor');
    }

    static getStubConfig() {
        return {
            type: 'custom:casa-provision-card',
            hidden: false,
            hash_url: 'qr-code',
            intro_timeout: 30,
            intro_app: true,
            ios_url: 'https://apps.apple.com',
            android_url: 'https://play.google.com'
        };
    }

    setConfig(config) {
        if (!config) throw new Error("Invalid configuration");
        this.config = {
            intro_timeout: 30,
            intro_app: true,
            hash_url: 'qr-code',
            ios_url: 'https://apps.apple.com',
            android_url: 'https://play.google.com',
            ble_progress_entity: 'sensor.casa_transfer_progress',
            ble_state_entity: 'sensor.casa_transponder_state',
            ...config
        };
    }

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('hashchange', this.handleHashChange);
        this.handleHashChange();
    }

    // --- SAFE EVENT SUBSCRIPTION (Fires ONLY when 'this.hass' is ready) ---
    updated(changedProperties) {
        super.updated(changedProperties);

        if (changedProperties.has('hass') && this.hass && !this._isSubscribed) {
            this._isSubscribed = true;
            this.hass.connection.subscribeEvents(
                (event) => this.handleCodeRedeemed(event),
                'casa_code_redeemed'
            ).then(unsub => {
                this._unsubEvents = unsub; // Save the unsubscribe function
            }).catch(err => {
                console.error("Casa: Failed to subscribe to redeemed events:", err);
                this._isSubscribed = false; // Allow retry if it failed
            });
        }
    }

    disconnectedCallback() {
        window.removeEventListener('hashchange', this.handleHashChange);
        this.clearTimers();

        // Safely execute the unsubscribe function if it exists
        if (this._unsubEvents && typeof this._unsubEvents === 'function') {
            this._unsubEvents();
            this._unsubEvents = null;
        }
        this._isSubscribed = false;

        super.disconnectedCallback();
    }

    async clearBleBeacon() {
        if (!this.hass || this.lastAction !== 'ble' || this._bleCleared) return;

        this._bleCleared = true;
        try {
            await this.hass.callWS({
                type: 'call_service',
                domain: 'casa',
                service: 'clear_ble_beacon',
            });
            console.log("BLE Beacon cleared safely.");
        } catch (e) {
            console.error("Failed to clear BLE beacon", e);
        }
    }

    handleHashChange = () => {
        const currentHash = window.location.hash.replace('#', '');
        if (currentHash === this.config.hash_url && this.activePane === 'hidden') {
            this.startFlow();
        } else if (currentHash !== this.config.hash_url && this.activePane !== 'hidden') {
            this.closePopup();
        }
    };

    handleCodeRedeemed(event) {
        if (this.activePane !== 'hidden') {
            if (this.lastAction === 'ble') {
                this.clearBleBeacon();
            }

            this.clearTimers();
            this.qrData = null;
            this.appQrUrl = null;
            this.guestData = event.data; // Raw event.data perfectly matches your JSON payload
            this.activePane = 'success';
            setTimeout(() => this.closePopup(), 4000);
        }
    }

    startFlow() {
        window.location.hash = this.config.hash_url || 'qr-code';
        this.activePane = this.config.intro ? 'intro' : (this.config.intro_app ? 'app_links' : 'selection');
        this.appQrUrl = null;
        this.guestData = null;
        this.serviceError = null;
        this.lastAction = null;
        this.isBleInitializing = false;
        this._isAuthenticatingLatch = false;

        if (this.activePane === 'intro' && this.config.intro_timeout !== 0) {
            this.startUnifiedTimer(this.config.intro_timeout, () => this.nextPane());
        } else {
            this.clearTimers();
        }
    }

    nextPane() {
        this.clearTimers();
        this.appQrUrl = null;

        if (this.activePane === 'intro' && this.config.intro_app) {
            this.activePane = 'app_links';
        } else if (this.activePane === 'intro' || this.activePane === 'app_links') {

            const hasQR = !!this.config.qr_service;
            const hasBLE = !!this.config.ble_service;

            if (hasQR && !hasBLE) {
                this.generateQR();
            } else if (hasBLE && !hasQR) {
                this.provisionBLE();
            } else {
                this.activePane = 'selection';
            }
        }
    }

    closePopup() {
        if (this.lastAction === 'ble') {
            this.clearBleBeacon();
        }

        this.activePane = 'hidden';
        this.qrData = null;
        this.appQrUrl = null;
        this.guestData = null;
        this.serviceError = null;
        this.isExpired = false;
        this.lastAction = null;
        this.isBleInitializing = false;
        this._isAuthenticatingLatch = false;
        this.clearTimers();
        window.history.replaceState(null, '', window.location.pathname);
    }

    retryAction() {
        if (this.lastAction === 'qr') {
            this.generateQR();
        } else if (this.lastAction === 'ble') {
            this.provisionBLE();
        }
    }

    startUnifiedTimer(durationSeconds, onExpireCallback) {
        this.clearTimers();
        if (!durationSeconds || durationSeconds <= 0) return;

        this.countdown = durationSeconds;
        this.isExpired = false;

        const endTime = Date.now() + durationSeconds * 1000;

        this.countdownTimer = window.setInterval(() => {
            const timeLeftMs = endTime - Date.now();
            if (timeLeftMs <= 0) {
                this.countdown = 0;
                this.isExpired = true;
                clearInterval(this.countdownTimer);

                if (this.lastAction === 'ble') {
                    this.clearBleBeacon();
                }

                if (onExpireCallback) onExpireCallback();
            } else {
                this.countdown = Math.ceil(timeLeftMs / 1000);
            }
        }, 1000);
    }

    clearTimers() {
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        this.countdownTimer = undefined;
        this.countdown = 0;
    }

    async generateQR() {
        if (!this.config.qr_service) return;
        this.serviceError = null;
        this.activePane = 'qr';
        this.lastAction = 'qr';
        this._isAuthenticatingLatch = false;

        try {
            const result = await this.hass.callWS({
                type: 'call_service',
                domain: this.config.qr_service.service.split('.')[0],
                service: this.config.qr_service.service.split('.')[1],
                service_data: this.config.qr_service.data,
                return_response: true
            });

            this.qrData = result.response || result;

            if (this.qrData.error) throw new Error(this.qrData.error);
            if (!this.qrData.url_path) throw new Error(this.qrData.message || "Invalid response: No QR path provided.");

            const expiresAt = this.qrData.qr_expires_at;
            const duration = expiresAt ? (expiresAt - Math.floor(Date.now() / 1000)) : 60;

            this.startUnifiedTimer(duration, () => {
                setTimeout(() => this.closePopup(), 30000);
            });

        } catch (e) {
            console.error("QR Generation Failed", e);
            this.serviceError = e.message || "Failed to generate QR. Check integration configuration.";
        }
    }

    async provisionBLE() {
        if (!this.config.ble_service) return;
        this.serviceError = null;
        this.activePane = 'ble';
        this.lastAction = 'ble';
        this._bleCleared = false;

        this.isBleInitializing = true;
        this._isAuthenticatingLatch = false;

        try {
            const result = await this.hass.callWS({
                type: 'call_service',
                domain: this.config.ble_service.service.split('.')[0],
                service: this.config.ble_service.service.split('.')[1],
                service_data: this.config.ble_service.data,
                return_response: true
            });

            const responseData = result.response || result;
            const expiresAt = responseData.ble_expires_at;
            const duration = expiresAt ? (expiresAt - Math.floor(Date.now() / 1000)) : 60;

            this.startUnifiedTimer(duration, () => {
                setTimeout(() => this.closePopup(), 30000);
            });

            setTimeout(() => {
                this.isBleInitializing = false;
            }, 1500);

        } catch (e) {
            console.error("BLE Provisioning Failed", e);
            this.isBleInitializing = false;
            this.serviceError = e.message || "Failed to start BLE. Check integration configuration.";
        }
    }

    render() {
        const isEditMode = this.closest('hui-card-preview') !== null;

        if (this.config.hidden && this.activePane === 'hidden') {
            if (isEditMode) {
                return html`<div class="casa-holder">Casa Provision Holder (Hidden Card)</div>`;
            }
            return html``;
        }

        return html`
      ${this.activePane === 'hidden' && !this.config.hidden ? this.renderTileButton() : ''}
      ${this.activePane !== 'hidden' ? this.renderPopupOverlay() : ''}
    `;
    }

    renderTileButton() {
        return html`
      <ha-card @click=${this.startFlow} class="tile-button">
        <div class="tile-content">
          <ha-icon icon="mdi:qrcode-scan"></ha-icon>
          <span>Guest Access</span>
        </div>
      </ha-card>
    `;
    }

    renderPopupOverlay() {
        return html`
      <div class="popup-overlay" @click=${this.handleOverlayClick}>
        <div class="popup-card casa-theme">
          
          ${this.activePane !== 'success' ? html`
            <div class="close-wrapper" @click=${this.closePopup}>
              <ha-icon icon="mdi:close" class="close-icon"></ha-icon>
            </div>
          ` : ''}
          
          ${this.activePane === 'intro' ? html`
            <div class="pane pane-intro fade-in">
              <div class="casa-spinner"></div>
              <h2>Welcome</h2>
              <p class="casa-subtitle">Guest Access Provisioning System</p>
              
              <div class="casa-btn-row" style="justify-content: center; margin-top: 24px;">
                <button class="casa-btn blue" @click=${this.nextPane}>Continue</button>
              </div>
            </div>
          ` : ''}

          ${this.activePane === 'app_links' ? html`
            <div class="pane pane-apps fade-in">
              <h2>Download the App</h2>
              
              ${this.appQrUrl ? html`
                <div class="qr-container fade-in">
                  <p class="casa-subtitle">Scan to download</p>
                  <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(this.appQrUrl)}&margin=10" alt="App Store QR Code" />
                </div>
                <div class="casa-btn-row" style="justify-content: center; margin-top: 16px;">
                  <button class="casa-btn secondary" @click=${() => this.appQrUrl = null}>Back</button>
                  <button class="casa-btn blue" @click=${this.nextPane}>Continue</button>
                </div>
              ` : html`
                <p class="casa-subtitle" style="margin-bottom: 24px;">Select your platform to get the app.</p>
                <div class="store-icons">
                  <div class="store-icon ios" @click=${() => this.appQrUrl = this.config.ios_url}>
                    <ha-icon icon="mdi:apple"></ha-icon>
                    <span>iOS</span>
                  </div>
                  <div class="store-icon android" @click=${() => this.appQrUrl = this.config.android_url}>
                    <ha-icon icon="mdi:android"></ha-icon>
                    <span>Android</span>
                  </div>
                </div>
                <div class="casa-btn-row" style="justify-content: center; margin-top: 24px;">
                  <button class="casa-btn blue" @click=${this.nextPane}>Skip to Provisioning</button>
                </div>
              `}
            </div>
          ` : ''}

          ${this.activePane === 'selection' ? html`
            <div class="pane pane-selection fade-in">
              <h2>Select Provisioning Method</h2>
              <p class="casa-subtitle">Choose your preferred connection protocol.</p>
              
              <div style="width: 100%; max-width: 250px; margin-top: 24px;">
                ${this.config.ble_service ? html`<button class="casa-btn blue" style="width: 100%; margin-bottom: 12px; max-width: none;" @click=${this.provisionBLE}>BLE Provisioning</button>` : ''}
                ${this.config.qr_service ? html`<button class="casa-btn blue" style="width: 100%; margin-bottom: 8px; max-width: none;" @click=${this.generateQR}>QR Provisioning</button>` : ''}
              </div>
            </div>
          ` : ''}

          ${this.activePane === 'qr' || this.activePane === 'ble' ? this.renderQRView() : ''}

          ${this.activePane === 'success' ? html`
            <div class="pane pane-success fade-in">
              <div class="success-animation">
                <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                  <circle class="checkmark__circle" cx="26" cy="26" r="25" fill="none"/>
                  <path class="checkmark__check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                </svg>
              </div>
              <h2 style="margin-top: 1rem; margin-bottom: 0.5rem;">Access Granted</h2>
              <p class="casa-subtitle">
                ${this.guestData?.client_name ? `${this.guestData.client_name} successfully connected.` : 'Device successfully connected.'}
              </p>
            </div>
          ` : ''}
        </div>
      </div>
    `;
    }

    renderQRView() {
        if (this.serviceError) return html`
      <div class="pane fade-in">
        <div class="error-animation">
          <svg class="cross" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
            <circle class="cross__circle" cx="26" cy="26" r="25" fill="none"/>
            <path class="cross__path cross__path--right" fill="none" d="M16,16 l20,20"/>
            <path class="cross__path cross__path--left" fill="none" d="M16,36 l20,-20"/>
          </svg>
        </div>
        <h2 style="margin-top: 0; margin-bottom: 8px;">Service Error</h2>
        <p class="casa-subtitle" style="padding: 0 16px;">${this.serviceError}</p>
        <div class="casa-btn-row" style="margin-top: 24px; justify-content: center;">
          <button class="casa-btn secondary" @click=${this.closePopup}>Close</button>
          ${this.lastAction ? html`<button class="casa-btn blue" @click=${() => this.retryAction()}>Retry</button>` : ''}
        </div>
      </div>
    `;

        // ----------------------------------------------------
        // BLE UI RENDERING
        // ----------------------------------------------------
        if (this.activePane === 'ble') {

            // 1. HARD LOCK: Initializing State. Completely skip reading HA state until safe.
            if (this.isBleInitializing || (this.countdown === 0 && !this.isExpired)) {
                return html`
          <div class="pane fade-in">
            <div class="casa-spinner large"></div>
            <h2>Initializing BLE...</h2>
            <p class="casa-subtitle">Starting Bluetooth payload.</p>
          </div>
        `;
            }

            // 2. SAFE TO READ STATE: Once the lock drops, fetch the actual sensor data
            let currentProgress = 0;
            let currentState = 'idle';

            if (this.hass) {
                const pEnt = this.hass.states[this.config.ble_progress_entity];
                const sEnt = this.hass.states[this.config.ble_state_entity];
                if (pEnt && !isNaN(parseInt(pEnt.state, 10))) {
                    currentProgress = parseInt(pEnt.state, 10);
                }
                if (sEnt && sEnt.state) {
                    currentState = sEnt.state.toLowerCase();
                }
            }

            // LATCH TRIGGER: If HA says we reached 100%, lock the UI into Authenticating
            if (currentProgress >= 100 || currentState.includes('transfered') || currentState.includes('transferred')) {
                this._isAuthenticatingLatch = true;
            }

            // 3. Authenticating State (Takes priority once latched)
            if (this._isAuthenticatingLatch) {
                return html`
          <div class="pane fade-in">
            <div class="casa-spinner large"></div>
            <h2>Authenticating...</h2>
            <p class="casa-subtitle">Verifying guest credentials.</p>
          </div>
        `;
            }

            // 4. Transferring State (Active Data Exchange)
            else if (currentProgress > 0 || currentState === 'transferring') {
                const radius = 46;
                const circumference = 2 * Math.PI * radius;
                const offset = circumference - (currentProgress / 100) * circumference;

                return html`
          <div class="pane fade-in">
            <div class="progress-ring-container">
               <svg width="100" height="100" style="transform: rotate(-90deg);">
                 <circle stroke="#e0e0e0" stroke-width="8" fill="transparent" r="46" cx="50" cy="50"/>
                 <circle class="ring-fill" stroke="#1a73e8" stroke-width="8" stroke-linecap="round" fill="transparent" r="46" cx="50" cy="50"
                         stroke-dasharray="${circumference} ${circumference}" stroke-dashoffset="${offset}"/>
               </svg>
               <div class="progress-ring__text">${currentProgress}%</div>
            </div>
            <h2 style="margin-top: 24px;">Transferring...</h2>
            <p class="casa-subtitle">Keep your device nearby.</p>
            <div class="casa-btn-row" style="margin-top: 16px; justify-content: center;">
              <button class="casa-btn secondary" @click=${this.closePopup}>Cancel</button>
            </div>
          </div>
        `;
            }

            // 5. Broadcasting State (Default active state waiting for user)
            else {
                const minutes = Math.floor(this.countdown / 60);
                const seconds = this.countdown % 60;
                const formattedTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

                return html`
          <div class="pane fade-in">
             <h2>BLE Provisioning</h2>
             <p class="casa-subtitle">Bring your guest device near the transponder.</p>
             
             <div style="padding: 16px 40px; text-align: center;">
                <div class="ble-pulse-container">
                   <ha-icon icon="mdi:bluetooth-transfer" class="ble-icon"></ha-icon>
                   <div class="ble-pulse-ring"></div>
                </div>
                <p style="margin-top: 24px; font-weight: 500;">Broadcasting</p>
             </div>
             
             ${!this.isExpired && this.countdown > 0 ? html`
               <div class="casa-timer-box">
                 <ha-icon icon="mdi:clock-outline" style="--mdc-icon-size: 16px;"></ha-icon>
                 <span>${formattedTime}</span>
               </div>
             ` : ''}

             <div class="casa-btn-row" style="margin-top: 16px; justify-content: center;">
               <button class="casa-btn blue" @click=${this.closePopup}>Close</button>
             </div>
          </div>
        `;
            }
        }

        // ----------------------------------------------------
        // QR UI RENDERING (Fallback)
        // ----------------------------------------------------
        if (!this.qrData) return html`
      <div class="pane fade-in">
        <div class="casa-spinner large"></div>
        <h2>Generating QR...</h2>
        <p class="casa-subtitle">Contacting Home Assistant.</p>
      </div>
    `;

        const qMin = Math.floor(this.countdown / 60);
        const qSec = this.countdown % 60;
        const qTime = `${qMin.toString().padStart(2, '0')}:${qSec.toString().padStart(2, '0')}`;

        return html`
      <div class="pane pane-qr fade-in">
        <h2>Guest Access Provisioning</h2>
        <p class="casa-subtitle">Scan the code below to connect your guest device.</p>
        
        <div class="qr-container ${this.isExpired ? 'expired' : ''}">
          <img src="${this.qrData.url_path}" alt="Provisioning QR Code" />
          ${this.isExpired ? html`<div class="expired-text">QR Code Expired</div>` : ''}
        </div>
        
        ${!this.isExpired && this.countdown > 0 ? html`
          <div class="casa-timer-box">
            <ha-icon icon="mdi:clock-outline" style="--mdc-icon-size: 16px;"></ha-icon>
            <span>${qTime}</span>
          </div>
        ` : ''}

        <div class="casa-btn-row" style="margin-top: 24px; justify-content: center;">
          <button class="casa-btn blue" @click=${this.closePopup}>Close</button>
        </div>
      </div>
    `;
    }

    static get styles() {
        return css`
      /* --- TILE BUTTON --- */
      ha-card.tile-button {
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        height: 100%; min-height: 40px; border-radius: 0.5rem; transition: background-color 0.15s ease-in-out;
      }
      ha-card.tile-button:hover { background-color: var(--secondary-background-color); }
      .casa-holder {
        border: 2px dashed var(--primary-color); padding: 16px; text-align: center;
        border-radius: 0.5rem; color: var(--primary-text-color); opacity: 0.7;
      }

      /* --- MODAL OVERLAY --- */
      .popup-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.4); z-index: 9999;
        display: flex; align-items: center; justify-content: center;
      }

      /* --- CASA MODAL STYLING (DYNAMIC SIZE) --- */
      .popup-card.casa-theme {
        background-color: #ffffff; 
        border-radius: 6px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
        padding: 32px 24px 24px 24px; 
        width: 90%; max-width: 360px; 
        min-height: 240px; 
        height: auto;      
        transition: all 0.3s ease-in-out;
        display: flex; flex-direction: column;
        position: relative; overflow: hidden;
        color: #333; 
      }
      
      .pane { 
        display: flex; flex-direction: column; align-items: center; justify-content: center; 
        width: 100%; text-align: center;
      }
      .fade-in { animation: fadeIn 0.2s ease-out forwards; }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

      /* --- TOP-RIGHT 'X' CLOSE ICON --- */
      .close-wrapper {
        position: absolute; top: 16px; right: 16px; width: 34px; height: 34px;
        border: 3px solid #e0e0e0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: background-color 0.15s, border-color 0.15s;
        z-index: 10; background: #ffffff;
      }
      .close-wrapper:hover { background-color: #f5f5f5; border-color: #c0c0c0; }
      .close-icon { color: #666; --mdc-icon-size: 20px; }

      /* --- CASA TYPOGRAPHY --- */
      h2 { margin: 16px 0 8px 0; font-weight: 500; font-size: 1.4rem; color: #4a4a4a; font-family: -apple-system, system-ui, sans-serif; }
      .casa-subtitle { color: #888; font-size: 0.95rem; margin: 0 0 20px 0; }

      /* --- CASA LOADING SPINNER --- */
      .casa-spinner {
        width: 36px; height: 36px; border: 3px solid rgba(26, 115, 232, 0.2);
        border-top: 3px solid #1a73e8; border-radius: 50%;
        animation: spin 1s linear infinite; margin-bottom: 8px;
      }
      .casa-spinner.large { width: 64px; height: 64px; border-width: 4px; border-top-width: 4px; margin-bottom: 24px; margin-top: 24px; }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

      /* --- CASA TIMER BOX --- */
      .casa-timer-box {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        background-color: #f5f5f5; border: 1px solid #e0e0e0; padding: 6px 16px; border-radius: 4px;
        font-family: monospace; font-size: 1rem; color: #555; margin-bottom: 16px; margin-top: 8px; letter-spacing: 1px;
      }

      /* --- CASA BUTTONS --- */
      .casa-btn-row { display: flex; gap: 16px; width: 100%; }
      .casa-btn { padding: 10px 24px; border: none; border-radius: 4px; color: white; font-weight: 500; font-size: 1rem; cursor: pointer; font-family: inherit; transition: opacity 0.15s; }
      .casa-btn:hover { opacity: 0.85; }
      .casa-btn.blue { background-color: #1a73e8; }
      .casa-btn.secondary { background-color: #6c757d; }

      /* --- QR SPECIFIC --- */
      .qr-container { position: relative; text-align: center; width: 100%; padding: 0 0 16px 0; }
      .qr-container img { width: 100%; max-width: 200px; max-height: 200px; object-fit: contain; border-radius: 4px; background: white; padding: 8px; }
      .qr-container.expired img { filter: blur(8px); }
      .expired-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(211, 47, 47, 0.9); color: white; padding: 6px 12px; border-radius: 4px; font-weight: 500; }
      .store-icons { display: flex; justify-content: center; gap: 24px; width: 100%; margin-bottom: 1rem; }
      .store-icon { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 90px; height: 90px; border-radius: 6px; background: rgba(0,0,0,0.03); color: #4a4a4a; cursor: pointer; transition: transform 0.15s; border: 2px solid transparent; }
      .store-icon:hover { transform: translateY(-2px); }
      .store-icon.ios:hover { border-color: #007aff; color: #007aff; }
      .store-icon.android:hover { border-color: #3ddc84; color: #3ddc84; }
      .store-icon ha-icon { --mdc-icon-size: 36px; margin-bottom: 8px; }

      /* --- BLE SPECIFIC --- */
      .ble-pulse-container { position: relative; width: 80px; height: 80px; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
      .ble-icon { --mdc-icon-size: 56px; color: #1a73e8; z-index: 2; }
      .ble-pulse-ring {
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        background-color: rgba(26, 115, 232, 0.2); border-radius: 50%;
        animation: pulseRing 1.5s cubic-bezier(0.215, 0.61, 0.355, 1) infinite; z-index: 1;
      }
      @keyframes pulseRing {
        0% { transform: scale(0.6); opacity: 1; }
        100% { transform: scale(1.4); opacity: 0; }
      }

      /* Circular Progress */
      .progress-ring-container { position: relative; width: 100px; height: 100px; margin: 0 auto; }
      .progress-ring__text {
        position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
        font-weight: 600; font-size: 1.2rem; color: #1a73e8; font-family: monospace;
      }
      .ring-fill { transition: stroke-dashoffset 0.1s linear; }

      /* --- SUCCESS/ERROR ANIMATIONS --- */
      .pane-success { padding: 1rem 0; }
      .success-animation { display: flex; justify-content: center; margin-bottom: 1rem; }
      .checkmark { width: 60px; height: 60px; border-radius: 50%; display: block; stroke-width: 3; stroke: #1a73e8; stroke-miterlimit: 10; animation: scale .3s ease-in-out .9s both; }
      .checkmark__circle { stroke-dasharray: 166; stroke-dashoffset: 166; fill: none; animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards; }
      .checkmark__check { transform-origin: 50% 50%; stroke-dasharray: 48; stroke-dashoffset: 48; animation: stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.8s forwards; }
      .error-animation { display: flex; justify-content: center; margin-bottom: 1rem; margin-top: 1rem; }
      .cross { width: 64px; height: 64px; border-radius: 50%; display: block; stroke-width: 3; stroke: #d32f2f; stroke-miterlimit: 10; animation: scale .3s ease-in-out both; }
      .cross__circle { stroke-dasharray: 166; stroke-dashoffset: 166; fill: none; animation: stroke 0.4s cubic-bezier(0.65, 0, 0.45, 1) forwards; }
      .cross__path { stroke-dasharray: 48; stroke-dashoffset: 48; transform-origin: 50% 50%; }
      .cross__path--right { animation: stroke 0.2s cubic-bezier(0.65, 0, 0.45, 1) 0.3s forwards; }
      .cross__path--left { animation: stroke 0.2s cubic-bezier(0.65, 0, 0.45, 1) 0.4s forwards; }
      @keyframes stroke { 100% { stroke-dashoffset: 0; } }
      @keyframes scale { 0%, 100% { transform: none; } 50% { transform: scale3d(1.1, 1.1, 1); } }
    `;
    }
}

if (!customElements.get('casa-provision-card')) {
    customElements.define('casa-provision-card', CasaProvisionCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'casa-provision-card',
    name: 'Casa Provision Card',
    preview: true,
    description: 'A custom card for Casa QR and BLE provisioning flows.',
});