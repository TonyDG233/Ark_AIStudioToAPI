/**
 * File: src/core/BrowserManager.js
 * Description: Browser manager for launching and controlling headless Firefox instances with authentication contexts
 *
 * Author: Ellinav, iBenzene, bbbugg, 鎸堟寛
 */

const fs = require("fs");
const path = require("path");
const { firefox, devices } = require("playwright");
const os = require("os");

/**
 * Browser Manager Module
 * Responsible for launching, managing, and switching browser contexts
 */
class BrowserManager {
    constructor(logger, config, authSource) {
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        this.browser = null;
        this.context = null;
        this.page = null;
        // currentAuthIndex is the single source of truth for current account, accessed via getter/setter
        // -1 means no account is currently active (invalid/error state)
        this._currentAuthIndex = -1;
        this.scriptFileName = "build.js";
        this.cacheRootDir = path.join(process.cwd(), "cache");
        this.cacheMetaFileName = "meta.json";
        this.cacheStateFileName = "storage-state.json";
        this.currentContextOptions = null;

        // Flag to distinguish intentional close from unexpected disconnect
        // Used by ConnectionRegistry callback to skip unnecessary reconnect attempts
        this.isClosingIntentionally = false;

        // Added for background wakeup logic from new core
        this.noButtonCount = 0;

        // Firefox/Camoufox does not use Chromium-style command line args.
        // We keep this empty; Camoufox has its own anti-fingerprinting optimizations built-in.
        this.launchArgs = [];

        // Firefox-specific preferences for optimization (passed to firefox.launch)
        this.firefoxUserPrefs = {
            "app.update.enabled": false, // Disable auto updates
            "browser.cache.disk.enable": false, // Disable disk cache
            "browser.ping-centre.telemetry": false, // Disable ping telemetry
            "browser.safebrowsing.enabled": false, // Disable safe browsing
            "browser.safebrowsing.malware.enabled": false, // Disable malware check
            "browser.safebrowsing.phishing.enabled": false, // Disable phishing check
            "browser.search.update": false,
            // [Fix] Ensure session resume on crash
            "browser.sessionstore.restore_on_demand": false,

            // [Fix] Restore previous session
            "browser.sessionstore.resume_from_crash": true,

            // Disable search engine auto-update
            "browser.shell.checkDefaultBrowser": false,

            // No warning on closing tabs
            "browser.startup.page": 3,

            // Skip default browser check
            "browser.tabs.warnOnClose": false,
            // [Fix] Allow unlimited crash resumes
            "datareporting.policy.dataSubmissionEnabled": false,

            // Disable data reporting
            "dom.webnotifications.enabled": false,

            // Disable notifications
            "extensions.update.enabled": false,

            // Disable extension auto-update
            "general.smoothScroll": false,

            // Disable smooth scrolling
            "gfx.webrender.all": false,

            // Disable WebRender (GPU-based renderer)
            "layers.acceleration.disabled": true,

            // Disable GPU hardware acceleration
            "media.autoplay.default": 5,

            // 5 = Block all autoplay
            "media.volume_scale": "0.0",

            // Mute audio
            "network.dns.disablePrefetch": true,

            // Disable DNS prefetching
            "network.http.speculative-parallel-limit": 0,

            // Disable speculative connections
            "network.prefetch-next": false,

            // Disable link prefetching
            "permissions.default.geo": 0,

            // 0 = Always deny geolocation
            "services.sync.enabled": false,

            // Disable Firefox Sync
            "toolkit.cosmeticAnimations.enabled": false,
            // [Fix] Force load all tabs immediately so Playwright sees them
            "toolkit.startup.max_resumed_crashes": -1, // Disable UI animations
            "toolkit.telemetry.archive.enabled": false, // Disable telemetry archive
            "toolkit.telemetry.enabled": false, // Disable telemetry
            "toolkit.telemetry.unified": false, // Disable unified telemetry
        };

        if (this.config.browserExecutablePath) {
            this.browserExecutablePath = this.config.browserExecutablePath;
        } else {
            const platform = os.platform();
            if (platform === "linux") {
                this.browserExecutablePath = path.join(process.cwd(), "camoufox-linux", "camoufox");
            } else if (platform === "win32") {
                this.browserExecutablePath = path.join(process.cwd(), "camoufox", "camoufox.exe");
            } else if (platform === "darwin") {
                this.browserExecutablePath = path.join(
                    process.cwd(),
                    "camoufox-macos",
                    "Camoufox.app",
                    "Contents",
                    "MacOS",
                    "camoufox"
                );
            } else {
                throw new Error(`Unsupported operating system: ${platform}`);
            }
        }
    }

    get currentAuthIndex() {
        return this._currentAuthIndex;
    }

    set currentAuthIndex(value) {
        this._currentAuthIndex = value;
    }

    /**
     * Feature: Update authentication file
     * Writes the current storageState back to the auth file, effectively extending session validity.
     * @param {number} authIndex - The auth index to update
     */
    async _updateAuthFile(authIndex) {
        if (!this.context) return;

        // Check availability of auto-update feature from config
        if (!this.config.enableAuthUpdate) {
            await this._persistContextCache(authIndex);
            return;
        }

        try {
            const configDir = path.join(process.cwd(), "configs", "auth");
            const authFilePath = path.join(configDir, `auth-${authIndex}.json`);

            // Read original file content to preserve all fields (e.g. accountName, custom fields)
            // Relies on AuthSource validation (checks valid index AND file existence)
            const authData = this.authSource.getAuth(authIndex);
            if (!authData) {
                this.logger.warn(
                    `[Auth Update] Auth source #${authIndex} returned no data (invalid index or file missing), skipping update.`
                );
                return;
            }

            const storageState = await this.context.storageState();

            // Merge new credentials into existing data
            authData.cookies = storageState.cookies;
            authData.origins = storageState.origins;

            // Note: We do NOT force-set accountName. If it was there, it stays; if not, it remains missing.
            // This preserves the "missing state" as requested.

            // Overwrite the file with merged data
            await fs.promises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

            this.logger.info(`[Auth Update] ✅ Successfully updated auth credentials for account #${authIndex}`);
        } catch (error) {
            this.logger.error(`[Auth Update] ❌ Failed to update auth file: ${error.message}`);
        }

        await this._persistContextCache(authIndex);
    }

    _getCacheRootDir() {
        return this.cacheRootDir;
    }

    _getAccountCacheDir(authIndex) {
        return path.join(this._getCacheRootDir(), `auth-${authIndex}`);
    }

    _getAccountCacheMetaPath(authIndex) {
        return path.join(this._getAccountCacheDir(authIndex), this.cacheMetaFileName);
    }

    _getAccountCacheStatePath(authIndex) {
        return path.join(this._getAccountCacheDir(authIndex), this.cacheStateFileName);
    }

    _readCacheMeta(authIndex) {
        const metaPath = this._getAccountCacheMetaPath(authIndex);
        if (!fs.existsSync(metaPath)) return null;
        try {
            const raw = fs.readFileSync(metaPath, "utf-8");
            return JSON.parse(raw);
        } catch (error) {
            this.logger.warn(`[Cache] Failed to read cache metadata for account #${authIndex}: ${error.message}`);
            return null;
        }
    }

