# web2exe-tauri

> 中文文档见 [README.md](README.md)。

Turn an **existing web app** (a static site, a Vite/React/Vue build, a single HTML file)
into a Windows desktop application and installer — with a copy-ready template and the
pitfalls we actually hit, including measured data for each one.

What this repo preserves is not "a demo that runs" but **a route that has been proven in a
real project**: how to set up the environment, where the traps are, what the measurements
say, and why we chose this over the alternatives.

---

## What this route solves

| | How | The price |
|---|---|---|
| **No admin rights** | Compiler unpacked into the user profile; scripts patch `PATH` | Scripts have to own the `PATH` (the user does not) |
| **No Visual Studio** | GNU toolchain (MSYS2 + MinGW-w64) | The download path bypasses pacman's package-signature check and therefore requires explicit consent — see [SECURITY.md](SECURITY.md) |
| **Small installer** | Tauri reuses the OS-provided WebView2 instead of bundling a browser engine | Target machines need WebView2 (built into Windows 11; delivered by update on Windows 10 — LTSC/offline boxes may lack it, in which case the installer fetches it) |
| **Working auto-update** | Tauri updater + signing key + static `update.json` | The private key is a single point of trust for every installed client; losing or leaking it is unrecoverable remotely |
| **Friendly for non-terminal users** | Everything is a double-click `.bat` | `.bat` must be pure ASCII (a real trap, see below) |

Do not read the "no admin" row as an advantage over Electron: packaging Electron also needs
no elevation. The MSVC-vs-GNU choice is about the **Rust linker**, not about the framework.

Measured output (verified end-to-end, 2026-09-26):

| | Value |
|---|---|
| Full `pack.mjs` run | 121 s |
| NSIS installer | 1.8 MB (main binary 4.6 MB, uncompressed) |
| `check-installer` | 10/10 PASS |
| `smoke-test` (real install → launch → uninstall) | 11/11 PASS |

Toolchain versions those numbers are bound to live in [VERSIONS.md](VERSIONS.md); every
"measured" claim in the docs is only valid for a matching fingerprint.

---

## Quick start

### Prerequisites

| What | How to get it | Size |
|---|---|---|
| Windows 10 1803+ | Where WebView2 is provisioned by the OS or by the installer | — |
| Node.js 20+ | Official installer (`engines` is declared in `package.json`) | ~30 MB |
| Rust (GNU toolchain) | Double-click `安装Rust环境.bat`, choose **GNU** when asked; it verifies `rustup-init.exe` against the official `.sha256` before executing it | ~400 MB |
| MinGW-w64 | Either `npm run setup:msys2` + `npm run setup:mingw` (no admin, **no package-signature check**, needs `WEB2EXE_ALLOW_UNVERIFIED_TOOLCHAIN=1`), or the official MSYS2 installer + `pacman -S mingw-w64-x86_64-gcc` (needs admin, verifies signatures) | ~100 MB – 1 GB |

Everything installs into the user profile; the build needs no administrator rights.
No terminal restart is required — the build scripts patch `PATH` themselves.

### Copy the template and run

```bash
# 1. Copy the template out
cp -r template my-app && cd my-app

# 2. Install frontend dependencies
npm install
```

Then two places to edit:

1. `src-tauri/tauri.conf.json` — `productName` (use ASCII; see [docs/05 §10](docs/05-踩坑记录.md)),
   `identifier` (reverse-DNS, unique per app — it owns the data directory), window size
2. `src/` — swap in your own frontend, or leave it and point `build.frontendDist` at your own output

Now double-click, in verification order:

| File | What it does | Time |
|---|---|---|
| `启动开发版.bat` | Page in a browser with hot reload | seconds |
| `启动桌面版.bat` | Run once in a real Tauri window (debug build) | first Rust compile takes minutes |
| `打包桌面版.bat` | Installer + update signature + `update.json` | ~2–4 min warm, 5–15 min cold |

On the first packaging run the script offers to generate a signing keypair: answer `Y`.
It writes `.tauri-key` (private) and puts `.tauri-key.pub` into `tauri.conf.json` for you.
This step cannot be skipped — Tauri's updater mandates signing, so no key means no
updatable installer.

**The default key is generated with an empty password, i.e. stored unencrypted.** Anyone who
reads that file can sign an update that every installed client will install automatically.
To encrypt it:

