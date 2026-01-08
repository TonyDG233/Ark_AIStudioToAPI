/**
 * File: scripts/auth/setupAuth.js
 * Description: Cross-platform auth setup helper. Installs dependencies, downloads Camoufox, and runs saveAuth.js.
 *
 * Maintainers: iBenzene, bbbugg, MasakiMu319
 * Original Author: Ellinav
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const DEFAULT_CAMOUFOX_VERSION = "135.0.1-beta.24";
const GITHUB_RELEASE_TAG_PREFIX = "v";

const PROJECT_ROOT = path.join(__dirname, "..", "..");

const execOrThrow = (command, args, options) => {
    const result = spawnSync(command, args, {
        stdio: "inherit",
        ...options,
    });

    if (result.error) throw result.error;
    if (typeof result.status === "number" && result.status !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(" ")}`);
    }
};

const pathExists = p => {
    try {
        fs.accessSync(p);
        return true;
    } catch {
        return false;
    }
};

const ensureDir = dirPath => {
    if (!pathExists(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const npmCommand = () => (process.platform === "win32" ? "npm.cmd" : "npm");

const getCamoufoxInstallConfig = () => {
    const platform = process.platform;

    if (platform === "win32") {
        const dir = path.join(PROJECT_ROOT, "camoufox");
        return {
            expectedAppDirName: null,
            expectedExecutableName: "camoufox.exe",
            expectedExecutablePath: path.join(dir, "camoufox.exe"),
            installDir: dir,
            platform,
        };
    }

    if (platform === "linux") {
        const dir = path.join(PROJECT_ROOT, "camoufox-linux");
        return {
            expectedAppDirName: null,
            expectedExecutableName: "camoufox",
            expectedExecutablePath: path.join(dir, "camoufox"),
            installDir: dir,
            platform,
        };
    }

    if (platform === "darwin") {
        const dir = path.join(PROJECT_ROOT, "camoufox-macos");
        return {
            expectedAppDirName: "Camoufox.app",
            expectedExecutableName: "camoufox",
            expectedExecutablePath: path.join(dir, "Camoufox.app", "Contents", "MacOS", "camoufox"),
            installDir: dir,
            platform,
        };
    }

    throw new Error(`Unsupported operating system: ${platform}`);
};

const downloadFile = async (url, outFilePath) => {
    const maxRedirects = 10;

    const fetchOnce = (currentUrl, redirectsLeft) =>
        new Promise((resolve, reject) => {
            const request = https.get(
                currentUrl,
                {
                    headers: {
                        Accept: "*/*",
                        "User-Agent": "aistudio-to-api setup-auth",
                    },
                },
                res => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirectsLeft <= 0) {
                            reject(new Error(`Too many redirects while downloading: ${url}`));
                            return;
                        }
                        resolve(fetchOnce(res.headers.location, redirectsLeft - 1));
                        return;
                    }

                    if (res.statusCode !== 200) {
                        const chunks = [];
                        res.on("data", chunk => chunks.push(chunk));
                        res.on("end", () => {
                            const body = Buffer.concat(chunks).toString("utf-8");
                            reject(new Error(`Download failed (${res.statusCode}): ${body.slice(0, 300)}`));
                        });
                        return;
                    }

                    const fileStream = fs.createWriteStream(outFilePath);
                    res.pipe(fileStream);
                    fileStream.on("finish", () => fileStream.close(() => resolve()));
                    fileStream.on("error", err => {
                        try {
                            fs.unlinkSync(outFilePath);
                        } catch {
                            // ignore cleanup error
                        }
                        reject(err);
                    });
                }
            );
            request.on("error", reject);
        });

    await fetchOnce(url, maxRedirects);
};