    _writeCacheMeta(authIndex, meta) {
        const cacheDir = this._getAccountCacheDir(authIndex);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const metaPath = this._getAccountCacheMetaPath(authIndex);
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    _resolveContextOptions(authIndex) {
        const cacheMeta = this._readCacheMeta(authIndex);
        const cachedOptions = cacheMeta?.contextOptions || {};

        let viewport = cachedOptions.viewport;
        if (
            !viewport ||
            typeof viewport.width !== "number" ||
            typeof viewport.height !== "number" ||
            viewport.width <= 0 ||
            viewport.height <= 0
        ) {
            const randomWidth = 1920 + Math.floor(Math.random() * 50);
            const randomHeight = 1080 + Math.floor(Math.random() * 50);
            viewport = { height: randomHeight, width: randomWidth };
        }

        const contextOptions = {
            deviceScaleFactor:
                typeof cachedOptions.deviceScaleFactor === "number" ? cachedOptions.deviceScaleFactor : 1,
            viewport,
        };

        return { cacheMeta, contextOptions };
    }

    async _persistContextCache(authIndex) {
        if (!this.context) return;

        const cacheDir = this._getAccountCacheDir(authIndex);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        try {
            const storageStatePath = this._getAccountCacheStatePath(authIndex);
            await this.context.storageState({
                includeIndexedDB: true,
                path: storageStatePath,
            });

            const existingMeta = this._readCacheMeta(authIndex);
            const nowIso = new Date().toISOString();
            const viewport = this.currentContextOptions?.viewport || this.page?.viewportSize();
            const deviceScaleFactor =
                typeof this.currentContextOptions?.deviceScaleFactor === "number"
                    ? this.currentContextOptions.deviceScaleFactor
                    : 1;

            const contextOptions = {
                deviceScaleFactor,
                ...(viewport ? { viewport } : {}),
            };

            this._writeCacheMeta(authIndex, {
                authIndex,
                contextOptions,
                createdAt: existingMeta?.createdAt || nowIso,
                storageStatePath: path.basename(storageStatePath),
                updatedAt: nowIso,
                version: 1,
            });

            this.logger.info(`[Cache] ✅ Persisted cache snapshot for account #${authIndex}`);
        } catch (error) {
            this.logger.warn(`[Cache] Failed to persist cache snapshot for account #${authIndex}: ${error.message}`);
        }
    }

    _clearAccountCache(authIndex) {
        const cacheDir = this._getAccountCacheDir(authIndex);
        if (!fs.existsSync(cacheDir)) return;
        try {
            fs.rmSync(cacheDir, { force: true, recursive: true });
            this.logger.warn(`[Cache] Removed cache directory for account #${authIndex}`);
        } catch (error) {
            this.logger.warn(`[Cache] Failed to remove cache directory for account #${authIndex}: ${error.message}`);
        }
    }

    /**
     * Interface: Notify user activity
     * Used to force wake up the Launch detection when a request comes in
     */
    notifyUserActivity() {
        if (this.noButtonCount > 0) {
            this.logger.info("[Browser] ⚡User activity detected, forcing Launch detection wakeup...");
            this.noButtonCount = 0;
        }
    }

    /**
     * Helper: Generate a consistent numeric seed from a string
     * Used to keep fingerprints consistent for the same account index
     */
    _generateIdentitySeed(str) {
        let hashValue = 0;
        for (let i = 0; i < str.length; i++) {
            const charCode = str.charCodeAt(i);
            hashValue = (hashValue << 5) - hashValue + charCode;
            hashValue |= 0; // Convert to 32bit integer
        }
        return Math.abs(hashValue);
    }

    /**
     * Feature: Generate Privacy Protection Script (Stealth Mode)
     * Injects specific GPU info and masks webdriver properties to avoid bot detection.
     */
    _getPrivacyProtectionScript(authIndex) {
        // Use a consistent seed so the fingerprint remains static for this specific account
        let seed = this._generateIdentitySeed(`account_salt_${authIndex}`);

        // Pseudo-random generator based on the seed
        const deterministicRandom = () => {
            const x = Math.sin(seed++) * 10000;
            return x - Math.floor(x);
        };

        // Select a GPU profile consistent with this account
        const gpuProfiles = [
            { renderer: "Intel Iris OpenGL Engine", vendor: "Intel Inc." },
            {
                renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (NVIDIA)",
            },
            {
                renderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
                vendor: "Google Inc. (AMD)",
            },
        ];
        const profile = gpuProfiles[Math.floor(deterministicRandom() * gpuProfiles.length)];

        // We inject a noise variable to make the environment unique but stable
        const randomArtifact = Math.floor(deterministicRandom() * 1000);

        return `
            (function() {
                if (window._privacyProtectionInjected) return;
                window._privacyProtectionInjected = true;

                try {
                    // 1. Mask WebDriver property
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                    // 2. Mock Plugins if empty
                    if (navigator.plugins.length === 0) {
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => new Array(${3 + Math.floor(deterministicRandom() * 3)}),
                        });
                    }

                    // 3. Spoof WebGL Renderer (High Impact)
                    const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
                    WebGLRenderingContext.prototype.getParameter = function(parameter) {
                        // 37445: UNMASKED_VENDOR_WEBGL
                        // 37446: UNMASKED_RENDERER_WEBGL
                        if (parameter === 37445) return '${profile.vendor}';
                        if (parameter === 37446) return '${profile.renderer}';
                        return getParameterProxy.apply(this, arguments);
                    };

                    // 4. Inject benign noise
                    window['_canvas_noise_${randomArtifact}'] = '${randomArtifact}';

                    if (window === window.top) {
                        console.log("[ProxyClient] Privacy protection layer active: ${profile.renderer}");
                    }
                } catch (err) {
                    console.error("[ProxyClient] Failed to inject privacy script", err);
                }
            })();
        `;
    }

    /**
     * Feature: Natural Mouse Movement
     * Simulates human-like mouse jitters instead of instant teleportation
     */
    async _simulateHumanMovement(page, targetX, targetY) {
        try {
            // Split movement into 3 segments with random deviations
            const steps = 3;
            for (let i = 1; i <= steps; i++) {
                const intermediateX = targetX + (Math.random() - 0.5) * (100 / i);
                const intermediateY = targetY + (Math.random() - 0.5) * (100 / i);

                // Final step must be precise
                const destX = i === steps ? targetX : intermediateX;
                const destY = i === steps ? targetY : intermediateY;

                await page.mouse.move(destX, destY, {
                    steps: 5 + Math.floor(Math.random() * 5), // Optimized speed (was 10-20)
                });
            }
        } catch (e) {
            // Ignore movement errors if page is closed
        }
    }

    /**
     * Feature: Smart "Code" Button Clicking
     * Tries multiple selectors (Code, Develop, Edit, Icons) to be robust against UI changes.
     */
    async _smartClickCode(page) {
        const selectors = [
            // Priority 1: Exact text match (Fastest)
            'button:text("Code")',
            // Priority 2: Alternative texts used by Google
            'button:text("Develop")',
            'button:text("Edit")',
            // Priority 3: Fuzzy attribute matching
            'button[aria-label*="Code"]',
            'button[aria-label*="code"]',
            // Priority 4: Icon based
            'button mat-icon:text("code")',
            'button span:has-text("Code")',
        ];

        this.logger.info('[Browser] Trying to locate "Code" entry point using smart selectors...');

        for (const selector of selectors) {
            try {
                // Use a short timeout for quick fail-over
                const element = page.locator(selector).first();
                if (await element.isVisible({ timeout: 2000 })) {
                    this.logger.info(`[Browser] ✅ Smart match: "${selector}", clicking...`);
                    // Direct click with force as per new logic
                    await element.click({ force: true, timeout: 10000 });
                    return true;
                }
            } catch (e) {
                // Ignore timeout for single selector, try next
            }
        }

        throw new Error('Unable to find "Code" button or alternatives (Smart Click Failed)');
    }

    /**
     * Helper: Load and configure build.js script content
     * Applies environment-specific configurations (TARGET_DOMAIN, WS_PORT, LOG_LEVEL)
     * @returns {string} Configured build.js script content
     */
    _loadAndConfigureBuildScript() {
        let buildScriptContent = fs.readFileSync(
            path.join(__dirname, "..", "..", "scripts", "client", "build.js"),
            "utf-8"
        );

        if (process.env.TARGET_DOMAIN) {
            const lines = buildScriptContent.split("\n");
            let domainReplaced = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes("this.targetDomain =")) {
                    this.logger.info(`[Config] Found targetDomain line: ${lines[i]}`);
                    lines[i] = `        this.targetDomain = "${process.env.TARGET_DOMAIN}";`;
                    this.logger.info(`[Config] Replaced with: ${lines[i]}`);
                    domainReplaced = true;
                    break;
                }
            }
            if (domainReplaced) {
                buildScriptContent = lines.join("\n");
            } else {
                this.logger.warn("[Config] Failed to find targetDomain line in build.js, ignoring.");
            }
        }