```bat
set WEB2EXE_UPDATER_PASSWORD=your-password
```

The same value is used for generation and for every later build, so nothing becomes interactive.

Only want an installer, no updater yet? Set `bundle.createUpdaterArtifacts` to `false`, or run
`WEB2EXE_NO_SIGN=1 node scripts/pack.mjs`.

### Verify it actually opens

A green build only proves files are in the package. The one check that reaches "the user
double-clicks and it works":

```bash
npm run smoke     # silent install → launch → assert WebView2 started → uninstall → clean up
```

It installs into `%LOCALAPPDATA%` and removes everything after itself (`--keep` to leave it).

---

## Layout

```
template/
├── src-tauri/              Desktop shell (Rust)
│   ├── tauri.conf.json     ★ app name, window, bundling, update — all here
│   ├── capabilities/       Permission allowlist: nothing granted by default
│   ├── src/main.rs         Entry point (registers updater / process plugins)
│   ├── icons/              Icons generated by gen-icons.mjs
│   └── WebView2Loader.dll  Required for GNU targets; missing it breaks first launch
├── src/                    Frontend (placeholder page; replace freely)
├── scripts/                The bulk of this route
│   ├── env-check.mjs       ★ Environment self-check: what is missing, which route to take
│   ├── pack.mjs            ★ Main packaging flow (5 steps)
│   ├── build-desktop.mjs   ★ The layer that actually calls cargo/tauri
│   ├── check-installer.mjs Parses installer.nsi and verifies the real file manifest
│   ├── smoke-test.mjs      Real install / launch / uninstall verification
│   ├── mingw-locate.mjs    Single source of truth for locating MinGW
│   ├── toolchain-download.mjs  Verify when an anchor exists; require consent when it does not
│   ├── doc-lint.mjs        Ensures "see docs/05 §N" references do not dangle
│   └── *.bat               Double-click entry points — all pure ASCII thin wrappers
```

`.bat` files stay thin wrappers because **cmd.exe's batch parser cannot reliably handle
multi-byte characters**: it seeks by byte offset, so offsets drift and eventually a line gets
cut mid-character. Details in [docs/05 §1](docs/05-踩坑记录.md).

---

## Documentation

| Doc | Contents |
|---|---|
| [01 Selection](docs/01-选型-为什么是-Tauri.md) | Versus Electron / NW.js / nativefier / Node SEA, and each one's boundary |
| [02 Environment](docs/02-环境-不用管理员权限的GNU工具链.md) | Two routes, installing MSYS2 + MinGW without elevation, and what that costs |
| [03 Packaging](docs/03-打包-五步流程.md) | What each `pack.mjs` step does and where to look when it fails |
| [04 Auto-update](docs/04-自动更新-签名与-update.json.md) | Keys, signing, manifest, distribution, key backup / handover / leak response |
| [05 Pitfalls](docs/05-踩坑记录.md) | Symptom, root cause, measurement, final fix — plus a correction where an earlier claim was falsified |
| [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [VERSIONS.md](VERSIONS.md) | Trust boundaries, the gates to run before submitting, and the version fingerprint behind every measurement |

---

## Scope and limits

**Good fit**: putting a web UI into a desktop window + needing OS capability (files,
notifications, auto-update) + caring about size.

**Not a fit**:

- macOS / Linux targets — only Windows is verified here (Tauri itself is cross-platform, but
  the GNU toolchain, NSIS, `.bat` and MinGW specifics in these docs are Windows-only)
- Bundling Node native modules (`sharp`, `better-sqlite3`, …) — Electron is more direct;
  Tauri needs a sidecar or a Rust reimplementation
- Windows 7 / 8 — no WebView2

**Also not solved by this repo** (inherent costs, not script bugs):

- **Build-chain trust**: the no-admin MinGW install bypasses pacman's signature check.
  Consent is required, but consent is not verification. Hard supply-chain requirements should
  use MSYS2 + pacman, or the MSVC route.
- **Key governance**: one readable private file equals a full compromise of the update chain.
  This template targets "one developer, one machine". Multi-product or multi-person releases
  need KMS/HSM signing, which these scripts deliberately do not provide.

---

## License

MIT. `WebView2Loader.dll` in the template is a Microsoft runtime file, redistributed under
Microsoft's terms.