const fetchJson = async url =>
    new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        Accept: "application/vnd.github+json",
                        "User-Agent": "aistudio-to-api setup-auth",
                    },
                },
                res => {
                    const chunks = [];
                    res.on("data", chunk => chunks.push(chunk));
                    res.on("end", () => {
                        const body = Buffer.concat(chunks).toString("utf-8");
                        if (res.statusCode !== 200) {
                            reject(new Error(`GitHub API request failed (${res.statusCode}): ${body.slice(0, 300)}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(body));
                        } catch (error) {
                            reject(new Error(`Failed to parse GitHub API response: ${error.message}`));
                        }
                    });
                }
            )
            .on("error", reject);
    });

const selectCamoufoxAsset = (assets, platform, arch) => {
    if (!Array.isArray(assets)) return null;

    const isZip = a => typeof a?.name === "string" && a.name.toLowerCase().endsWith(".zip");
    const nameOf = a => String(a?.name || "").toLowerCase();

    const hasAny = (name, tokens) => tokens.some(t => name.includes(t));

    const isWindows = name => hasAny(name, ["win", "windows"]);
    const isLinux = name => hasAny(name, ["lin", "linux"]);
    const isDarwin = name => hasAny(name, ["mac", "macos", "osx", "darwin"]);

    const isArm64 = name => hasAny(name, ["arm64", "aarch64"]);
    const isX64 = name => hasAny(name, ["x86_64", "x64", "amd64"]);

    const platformMatcher = name => {
        if (platform === "win32") return isWindows(name);
        if (platform === "linux") return isLinux(name);
        if (platform === "darwin") return isDarwin(name);
        return false;
    };

    const archMatcher = name => {
        if (arch === "arm64") return isArm64(name);
        if (arch === "x64") return isX64(name);
        return false;
    };

    const candidates = assets
        .filter(a => isZip(a))
        .filter(a => platformMatcher(nameOf(a)))
        .filter(a => archMatcher(nameOf(a)));

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => (b.size || 0) - (a.size || 0));
    return candidates[0];
};

const extractZip = (zipFilePath, destinationDir) => {
    if (process.platform === "win32") {
        execOrThrow(
            "powershell",
            [
                "-NoProfile",
                "-Command",
                `Expand-Archive -Path "${zipFilePath}" -DestinationPath "${destinationDir}" -Force`,
            ],
            { cwd: PROJECT_ROOT }
        );
        return;
    }

    const unzipCheck = spawnSync("unzip", ["-v"], { stdio: "ignore" });
    if (unzipCheck.error || unzipCheck.status !== 0) {
        throw new Error(
            'Missing "unzip" command. Please install it (macOS usually has it), or set CAMOUFOX_URL and extract manually.'
        );
    }

    execOrThrow("unzip", ["-q", zipFilePath, "-d", destinationDir], { cwd: PROJECT_ROOT });
};

const walkFiles = (rootDir, maxDepth, onEntry) => {
    const stack = [{ depth: 0, dir: rootDir }];
    while (stack.length > 0) {
        const current = stack.pop();
        const entries = fs.readdirSync(current.dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current.dir, entry.name);
            onEntry(fullPath, entry);
            if (entry.isDirectory() && current.depth < maxDepth) {
                stack.push({ depth: current.depth + 1, dir: fullPath });
            }
        }
    }
};

const locatePath = (rootDir, maxDepth, predicate) => {
    let found = null;
    walkFiles(rootDir, maxDepth, (fullPath, entry) => {
        if (found) return;
        if (predicate(fullPath, entry)) found = fullPath;
    });
    return found;
};

const ensureCamoufoxExecutable = async () => {
    const { installDir, expectedExecutablePath, expectedExecutableName, expectedAppDirName } =
        getCamoufoxInstallConfig();

    if (pathExists(expectedExecutablePath)) return expectedExecutablePath;

    const version = process.env.CAMOUFOX_VERSION || DEFAULT_CAMOUFOX_VERSION;
    const tag = `${GITHUB_RELEASE_TAG_PREFIX}${version}`;

    const camoufoxUrlFromEnv = process.env.CAMOUFOX_URL;
    let downloadUrl = camoufoxUrlFromEnv;

    if (!downloadUrl) {
        const apiUrl = `https://api.github.com/repos/daijro/camoufox/releases/tags/${tag}`;
        const release = await fetchJson(apiUrl);
        const asset = selectCamoufoxAsset(release?.assets, process.platform, process.arch);

        if (!asset?.browser_download_url) {
            const assetNames = Array.isArray(release?.assets) ? release.assets.map(a => a?.name).filter(Boolean) : [];
            throw new Error(
                [
                    `Unable to find a Camoufox asset for platform=${process.platform} arch=${process.arch}.`,
                    `Please set CAMOUFOX_URL to a direct download URL, or download it manually into ${path.relative(
                        PROJECT_ROOT,
                        installDir
                    )}.`,
                    assetNames.length > 0
                        ? `Available assets: ${assetNames.join(", ")}`
                        : "No assets found in release.",
                ].join("\n")
            );
        }

        downloadUrl = asset.browser_download_url;
    }

    ensureDir(installDir);

    const zipFilePath = path.join(PROJECT_ROOT, "camoufox.zip");

    console.log(`[2/4] Checking Camoufox...`);
    console.log(`Downloading Camoufox (${version})...`);
    console.log(`Download URL: ${downloadUrl}`);

    await downloadFile(downloadUrl, zipFilePath);
    console.log("Download complete.");

    console.log(`[3/4] Extracting Camoufox...`);
    extractZip(zipFilePath, installDir);

    try {
        fs.unlinkSync(zipFilePath);
    } catch {
        // ignore cleanup error
    }

    if (!pathExists(expectedExecutablePath)) {
        if (expectedAppDirName) {
            const foundApp = locatePath(
                installDir,
                4,
                (fullPath, entry) => entry.isDirectory() && entry.name === expectedAppDirName
            );
            if (foundApp) {
                const targetApp = path.join(installDir, expectedAppDirName);
                if (!pathExists(targetApp)) {
                    fs.renameSync(foundApp, targetApp);
                }
            }
        } else {
            const foundExe = locatePath(
                installDir,
                4,
                (fullPath, entry) => entry.isFile() && entry.name === expectedExecutableName
            );
            if (foundExe) {
                const targetExe = path.join(installDir, expectedExecutableName);
                if (!pathExists(targetExe)) {
                    fs.renameSync(foundExe, targetExe);
                }
            }
        }
    }

    if (!pathExists(expectedExecutablePath)) {
        throw new Error(
            [
                "Camoufox extraction completed, but the executable was not found.",
                `Expected: ${expectedExecutablePath}`,
                "Try deleting the camoufox directory and rerun setup, or set CAMOUFOX_EXECUTABLE_PATH manually.",
            ].join("\n")
        );
    }

    if (process.platform !== "win32") {
        try {
            fs.chmodSync(expectedExecutablePath, 0o755);
        } catch {
            // ignore chmod error
        }
    }

    return expectedExecutablePath;
};

const ensureNodeModules = () => {
    console.log(`[1/4] Checking Node.js dependencies...`);
    const nodeModulesDir = path.join(PROJECT_ROOT, "node_modules");
    if (pathExists(nodeModulesDir)) {
        console.log("Dependencies exist, skipping installation.");
        return;
    }
    console.log("Installing npm dependencies...");
    execOrThrow(npmCommand(), ["install"], { cwd: PROJECT_ROOT });
};

const runSaveAuth = camoufoxExecutablePath => {
    console.log(`[4/4] Starting auth save tool...`);
    console.log("");
    console.log("==========================================");
    console.log("  Please follow the prompts to login");
    console.log("==========================================");
    console.log("");

    const env = {
        ...process.env,
        CAMOUFOX_EXECUTABLE_PATH: camoufoxExecutablePath,
    };

    const result = spawnSync(process.execPath, [path.join("scripts", "auth", "saveAuth.js")], {
        cwd: PROJECT_ROOT,
        env,
        stdio: "inherit",
    });

    if (result.error) throw result.error;
    if (typeof result.status === "number" && result.status !== 0) {
        throw new Error("Auth save failed. Please check error messages above.");
    }
};

const main = async () => {
    const args = process.argv.slice(2);
    if (args.includes("-h") || args.includes("--help")) {
        console.log("Usage: npm run setup-auth");
        console.log("");
        console.log("Optional env vars:");
        console.log("  CAMOUFOX_VERSION=135.0.1-beta.24");
        console.log("  CAMOUFOX_URL=<direct zip url>");
        console.log("  CAMOUFOX_EXECUTABLE_PATH=<path to camoufox executable>");
        process.exit(0);
    }

    console.log("==========================================");
    console.log("  AI Studio To API - Auth Setup");
    console.log("==========================================");
    console.log(`OS: ${os.platform()}  Arch: ${os.arch()}`);
    console.log("");

    ensureNodeModules();

    let camoufoxExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (!camoufoxExecutablePath) {
        camoufoxExecutablePath = await ensureCamoufoxExecutable();
    }

    console.log(`Camoufox executable: ${camoufoxExecutablePath}`);

    if (process.platform === "darwin") {
        console.log("");
        console.log(
            'If the first run is blocked by Gatekeeper, please go to "System Settings -> Privacy & Security" to allow the app and try again.'
        );
    }

    runSaveAuth(camoufoxExecutablePath);

    console.log("");
    console.log("==========================================");
    console.log("  Auth setup complete!");
    console.log("==========================================");
    console.log("");
    console.log('Auth files saved to "configs/auth".');
    console.log('You can now run "npm start" to start the server.');
};

main().catch(error => {
    console.error("");
    console.error("ERROR:", error?.message || error);
    process.exit(1);
});