        if (process.env.WS_PORT) {
            const lines = buildScriptContent.split("\n");
            let portReplaced = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('constructor(endpoint = "ws://127.0.0.1:9998")')) {
                    this.logger.info(`[Config] Found port config line: ${lines[i]}`);
                    lines[i] = `    constructor(endpoint = "ws://127.0.0.1:${process.env.WS_PORT}") {`;
                    this.logger.info(`[Config] Replaced with: ${lines[i]}`);
                    portReplaced = true;
                    break;
                }
            }
            if (portReplaced) {
                buildScriptContent = lines.join("\n");
            } else {
                this.logger.warn("[Config] Failed to find port config line in build.js, using default.");
            }
        }

        // Inject LOG_LEVEL configuration into build.js
        // Read from LoggingService.currentLevel instead of environment variable
        // This ensures runtime log level changes are respected when browser restarts
        const LoggingService = require("../utils/LoggingService");
        const currentLogLevel = LoggingService.currentLevel; // 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR
        const currentLogLevelName = LoggingService.getLevel(); // "DEBUG", "INFO", etc.

        if (currentLogLevel !== 1) {
            const lines = buildScriptContent.split("\n");
            let levelReplaced = false;
            for (let i = 0; i < lines.length; i++) {
                // Match "currentLevel: <number>," pattern, ignoring comments
                // This is more robust than looking for specific comments like "// Default: INFO"
                if (/^\s*currentLevel:\s*\d+/.test(lines[i])) {
                    this.logger.info(`[Config] Found LOG_LEVEL config line: ${lines[i]}`);
                    lines[i] = `    currentLevel: ${currentLogLevel}, // Injected: ${currentLogLevelName}`;
                    this.logger.info(`[Config] Replaced with: ${lines[i]}`);
                    levelReplaced = true;
                    break;
                }
            }
            if (levelReplaced) {
                buildScriptContent = lines.join("\n");
            } else {
                this.logger.warn("[Config] Failed to find LOG_LEVEL config line in build.js, using default INFO.");
            }
        }

        return buildScriptContent;
    }

    /**
     * Helper: Inject script into editor and activate
     * Contains the common UI interaction logic for both launchOrSwitchContext and attemptLightweightReconnect
     * @param {string} buildScriptContent - The script content to inject
     * @param {string} logPrefix - Log prefix for step messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _injectScriptToEditor(buildScriptContent, logPrefix = "[Browser]") {
        this.logger.info(`${logPrefix} Preparing UI interaction, forcefully removing all possible overlay layers...`);
        /* eslint-disable no-undef */
        await this.page.evaluate(() => {
            const overlays = document.querySelectorAll("div.cdk-overlay-backdrop");
            if (overlays.length > 0) {
                console.log(`[ProxyClient] (Internal JS) Found and removed ${overlays.length} overlay layers.`);
                overlays.forEach(el => el.remove());
            }
        });
        /* eslint-enable no-undef */

        // Step 1: Open Code Editor
        this.logger.info(`${logPrefix} (Step 1/5) Preparing to click "Code" button...`);
        const maxTimes = 15;
        for (let i = 1; i <= maxTimes; i++) {
            try {
                this.logger.info(`  [Attempt ${i}/${maxTimes}] Cleaning overlay layers and clicking...`);
                await this.page.evaluate(() =>
                    // eslint-disable-next-line no-undef
                    document.querySelectorAll("div.cdk-overlay-backdrop").forEach(el => el.remove())
                );
                await this.page.waitForTimeout(500);

                await this._smartClickCode(this.page);
                this.logger.info("  ✅ Click successful!");
                break;
            } catch (error) {
                this.logger.warn(`  [Attempt ${i}/${maxTimes}] Click failed: ${error.message.split("\n")[0]}`);
                if (i === maxTimes) throw new Error(`Unable to click "Code" button after multiple attempts.`);
            }
        }

        this.logger.info(`${logPrefix} (Step 2/5) Waiting for editor to become visible...`);
        const editorContainerLocator = this.page.locator("div.monaco-editor").first();
        await editorContainerLocator.waitFor({ state: "visible", timeout: 60000 });

        // Step 2: Paste Script
        // This act of pasting serves as the "Edit" that triggers the Save button visibility
        this.logger.info(`${logPrefix} (Step 3/5) Editor displayed, focusing and pasting script...`);
        await editorContainerLocator.click({ timeout: 30000 });

        // eslint-disable-next-line no-undef
        await this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent);
        const isMac = os.platform() === "darwin";
        const pasteKey = isMac ? "Meta+V" : "Control+V";
        await this.page.keyboard.press(pasteKey);
        this.logger.info(`${logPrefix} (Step 4/5) Script pasted.`);

        // Step 3: Auto-Save (Conditional)
        const currentUrl = this.page.url();
        const shouldSave = !currentUrl.includes("/drive/");

        if (shouldSave) {
            this.logger.info(
                `${logPrefix} 💾 Current workspace is temporary. Initiating Auto-Save sequence (triggered by script paste)...`
            );
            // We pass 'false' to skip the dummy edit, since we just pasted the real content
            await this._performAppSaveSequence(logPrefix, false);

            this.logger.info(`${logPrefix} 🔄 Save completed (URL changed). Waiting for environment stabilization...`);
            // After URL change/reload, we generally expect the editor to still contain our script (loaded from server)
            // But we should ensure the UI is ready for the Preview click
            await this.page.waitForTimeout(3000);
        }

        // Step 4: Click Preview
        this.logger.info(`${logPrefix} (Step 5/5) Clicking "Preview" button to activate script...`);
        // We might need to handle overlays again if page reloaded
        await this.page.evaluate(() =>
            // eslint-disable-next-line no-undef
            document.querySelectorAll("div.cdk-overlay-backdrop").forEach(el => el.remove())
        );

        await this.page.locator('button:text("Preview")').click();
        this.logger.info(`${logPrefix} ✅ UI interaction complete, script is now running.`);

        // Active Trigger
        try {
            await this.page.evaluate(async () => {
                try {
                    await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger", {
                        headers: { "Content-Type": "application/json" },
                        method: "GET",
                    });
                } catch (e) {
                    console.log("[ProxyClient] Active trigger sent");
                }
            });
        } catch (e) {
            /* empty */
        }

        this._startHealthMonitor();
    }

    /**
     * Feature: Automate "Save App" Sequence
     * Renovated based on user request to persist the workspace.
     */
    async _performAppSaveSequence(logPrefix, triggerEdit = true) {
        try {
            this.logger.info(`${logPrefix} [AutoSave] Looking for "Save" button...`);

            if (triggerEdit) {
                // [Fix] Trigger "Unsaved" state by switching to Code view and making a small edit
                try {
                    this.logger.info(`${logPrefix} [AutoSave] Switching to Code view to trigger edit state...`);
                    await this._smartClickCode(this.page);

                    // Wait for editor to be ready
                    const editorLocator = this.page.locator("div.monaco-editor").first();
                    await editorLocator.waitFor({ state: "visible", timeout: 10000 });
                    await editorLocator.click();

                    this.logger.info(`${logPrefix} [AutoSave] Typing initialization comment...`);
                    await this.page.keyboard.type("// Init Save");
                    await this.page.waitForTimeout(2000); // Wait for Save button to appear
                } catch (e) {
                    this.logger.warn(`${logPrefix} [AutoSave] Failed to trigger code edit: ${e.message}.`);
                }
            } else {
                this.logger.info(
                    `${logPrefix} [AutoSave] Skipping explicit edit trigger (content already assumed pasted).`
                );
            }

            // Increased wait time to 5s based on debug findings
            await this.page.waitForTimeout(3000);

            // Selectors confirmed by debugging
            const saveButtonSelectors = [
                'button[aria-label="Save app"]', // Priority 1: Confirmed working
                'button[aria-label="Save"]', // Fallback
                'button:has(mat-icon:text("save"))',
                'button:has(span:text("save"))',
                'span.material-symbols-outlined:text("save")',
                'span:text-is("save")',
            ];

            let saveBtn = null;

            // Attempt 1: Normal View
            for (const sel of saveButtonSelectors) {
                try {
                    const el = this.page.locator(sel).first();
                    if ((await el.count()) > 0 && (await el.isVisible())) {
                        saveBtn = el;
                        this.logger.info(
                            `${logPrefix} [AutoSave] ✅ Found Save button (Attempt 1 - Normal) with selector: ${sel}`
                        );
                        break;
                    }
                } catch (e) {
                    /* ignore */
                }
            }

            // Attempt 2: Zoom out & Scroll (Fallback for small screens/off-screen)
            if (!saveBtn) {
                this.logger.info(
                    `${logPrefix} [AutoSave] Button not found in normal view. Attempting zoom & scroll adjustment...`
                );
                await this.page.evaluate(() => {
                    // eslint-disable-next-line no-undef
                    document.body.style.zoom = "0.8"; // Zoom out to 80%
                    // eslint-disable-next-line no-undef
                    window.scrollTo(document.body.scrollWidth, 0); // Scroll to top-right
                });
                await this.page.waitForTimeout(1000);

                for (const sel of saveButtonSelectors) {
                    try {
                        const el = this.page.locator(sel).first();
                        if ((await el.count()) > 0 && (await el.isVisible())) {
                            saveBtn = el;
                            this.logger.info(
                                `${logPrefix} [AutoSave] ✅ Found Save button (Attempt 2 - Zoomed) with selector: ${sel}`
                            );
                            break;
                        }
                    } catch (e) {
                        /* ignore */
                    }
                }
            }

            if (!saveBtn) {
                this.logger.warn(`${logPrefix} [AutoSave] ❌ Could not find Save button after all attempts.`);

                // [Diagnostic] Dump all visible buttons to logs to analyze why we missed it
                try {
                    const pageUrl = this.page.url();
                    const pageTitle = await this.page.title();
                    this.logger.info(`${logPrefix} [Debug] Page URL: ${pageUrl}, Title: ${pageTitle}`);

                    const buttons = await this.page.evaluate(
                        () =>
                            Array.from(
                                // eslint-disable-next-line no-undef
                                document.querySelectorAll('button, span[role="button"], div[role="button"], mat-icon')
                            )
                                .map(b => {
                                    const text = b.innerText?.trim().substring(0, 30) || ""; // Truncate
                                    const label = b.getAttribute("aria-label") || "";
                                    const visible = b.offsetWidth > 0 && b.offsetHeight > 0;
                                    if (!visible) return null;
                                    return `[${b.tagName}] Text:"${text}" Label:"${label}"`;
                                })
                                .filter(Boolean)
                                .slice(0, 50) // Limit output
                    );
                    this.logger.info(`${logPrefix} [Debug] Visible elements candidates:\n${buttons.join("\n")}`);
                } catch (e) {
                    this.logger.warn(`${logPrefix} [Debug] Failed to dump elements: ${e.message}`);
                }

                return; // Stop execution if button not found
            } else {
                await saveBtn.click();
            }

            this.logger.info(`${logPrefix} [AutoSave] Clicked Save button. Waiting for dialog...`);

            // Wait for "Rename app" dialog
            // Based on user screenshot: Title "Rename app", Inputs "Name", "Description"
            await this.page.waitForSelector('mat-dialog-container, .interaction-modal, h3:text("Rename app")', {
                timeout: 10000,
            });

            this.logger.info(`${logPrefix} [AutoSave] Dialog appeared. Filling details...`);

            // Fill Name
            // Assumption: First input is Name, Second (or textarea) is Description
            const nameInput = this.page.locator('input[type="text"]').first();
            await nameInput.fill("AIStudioToAPI");

            // Fill Description
            const descriptionInput = this.page.locator("textarea").first();
            if (await descriptionInput.isVisible()) {
                await descriptionInput.fill("https://github.com/iBUHub/AIStudioToAPI");
            } else {
                // Fallback if description is an input
                const inputs = await this.page.locator('input[type="text"]').all();
                if (inputs.length > 1) {
                    await inputs[1].fill("https://github.com/iBUHub/AIStudioToAPI");
                }
            }

            // Click Save in Dialog
            // Look for a button with text "Save" inside the dialog
            const confirmSaveBtn = this.page
                .locator('mat-dialog-container button:text("Save"), .interaction-modal button:text("Save")')
                .first();
            await confirmSaveBtn.click();

            this.logger.info(`${logPrefix} [AutoSave] Confirmed Save. Waiting for redirect (Polling URL change)...`);

            // Wait for URL to change (contain "drive")
            // [Fix] Increased timeout to 30s to handle slow network/transitions
            // waitForURL internally polls navigation events, which is efficient and accurate.
            await this.page.waitForURL(/.*\/drive\/.*/, { timeout: 30000 });

            const newUrl = this.page.url();
            this.logger.info(`${logPrefix} ✅ [AutoSave] App saved successfully! New URL: ${newUrl}`);

            // [Feature] Cache the new App ID locally
            try {
                const match = newUrl.match(/\/drive\/([^?&]+)/);
                if (match && match[1]) {
                    const newAppId = match[1];
                    const cachePath = this._getLastAppIdPath(this.currentAuthIndex);
                    // Ensure dir exists
                    const dir = path.dirname(cachePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                    fs.writeFileSync(cachePath, newAppId, "utf-8");
                    this.logger.info(`${logPrefix} [Cache] Saved App ID [${newAppId}] to local cache.`);
                }
            } catch (err) {
                this.logger.warn(`${logPrefix} [Cache] Failed to save App ID to cache: ${err.message}`);
            }
        } catch (error) {
            this.logger.warn(`${logPrefix} [AutoSave] Failed: ${error.message}. Continuing...`);
        }
    }

    /**
     * Helper: Navigate to target page and wake up the page
     * Contains the common navigation and page activation logic
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _navigateAndWakeUpPage(logPrefix = "[Browser]") {
        this.logger.info(`${logPrefix} Preparing navigation...`);

        const currentUrl = this.page.url();
        // [Feature] Native Session Restoration Check
        // If the browser restored a valid session (e.g., specific App URL), we should respect it.
        if (
            currentUrl.includes("/drive/") ||
            (currentUrl.includes("aistudio.google.com") && !currentUrl.includes("about:blank"))
        ) {
            this.logger.info(
                `${logPrefix} 📂 Native session restored! Already on valid URL: ${currentUrl}. Skipping forced navigation.`
            );
            return;
        }

        // [Feature] Prioritize Local Cache for Resume
        const targetUrl =
            "https://aistudio.google.com/u/0/apps/bundled/blank?showPreview=true&showCode=true&showAssistant=true";
        const usedCache = false;

        // Reverted TXT cache logic as per user request

        this.logger.info(`${logPrefix} Navigating to: ${targetUrl}`);
        await this.page.goto(targetUrl, {
            timeout: 180000,
            waitUntil: "domcontentloaded",
        });
        this.logger.info(`${logPrefix} Page loaded.`);

        // [Feature] Smart App Resume (Only if not using cache)
        if (!usedCache) {
            try {
                const existingAppId = await this._findExistingAppId(logPrefix);
                if (existingAppId) {
                    this.logger.info(
                        `${logPrefix} ♻️ Found existing "AIStudioToAPI" app (RPC check) (ID: ${existingAppId}). Resuming...`
                    );
                    const resumeUrl = `https://aistudio.google.com/u/0/apps/drive/${existingAppId}?showPreview=true&showCode=true&showAssistant=true`;
                    await this.page.goto(resumeUrl, {
                        timeout: 60000,
                        waitUntil: "domcontentloaded",
                    });
                    this.logger.info(`${logPrefix} ✅ Resumed existing app.`);
                } else {
                    this.logger.info(`${logPrefix} 🆕 No existing app found via RPC. Staying in blank workspace.`);
                    // Do NOT navigate to Dashboard. Just stay here.
                }
            } catch (error) {
                this.logger.warn(`${logPrefix} ⚠️ Smart Resume check failed: ${error.message}. Staying on blank page.`);
            }
        }

        // Wake up window using JS and Human Movement
        try {
            await this.page.bringToFront();

            // Get viewport size for realistic movement range
            const vp = this.page.viewportSize() || { height: 1080, width: 1920 };

            // 1. Move to a random point to simulate activity
            const randomX = Math.floor(Math.random() * (vp.width * 0.7));
            const randomY = Math.floor(Math.random() * (vp.height * 0.7));
            await this._simulateHumanMovement(this.page, randomX, randomY);

            // 2. Move to (1,1) specifically for a safe click, using human simulation
            await this._simulateHumanMovement(this.page, 1, 1);
            await this.page.mouse.down();
            await this.page.waitForTimeout(50 + Math.random() * 100);
            await this.page.mouse.up();

            this.logger.info(`${logPrefix} ✅ Executed realistic page activation (Random -> 1,1 Click).`);
        } catch (e) {
            this.logger.warn(`${logPrefix} Wakeup minor error: ${e.message}`);
        }
        await this.page.waitForTimeout(2000 + Math.random() * 2000);
    }

    /**
     * Feature: Find existing "AIStudioToAPI" app ID
     * Fetches user's recent file list via Google RPC (ListRecentApplets) using user-provided structure.
     */
    async _findExistingAppId(logPrefix) {
        this.logger.info(`${logPrefix} 🔍 Checking for existing apps (RPC: ListDriveApplets)...`);

        try {
            // 1. Get SAPISID from cookies (Node-side)
            const cookies = await this.context.cookies("https://aistudio.google.com");
            const sapisidCookie = cookies.find(c => c.name === "SAPISID");

            let authHeader = "";
            let sapisid = "";

            if (sapisidCookie) {
                sapisid = sapisidCookie.value;
                const now = Math.floor(Date.now() / 1000);
                const origin = "https://aistudio.google.com"; // Standard origin
                const payload = now + " " + sapisid + " " + origin;

                const crypto = require("crypto");
                const sha1 = crypto.createHash("sha1").update(payload).digest("hex");

                authHeader = `SAPISIDHASH ${now}_${sha1}`;
                this.logger.info(
                    `${logPrefix} [RPC] SAPISID found (masked: ${sapisid.substring(0, 5)}...), generated hash in Node: ${authHeader}`
                );
            } else {
                this.logger.warn(`${logPrefix} [RPC] ⚠️ No SAPISID cookie found! Auth header will be empty.`);
            }

            // 2. Execute Fetch in Browser
            return await this.page.evaluate(
                async ({ authHeader }) => {
                    try {
                        // Force Auth User to 0
                        const authUser = "0";

                        const response = await fetch(
                            "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListDriveApplets",
                            {
                                body: "[1000]",
                                credentials: "include",
                                headers: {
                                    Authorization: authHeader,
                                    "Content-Type": "application/json+protobuf",
                                    "x-goog-api-key": "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs",
                                    "X-Goog-AuthUser": authUser,
                                    "x-goog-ext-519733851-bin": "CAESAUwwATgEQAA=",
                                    "x-user-agent": "grpc-web-javascript/0.1",
                                },
                                method: "POST",
                            }
                        );

                        if (!response.ok) {
                            const errorText = await response.text();
                            console.warn(
                                `[ProxyClient] RPC Failed: ${response.status} ${response.statusText}`,
                                errorText
                            );
                            return null;
                        }

                        const json = await response.json();
                        // console.log("[ProxyClient] RPC Response:", json); // Verbose

                        const items = json?.[0]?.[0];
                        if (!Array.isArray(items)) {
                            console.warn("[ProxyClient] RPC response items is not an array:", json);
                            return null;
                        }

                        for (const item of items) {
                            if (!Array.isArray(item)) continue;

                            // Debug: Identify what we ARE seeing
                            const possibleNames = item.filter(f => typeof f === "string");
                            console.log(
                                `[ProxyClient] Scanning App Item. Found strings: [${possibleNames.join(", ")}]`
                            );

                            // Search for name
                            const nameIndex = item.findIndex(
                                f => typeof f === "string" && (f === "AIStudioToAPI" || f.includes("AIStudioToAPI"))
                            );

                            if (nameIndex !== -1) {
                                // Try standard path for ID
                                try {
                                    const id = item[2]?.[2]?.[0];
                                    if (typeof id === "string" && id.length > 10) return id;
                                } catch (e) {
                                    /* empty */
                                }

                                // Fallback string match
                                const potentialId = JSON.stringify(item).match(/"(1[a-zA-Z0-9_-]{20,})"/);
                                if (potentialId) return potentialId[1];
                            }
                        }
                        console.log("[ProxyClient] No matching app found in list.");
                        return null;
                    } catch (e) {
                        console.warn("[ProxyClient] Error in _findExistingAppId:", e.message);
                        return null;
                    }
                },
                { authHeader }
            );
        } catch (e) {
            this.logger.warn(`${logPrefix} [RPC] Critical error in Node logic: ${e.message}`);
            return null;
        }
    }

    /**
     * Helper: Check page status and detect various error conditions
     * Detects: cookie expiration, region restrictions, 403 errors, page load failures
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     * @throws {Error} If any error condition is detected
     */
    async _checkPageStatusAndErrors(logPrefix = "[Browser]") {
        const currentUrl = this.page.url();
        let pageTitle = "";
        try {
            pageTitle = await this.page.title();
        } catch (e) {
            this.logger.warn(`${logPrefix} Unable to get page title: ${e.message}`);
        }

        this.logger.info(`${logPrefix} [Diagnostic] URL: ${currentUrl}`);
        this.logger.info(`${logPrefix} [Diagnostic] Title: "${pageTitle}"`);

        // Check for various error conditions
        if (
            currentUrl.includes("accounts.google.com") ||
            currentUrl.includes("ServiceLogin") ||
            pageTitle.includes("Sign in") ||
            pageTitle.includes("鐧诲綍")
        ) {
            throw new Error(
                "🚨 Cookie expired/invalid! Browser was redirected to Google login page. Please re-extract storageState."
            );
        }

        if (pageTitle.includes("Available regions") || pageTitle.includes("not available")) {
            throw new Error(
                "🚨 Current IP does not support access to Google AI Studio (region restricted). Claw node may be identified as restricted region, try restarting container to get a new IP."
            );
        }

        if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
            throw new Error("🚨 403 Forbidden: Current IP reputation too low, access denied by Google risk control.");
        }

        if (currentUrl === "about:blank") {
            throw new Error("🚨 Page load failed (about:blank), possibly network timeout or browser crash.");
        }
    }

    /**
     * Helper: Handle various popups with intelligent detection
     * Uses short polling instead of long hard-coded timeouts
     * @param {string} logPrefix - Log prefix for messages (e.g., "[Browser]" or "[Reconnect]")
     */
    async _handlePopups(logPrefix = "[Browser]") {
        this.logger.info(`${logPrefix} 🔍 Starting intelligent popup detection (max 6s)...`);

        const popupConfigs = [
            {
                logFound: `${logPrefix} ✅ Found Cookie consent banner, clicking "Agree"...`,
                name: "Cookie consent",
                selector: 'button:text("Agree")',
            },
            {
                logFound: `${logPrefix} ✅ Found "Got it" popup, clicking...`,
                name: "Got it dialog",
                selector: 'div.dialog button:text("Got it")',
            },
            {
                logFound: `${logPrefix} ✅ Found onboarding tutorial popup, clicking close button...`,
                name: "Onboarding tutorial",
                selector: 'button[aria-label="Close"]',
            },
        ];

        // Polling-based detection with smart exit conditions
        // - Initial wait: give popups time to render after page load
        // - Consecutive idle tracking: exit after N consecutive iterations with no new popups
        const maxIterations = 12; // Max polling iterations
        const pollInterval = 500; // Interval between polls (ms)
        const minIterations = 6; // Min iterations (3s), ensure slow popups have time to load
        const idleThreshold = 4; // Exit after N consecutive iterations with no new popups
        const handledPopups = new Set();
        let consecutiveIdleCount = 0; // Counter for consecutive idle iterations

        for (let i = 0; i < maxIterations; i++) {
            let foundAny = false;

            for (const popup of popupConfigs) {
                if (handledPopups.has(popup.name)) continue;

                try {
                    const element = this.page.locator(popup.selector).first();
                    // Quick visibility check with very short timeout
                    if (await element.isVisible({ timeout: 200 })) {
                        this.logger.info(popup.logFound);
                        await element.click({ force: true });
                        handledPopups.add(popup.name);
                        foundAny = true;
                        // Short pause after clicking to let next popup appear
                        await this.page.waitForTimeout(800);
                    }
                } catch (error) {
                    // Element not visible or doesn't exist is expected here,
                    // but propagate clearly critical browser/page issues.
                    if (error && error.message) {
                        const msg = error.message;
                        if (
                            msg.includes("Execution context was destroyed") ||
                            msg.includes("Target page, context or browser has been closed") ||
                            msg.includes("Protocol error") ||
                            msg.includes("Navigation failed because page was closed")
                        ) {
                            throw error;
                        }
                        if (this.logger && typeof this.logger.debug === "function") {
                            this.logger.debug(
                                `${logPrefix} Ignored error while checking popup "${popup.name}": ${msg}`
                            );
                        }
                    }
                }
            }

            // Update consecutive idle counter
            if (foundAny) {
                consecutiveIdleCount = 0; // Found popup, reset counter
            } else {
                consecutiveIdleCount++;
            }

            // Exit conditions:
            // 1. Must have completed minimum iterations (ensure slow popups have time to load)
            // 2. Consecutive idle count exceeds threshold (no new popups appearing)
            if (i >= minIterations - 1 && consecutiveIdleCount >= idleThreshold) {
                this.logger.info(
                    `${logPrefix} ✅ Popup detection complete (${i + 1} iterations, ${handledPopups.size} popups handled)`
                );
                break;
            }

            if (i < maxIterations - 1) {
                await this.page.waitForTimeout(pollInterval);
            }
        }
    }

    /**
     * Feature: Background Health Monitor (The "Scavenger")
     * Periodically cleans up popups and keeps the session alive.
     */
    _startHealthMonitor() {
        // Clear existing interval if any
        if (this.healthMonitorInterval) clearInterval(this.healthMonitorInterval);

        this.logger.info("[Browser] 🧹 Background health monitor service (Scavenger) started...");

        let tickCount = 0;

        // Run every 4 seconds
        this.healthMonitorInterval = setInterval(async () => {
            const page = this.page;
            if (!page || page.isClosed()) {
                clearInterval(this.healthMonitorInterval);
                return;
            }

            tickCount++;

            try {
                // 1. Keep-Alive: Random micro-actions (30% chance)
                if (Math.random() < 0.3) {
                    try {
                        // Optimized randomness based on viewport
                        const vp = page.viewportSize() || { height: 1080, width: 1920 };

                        // Scroll
                        // eslint-disable-next-line no-undef
                        await page.evaluate(() => window.scrollBy(0, (Math.random() - 0.5) * 20));
                        // Human-like mouse jitter
                        const x = Math.floor(Math.random() * (vp.width * 0.8));
                        const y = Math.floor(Math.random() * (vp.height * 0.8));
                        await this._simulateHumanMovement(page, x, y);
                    } catch (e) {
                        /* empty */
                    }
                }

                // 2. Anti-Timeout: Click top-left corner (1,1) every ~1 minute (15 ticks)
                if (tickCount % 15 === 0) {
                    try {
                        await this._simulateHumanMovement(page, 1, 1);
                        await page.mouse.down();
                        await page.waitForTimeout(100 + Math.random() * 100);
                        await page.mouse.up();
                    } catch (e) {
                        /* empty */
                    }
                }

                // 3. Auto-Save Auth: Every ~24 hours (21600 ticks * 4s = 86400s)
                if (tickCount % 21600 === 0) {
                    if (this._currentAuthIndex >= 0) {
                        try {
                            this.logger.info("[HealthMonitor] ✅ Triggering daily periodic auth file update...");
                            await this._updateAuthFile(this._currentAuthIndex);
                        } catch (e) {
                            this.logger.warn(`[HealthMonitor] Auth update failed: ${e.message}`);
                        }
                    }
                }

                // 4. Popup & Overlay Cleanup
                await page.evaluate(() => {
                    const blockers = [
                        "div.cdk-overlay-backdrop",
                        "div.cdk-overlay-container",
                        "div.cdk-global-overlay-wrapper",
                    ];

                    const targetTexts = ["Reload", "Retry", "Got it", "Dismiss", "Not now"];

                    // Remove passive blockers
                    blockers.forEach(selector => {
                        // eslint-disable-next-line no-undef
                        document.querySelectorAll(selector).forEach(el => el.remove());
                    });

                    // Click active buttons if visible
                    // eslint-disable-next-line no-undef
                    document.querySelectorAll("button").forEach(btn => {
                        // 妫€鏌ュ厓绱犳槸鍚﹀崰鎹┖闂达紙绠€鍗曠殑鍙鎬ф鏌ワ級
                        const rect = btn.getBoundingClientRect();
                        const isVisible = rect.width > 0 && rect.height > 0;

                        if (isVisible) {
                            const text = (btn.innerText || "").trim();
                            const ariaLabel = btn.getAttribute("aria-label");

                            // 鍖归厤鏂囨湰 鎴?aria-label
                            if (targetTexts.includes(text) || ariaLabel === "Close") {
                                console.log(`[ProxyClient] HealthMonitor clicking: ${text || "Close Button"}`);
                                btn.click();
                            }
                        }
                    });
                });
            } catch (err) {
                // Silent catch to prevent log spamming on navigation
            }
        }, 4000);
    }

    /**
     * Helper: Save debug information (screenshot and HTML) to root directory
     */
    async _saveDebugArtifacts(suffix = "final") {
        if (!this.page || this.page.isClosed()) return;
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
            const screenshotPath = path.join(process.cwd(), `debug_screenshot_${suffix}_${timestamp}.png`);
            await this.page.screenshot({
                fullPage: true,
                path: screenshotPath,
            });
            this.logger.info(`[Debug] Failure screenshot saved to: ${screenshotPath}`);

            const htmlPath = path.join(process.cwd(), `debug_page_source_${suffix}_${timestamp}.html`);
            const htmlContent = await this.page.content();
            fs.writeFileSync(htmlPath, htmlContent);
            this.logger.info(`[Debug] Failure page source saved to: ${htmlPath}`);
        } catch (e) {
            this.logger.error(`[Debug] Failed to save debug artifacts: ${e.message}`);
        }
    }

    /**
     * Feature: Background Wakeup & "Launch" Button Handler
     * Specifically handles the "Rocket/Launch" button which blocks model loading.
     */
    async _startBackgroundWakeup() {
        const currentPage = this.page;
        // Initial buffer
        await new Promise(r => setTimeout(r, 1500));

        if (!currentPage || currentPage.isClosed() || this.page !== currentPage) return;

        this.logger.info("[Browser] 🧹 Background Wakeup Service (Rocket Handler) started...");

        while (currentPage && !currentPage.isClosed() && this.page === currentPage) {
            try {
                // 1. Force page wake-up
                await currentPage.bringToFront().catch(() => {});

                // Micro-movements to trigger rendering frames in headless mode
                const vp = currentPage.viewportSize() || { height: 1080, width: 1920 };
                const moveX = Math.floor(Math.random() * (vp.width * 0.3));
                const moveY = Math.floor(Math.random() * (vp.height * 0.3));
                await this._simulateHumanMovement(currentPage, moveX, moveY);

                // 2. Intelligent Scan for "Launch" or "Rocket" button
                const targetInfo = await currentPage.evaluate(() => {
                    // Optimized precise check
                    try {
                        const preciseCandidates = Array.from(
                            // eslint-disable-next-line no-undef
                            document.querySelectorAll(".interaction-modal p, .interaction-modal button")
                        );
                        for (const el of preciseCandidates) {
                            if (/Launch|rocket_launch/i.test((el.innerText || "").trim())) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) {
                                    return {
                                        found: true,
                                        tagName: el.tagName,
                                        text: (el.innerText || "").trim().substring(0, 15),
                                        x: rect.left + rect.width / 2,
                                        y: rect.top + rect.height / 2,
                                    };
                                }
                            }
                        }
                    } catch (e) {
                        /* empty */
                    }

                    const MIN_Y = 400;
                    const MAX_Y = 800;

                    const isValid = rect => rect.width > 0 && rect.height > 0 && rect.top > MIN_Y && rect.top < MAX_Y;

                    // eslint-disable-next-line no-undef
                    const candidates = Array.from(document.querySelectorAll("button, span, div, a, i"));

                    for (const el of candidates) {
                        const text = (el.innerText || "").trim();
                        // Match "Launch" or material icon "rocket_launch"
                        if (!/Launch|rocket_launch/i.test(text)) continue;

                        let targetEl = el;
                        let rect = targetEl.getBoundingClientRect();

                        // Recursive parent check (up to 3 levels)
                        let parentDepth = 0;
                        while (parentDepth < 3 && targetEl.parentElement) {
                            if (targetEl.tagName === "BUTTON" || targetEl.getAttribute("role") === "button") break;
                            const parent = targetEl.parentElement;
                            const pRect = parent.getBoundingClientRect();
                            if (isValid(pRect)) {
                                targetEl = parent;
                                rect = pRect;
                            }
                            parentDepth++;
                        }

                        if (isValid(rect)) {
                            return {
                                found: true,
                                tagName: targetEl.tagName,
                                text: text.substring(0, 15),
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                            };
                        }
                    }
                    return { found: false };
                });

                // 3. Execute Click if found
                if (targetInfo.found) {
                    this.logger.info(`[Browser] 🎯 Found Rocket/Launch button [${targetInfo.tagName}], engaging...`);

                    // Physical Click
                    await currentPage.mouse.move(targetInfo.x, targetInfo.y, { steps: 5 });
                    await new Promise(r => setTimeout(r, 300));
                    await currentPage.mouse.down();
                    await new Promise(r => setTimeout(r, 400));
                    await currentPage.mouse.up();

                    this.logger.info(`[Browser] 🖱️ Physical click executed. Verifying...`);
                    await new Promise(r => setTimeout(r, 1500));

                    // Strategy B: JS Click (Fallback)
                    const isStillThere = await currentPage.evaluate(() => {
                        // eslint-disable-next-line no-undef
                        const els = Array.from(document.querySelectorAll('button, span, div[role="button"]'));
                        return els.some(el => {
                            const r = el.getBoundingClientRect();
                            return (
                                /Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800 && r.height > 0
                            );
                        });
                    });

                    if (isStillThere) {
                        this.logger.warn(`[Browser] ⚠️ Physical click ineffective, attempting JS force click...`);
                        await currentPage.evaluate(() => {
                            const candidates = Array.from(
                                // eslint-disable-next-line no-undef
                                document.querySelectorAll('button, span, div[role="button"]')
                            );
                            for (const el of candidates) {
                                const r = el.getBoundingClientRect();
                                if (/Launch|rocket_launch/i.test(el.innerText) && r.top > 400 && r.top < 800) {
                                    (el.closest("button") || el).click();
                                    return true;
                                }
                            }
                        });
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        this.logger.info(`[Browser] ✅ Click successful, button disappeared.`);
                        await new Promise(r => setTimeout(r, 60000)); // Long sleep on success
                    }
                } else {
                    this.noButtonCount++;
                    // Smart Sleep
                    if (this.noButtonCount > 20) {
                        // Long sleep, but check for user activity
                        for (let i = 0; i < 30; i++) {
                            if (this.noButtonCount === 0) break; // Woken up by request
                            await new Promise(r => setTimeout(r, 1000));
                        }
                    } else {
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            } catch (e) {
                // Ignore errors during page navigation/reload
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    async launchBrowserForVNC(extraArgs = {}) {
        this.logger.info("🚀 [VNC] Launching a new, separate, headful browser instance for VNC session...");
        if (!fs.existsSync(this.browserExecutablePath)) {
            throw new Error(`Browser executable not found at path: ${this.browserExecutablePath}`);
        }

        // This browser instance is temporary and specific to the VNC session.
        // It does NOT affect the main `this.browser` used for the API proxy.
        const vncBrowser = await firefox.launch({
            args: this.launchArgs,
            // Must be false for VNC to be visible.
            env: {
                ...process.env,
                ...extraArgs.env,
            },
            executablePath: this.browserExecutablePath,
            firefoxUserPrefs: this.firefoxUserPrefs,
            headless: false,
        });

        vncBrowser.on("disconnected", () => {
            this.logger.warn("⚠️ [VNC] The temporary VNC browser instance has been disconnected.");
        });

        this.logger.info("✅ [VNC] Temporary VNC browser instance launched successfully.");

        let contextOptions = {};
        if (extraArgs.isMobile) {
            this.logger.info("[VNC] Mobile device detected. Applying mobile user-agent, viewport, and touch events.");
            const mobileDevice = devices["Pixel 5"];
            contextOptions = {
                hasTouch: mobileDevice.hasTouch,
                userAgent: mobileDevice.userAgent,
                viewport: { height: 915, width: 412 }, // Set a specific portrait viewport
            };
        }

        const context = await vncBrowser.newContext(contextOptions);
        this.logger.info("✅ [VNC] VNC browser context successfully created.");

        // Return both the browser and context so the caller can manage their lifecycle.
        return { browser: vncBrowser, context };
    }

    async _launchPersistentContextForAccount(authIndex, contextOptions, storageStateObject, useCache) {
        if (!fs.existsSync(this.browserExecutablePath)) {
            this._currentAuthIndex = -1;
            throw new Error(`Browser executable not found at path: ${this.browserExecutablePath}`);
        }

        const cacheDir = this._getAccountCacheDir(authIndex);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const launchOptions = {
            args: this.launchArgs,
            executablePath: this.browserExecutablePath,
            firefoxUserPrefs: this.firefoxUserPrefs,
            headless: false, // Main browser is always headless
            ...contextOptions,
        };

        if (!useCache && storageStateObject) {
            launchOptions.storageState = storageStateObject;
        }

        this.context = await firefox.launchPersistentContext(cacheDir, launchOptions);
        this.browser = this.context.browser();

        let pages = this.context.pages();
        this.logger.info(
            `[Browser] Initial pages check: ${pages.length} pages found. URLs: ${pages.map(p => p.url()).join(", ")}`
        );

        // [Fix] Wait for SESSION RESTORE to complete.
        // Firefox opens 'about:blank' immediately, so existing check (pages.length === 0) was exiting too early.
        // We now wait until we see a NON-BLANK page or timeout.
        let usefulPageFound = false;
        for (let i = 0; i < 50; i++) {
            pages = this.context.pages();
            if (pages.some(p => !p.url().includes("about:blank"))) {
                // eslint-disable-next-line no-unused-vars
                usefulPageFound = true;
                break;
            }
            await new Promise(r => setTimeout(r, 200));
        }

        this.logger.info(`[Browser] Post-wait pages check: ${pages.length} pages found.`);
        if (pages.length > 0) {
            // [Fix] Prioritize non-blank pages
            const usefulPage = pages.find(p => !p.url().includes("about:blank")) || pages[0];
            this.page = usefulPage;

            const restoredUrl = this.page.url();
            this.logger.info(`[Browser] ♻️ Claimed page. URL: ${restoredUrl} (Total tabs: ${pages.length})`);

            if (pages.length > 1 || (pages.length === 1 && !restoredUrl.includes("about:blank"))) {
                this.logger.info(`[Browser] ✅ Successfully latched onto restored session tab.`);
            } else {
                this.logger.info(`[Browser] ⚠️ Only about:blank found. Session restore might be slow or empty.`);
            }

            if (pages.length > 1) {
                const urls = pages.map(p => p.url()).join(", ");
                this.logger.info(`[Browser] All open tabs: [${urls}]`);
            }
        } else {
            this.logger.info(`[Browser] No pages found, creating new page.`);
            this.page = await this.context.newPage();
        }

        this.currentContextOptions = contextOptions;

        // [Fix] Manually seed storage state if it was ignored or if this is a fresh cache.
        // Playwright's launchPersistentContext sometimes ignores storageState in launchOptions
        // or fails to persist it immediately to the fresh profile.
        if (!useCache && storageStateObject) {
            this.logger.info(
                "[Browser] ⚡ Manually seeding connection state (Cookies/Origins) into fresh persistent context..."
            );
            try {
                if (storageStateObject.cookies) {
                    await this.context.addCookies(storageStateObject.cookies);
                }
                if (storageStateObject.origins) {
                    await this.context.addInitScript(() => {
                        // eslint-disable-next-line no-undef
                        if (window.location.hostname === "about:blank") return; // Init script runs before navigation
                        // We can't easily inject local storage here without a page,
                        // but Playwright's storageState usually handles cookies well.
                        // Let's rely on cookies first, as they are the primary auth mechanism.
                    }, storageStateObject);
                }
                this.logger.info("[Browser] ✅ Manual seeding complete.");
            } catch (err) {
                this.logger.warn(`[Browser] Manual seeding warning: ${err.message}`);
            }
        }

        this.browser.on("disconnected", () => {
            if (this.isClosingIntentionally) {
                this.logger.info("[Browser] Main browser disconnected (intentional).");
            } else {
                this.logger.error("❌ [Browser] Main browser unexpectedly disconnected!");
                this.logger.warn("[Browser] Reset currentAuthIndex to -1 due to unexpected disconnect.");
            }

            this.browser = null;
            this.context = null;
            this.page = null;
            this.currentContextOptions = null;
            this._currentAuthIndex = -1;
        });
    }

    async launchOrSwitchContext(authIndex) {
        if (typeof authIndex !== "number" || authIndex < 0) {
            this.logger.error(`[Browser] Invalid authIndex: ${authIndex}. authIndex must be >= 0.`);
            this._currentAuthIndex = -1;
            throw new Error(`Invalid authIndex: ${authIndex}. Must be >= 0.`);
        }

        // [Auth Switch] Save current auth data before switching
        if (this.browser && this._currentAuthIndex >= 0) {
            try {
                await this._updateAuthFile(this._currentAuthIndex);
            } catch (e) {
                this.logger.warn(`[Browser] Failed to save current auth during switch: ${e.message}`);
            }
        }

        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            this.healthMonitorInterval = null;
            this.logger.info("[Browser] Stopped background tasks (Scavenger) for old page.");
        }

        if (this.browser || this.context) {
            this.logger.info("[Browser] Closing old API browser context...");
            await this.closeBrowser();
        }

        const storageStateObject = this.authSource.getAuth(authIndex);
        if (!storageStateObject) {
            throw new Error(`Failed to get or parse auth source for index ${authIndex}.`);
        }

        const { cacheMeta, contextOptions } = this._resolveContextOptions(authIndex);
        const hasCache = !!cacheMeta;

        const buildScriptContent = this._loadAndConfigureBuildScript();

        const attemptInit = async ({ useCache, clearCache }) => {
            if (clearCache) {
                this._clearAccountCache(authIndex);
            }

            const sourceDescription = useCache ? `Cache auth-${authIndex}` : `File auth-${authIndex}.json`;
            this.logger.info("==================================================");
            this.logger.info(`🔄 [Browser] Creating new API browser context for account #${authIndex}`);
            this.logger.info(`   • Auth source: ${sourceDescription}`);
            this.logger.info("==================================================");

            if (useCache) {
                this.logger.info(`[Cache] Using cached profile for account #${authIndex}.`);
            } else {
                this.logger.info(`[Cache] Seeding profile from auth file for account #${authIndex}.`);
            }

            await this._launchPersistentContextForAccount(authIndex, contextOptions, storageStateObject, useCache);

            // Inject Privacy Script immediately after context creation
            const privacyScript = this._getPrivacyProtectionScript(authIndex);
            await this.context.addInitScript(privacyScript);

            // [Fix] Do NOT open a new page if one was already captured/restored by _launchPersistentContextForAccount
            if (!this.page || this.page.isClosed()) {
                this.page = await this.context.newPage();
            }

            // Pure JS Wakeup (Focus & Click)
            try {
                await this.page.bringToFront();
                // eslint-disable-next-line no-undef
                await this.page.evaluate(() => window.focus());
                // Get viewport size for realistic movement range
                const vp = this.page.viewportSize() || { height: 1080, width: 1920 };
                const startX = Math.floor(Math.random() * (vp.width * 0.5));
                const startY = Math.floor(Math.random() * (vp.height * 0.5));
                await this._simulateHumanMovement(this.page, startX, startY);
                await this.page.mouse.down();
                await this.page.waitForTimeout(100);
                await this.page.mouse.up();
                this.logger.info("[Browser] ⚡ Forced window wake-up via JS focus.");
            } catch (e) {
                this.logger.warn(`[Browser] Wakeup minor error: ${e.message}`);
            }

            this.page.on("console", msg => {
                const msgText = msg.text();
                if (msgText.includes("Content-Security-Policy")) {
                    return;
                }

                if (msgText.includes("[ProxyClient]")) {
                    this.logger.info(`[Browser] ${msgText.replace("[ProxyClient] ", "")}`);
                } else if (msg.type() === "error") {
                    this.logger.error(`[Browser Page Error] ${msgText}`);
                }
            });

            await this._navigateAndWakeUpPage("[Browser]");

            // Check for cookie expiration, region restrictions, and other errors
            await this._checkPageStatusAndErrors("[Browser]");

            // Handle various popups (Cookie consent, Got it, Onboarding, etc.)
            await this._handlePopups("[Browser]");

            await this._injectScriptToEditor(buildScriptContent, "[Browser]");

            // Start background wakeup service - only started here during initial browser launch
            this._startBackgroundWakeup();

            this._currentAuthIndex = authIndex;

            // [Auth Update] Save the refreshed cookies to the auth file immediately
            await this._updateAuthFile(authIndex);

            this.logger.info("==================================================");
            this.logger.info(`✅ [Browser] Account ${authIndex} context initialized successfully!`);
            this.logger.info("✅ [Browser] Browser client is ready.");
            this.logger.info("==================================================");
        };

        try {
            await attemptInit({ clearCache: false, useCache: hasCache });
        } catch (error) {
            if (hasCache) {
                this.logger.warn(
                    `[Cache] Cache init failed for account #${authIndex}: ${error.message}. Falling back to auth file.`
                );
                await this.closeBrowser();
                try {
                    await attemptInit({ clearCache: true, useCache: false });
                    return;
                } catch (fallbackError) {
                    this.logger.error(
                        `❌ [Browser] Account ${authIndex} context initialization failed: ${fallbackError.message}`
                    );
                    await this._saveDebugArtifacts("init_failed");
                    await this.closeBrowser();
                    this._currentAuthIndex = -1;
                    throw fallbackError;
                }
            }

            this.logger.error(`❌ [Browser] Account ${authIndex} context initialization failed: ${error.message}`);
            await this._saveDebugArtifacts("init_failed");
            await this.closeBrowser();
            this._currentAuthIndex = -1;
            throw error;
        }
    } /**
     * Lightweight Reconnect: Refreshes the page and re-injects the script
     * without restarting the entire browser instance.
     *
     * This method is called when WebSocket connection is lost but the browser
     * process is still running. It's much faster than a full browser restart.
     *
     * @returns {Promise<boolean>} true if reconnect was successful, false otherwise
     */
    async attemptLightweightReconnect() {
        // Verify browser and page are still valid
        if (!this.browser || !this.page) {
            this.logger.warn("[Reconnect] Browser or page is not available, cannot perform lightweight reconnect.");
            return false;
        }

        // Check if page is closed
        if (this.page.isClosed()) {
            this.logger.warn("[Reconnect] Page is closed, cannot perform lightweight reconnect.");
            return false;
        }

        const authIndex = this._currentAuthIndex;
        if (authIndex < 0) {
            this.logger.warn("[Reconnect] No current auth index, cannot perform lightweight reconnect.");
            return false;
        }

        this.logger.info("==================================================");
        this.logger.info(`🔄 [Reconnect] Starting lightweight reconnect for account #${authIndex}...`);
        this.logger.info("==================================================");

        // Stop existing background tasks
        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            this.healthMonitorInterval = null;
            this.logger.info("[Reconnect] Stopped background health monitor.");
        }

        try {
            // Load and configure the build.js script using the shared helper
            const buildScriptContent = this._loadAndConfigureBuildScript();

            // Navigate to target page and wake it up
            await this._navigateAndWakeUpPage("[Reconnect]");

            // Check for cookie expiration, region restrictions, and other errors
            await this._checkPageStatusAndErrors("[Reconnect]");

            // Handle various popups (Cookie consent, Got it, Onboarding, etc.)
            await this._handlePopups("[Reconnect]");

            // Use shared script injection helper with [Reconnect] log prefix
            await this._injectScriptToEditor(buildScriptContent, "[Reconnect]");

            // [Auth Update] Save the refreshed cookies to the auth file immediately
            await this._updateAuthFile(authIndex);

            this.logger.info("==================================================");
            this.logger.info(`✅ [Reconnect] Lightweight reconnect successful for account #${authIndex}!`);
            this.logger.info("==================================================");

            return true;
        } catch (error) {
            this.logger.error(`❌ [Reconnect] Lightweight reconnect failed: ${error.message}`);
            await this._saveDebugArtifacts("reconnect_failed");
            return false;
        }
    }

    /**
     * Unified cleanup method for the main browser instance.
     * Handles intervals, timeouts, and resetting all references.
     */
    async closeBrowser() {
        // Set flag to indicate intentional close - prevents ConnectionRegistry from
        // attempting lightweight reconnect when WebSocket disconnects
        this.isClosingIntentionally = true;

        if (this.healthMonitorInterval) {
            clearInterval(this.healthMonitorInterval);
            this.healthMonitorInterval = null;
        }
        if (this.browser) {
            this.logger.info("[Browser] Closing main browser instance...");
            try {
                // Give close() 5 seconds, otherwise force proceed
                await Promise.race([this.browser.close(), new Promise(resolve => setTimeout(resolve, 5000))]);
            } catch (e) {
                this.logger.warn(`[Browser] Error during close (ignored): ${e.message}`);
            }

            // Reset all references
            this.browser = null;
            this.context = null;
            this.page = null;
            this._currentAuthIndex = -1;
            this.logger.info("[Browser] Main browser instance closed, currentAuthIndex reset to -1.");
        }

        // Reset flag after close is complete
        this.isClosingIntentionally = false;
    }

    async switchAccount(newAuthIndex) {
        this.logger.info(`🔄 [Browser] Starting account switch: from ${this._currentAuthIndex} to ${newAuthIndex}`);
        await this.launchOrSwitchContext(newAuthIndex);
        this.logger.info(`✅ [Browser] Account switch completed, current account: ${this._currentAuthIndex}`);
    }
}

module.exports = BrowserManager;
