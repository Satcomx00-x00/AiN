# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.14.0](https://github.com/Satcomx00-x00/AiN/compare/v0.13.0..v0.14.0) - 2026-10-27

### Features

- **npm:** Install with bun or npm, one package per platform ([#34](https://github.com/Satcomx00-x00/AiN/pull/34)) ([8f9e415](https://github.com/Satcomx00-x00/AiN/commit/8f9e415dc214433f1a02ccd130c3dba392763752))
## [0.13.0](https://github.com/Satcomx00-x00/AiN/compare/v0.12.0..v0.13.0) - 2026-10-27

### Features

- **transcript:** Write down the computer's sound as it plays ([1b91961](https://github.com/Satcomx00-x00/AiN/commit/1b9196137053f91c3122f3a85fa7e5b164131f6b))

### Bug fixes

- **transcript:** Read parec's samples with as_chunks ([872b175](https://github.com/Satcomx00-x00/AiN/commit/872b175e55db9efc3d4fce84bc33067f006a7a02))

### Refactoring

- **dictation:** Share the speech models and loopback-capable recording ([ace0198](https://github.com/Satcomx00-x00/AiN/commit/ace0198133dd5d69a64d23df8802034ee7f2243d))

### Documentation

- Describe the transcript feature ([dce8032](https://github.com/Satcomx00-x00/AiN/commit/dce8032233c5578396c6cb824fb3745306e760c8))
## [0.12.0](https://github.com/Satcomx00-x00/AiN/compare/v0.11.0..v0.12.0) - 2026-10-27

### Features

- **persona:** Install, download and test PersonaPlex from a desktop-style Settings ([#37](https://github.com/Satcomx00-x00/AiN/pull/37)) ([6399ab2](https://github.com/Satcomx00-x00/AiN/commit/6399ab20ac2322cbdcc6ae1405f59d0dcca2dc67))

### Bug fixes

- **linux:** Keep the island still on GNOME, shaping its input instead of resizing it ([9f67cf5](https://github.com/Satcomx00-x00/AiN/commit/9f67cf5b12b585d6343221b0400323fa7f2f1fad))
- **island:** Grow the open panel to fit its tab's content ([9fd30a5](https://github.com/Satcomx00-x00/AiN/commit/9fd30a53765b8ac128150a7e65658a116097d87e))
- **ci:** Expect the island's panel to grow to fit its content ([#38](https://github.com/Satcomx00-x00/AiN/pull/38)) ([0610e2e](https://github.com/Satcomx00-x00/AiN/commit/0610e2e41fbe96033c89a6863ac1b7bfbe3a809b))

### Tests

- **vmtest:** Run the app on Fedora 43/44 VMs in Proxmox ([#35](https://github.com/Satcomx00-x00/AiN/pull/35)) ([848b08a](https://github.com/Satcomx00-x00/AiN/commit/848b08adb443ce35cc2536ef13c4eeb91a357e95))
## [0.11.0](https://github.com/Satcomx00-x00/AiN/compare/v0.10.0..v0.11.0) - 2026-10-26

### Features

- **persona:** Talk with NVIDIA PersonaPlex, full duplex ([#31](https://github.com/Satcomx00-x00/AiN/pull/31)) ([3b1cc6d](https://github.com/Satcomx00-x00/AiN/commit/3b1cc6d4af231b7a2da8ebceb0910795ec30ad9b))
## [0.10.0](https://github.com/Satcomx00-x00/AiN/compare/v0.9.0..v0.10.0) - 2026-10-26

### Features

- **providers:** Global AI providers for dictation and read aloud ([#32](https://github.com/Satcomx00-x00/AiN/pull/32)) ([1513fb4](https://github.com/Satcomx00-x00/AiN/commit/1513fb4c56261c5400ad7f9514192a435fe37f10))

### CI

- Fail the rust jobs below a line coverage floor per os ([#28](https://github.com/Satcomx00-x00/AiN/pull/28)) ([08c825a](https://github.com/Satcomx00-x00/AiN/commit/08c825a60525b95bcb6b7f561222228667327825))
## [0.9.0](https://github.com/Satcomx00-x00/AiN/compare/v0.8.0..v0.9.0) - 2026-10-23

### Features

- **models:** Keep several models loaded, and larger French voices ([#29](https://github.com/Satcomx00-x00/AiN/pull/29)) ([82e8364](https://github.com/Satcomx00-x00/AiN/commit/82e8364fc454a1f9031d87fa6d42762513dde54e))
## [0.8.0](https://github.com/Satcomx00-x00/AiN/compare/v0.7.0..v0.8.0) - 2026-10-23

### Features

- **tts:** Read aloud, and test on Windows 11, Ubuntu, Fedora 44 and macOS ([#26](https://github.com/Satcomx00-x00/AiN/pull/26)) ([d232d7a](https://github.com/Satcomx00-x00/AiN/commit/d232d7a76769384b8d42e395efa3abf4ad6b2bd6))
## [0.7.0](https://github.com/Satcomx00-x00/AiN/compare/v0.6.0..v0.7.0) - 2026-10-18

### Features

- **oauth:** Sign plugins in to online accounts ([4b28ca7](https://github.com/Satcomx00-x00/AiN/commit/4b28ca73e0857f5e5d218007c4074e52bf769783))
- **plugins:** Pages of their own, taller tabs, and a sign-in that can start over ([22084f5](https://github.com/Satcomx00-x00/AiN/commit/22084f5829c433fdfbc227572fd9b9cdd14a2e48))
## [0.6.0](https://github.com/Satcomx00-x00/AiN/compare/v0.5.1..v0.6.0) - 2026-10-18

### Features

- **plugins:** Options the user fills in: secrets, colors, checked text and numbers ([2dd8699](https://github.com/Satcomx00-x00/AiN/commit/2dd8699ff93e1d59d5a0f6b7c064a4df0f95d8be))

### Bug fixes

- **preview:** Give the browser preview's island an in-memory secrets store ([129eeef](https://github.com/Satcomx00-x00/AiN/commit/129eeef7286b1ae211e3f7da7d55c715d96071a2))
## [0.5.1](https://github.com/Satcomx00-x00/AiN/compare/v0.5.0..v0.5.1) - 2026-10-17

### Bug fixes

- **island:** Place the window on GNOME Wayland ([03f4ccc](https://github.com/Satcomx00-x00/AiN/commit/03f4ccc0f49950388c65552be61ea29c1d8aa3c5))
- **island:** Stop the folded pill's window from eating clicks on Wayland ([84805a6](https://github.com/Satcomx00-x00/AiN/commit/84805a6c7097060c33b47d524c2006c4adb9a563))
- **island:** Keep the pill at the top of GNOME through XWayland ([99d6434](https://github.com/Satcomx00-x00/AiN/commit/99d643411263c4d8315010fc52de7f04b70cc9d4))
- **dictation:** Paste instead of typing with ydotool on Wayland ([a4d6374](https://github.com/Satcomx00-x00/AiN/commit/a4d637434a5c53277dbfb04b2dfdcb94c69b6c0d))
## [0.5.0](https://github.com/Satcomx00-x00/AiN/compare/v0.4.0..v0.5.0) - 2026-10-17

### Features

- **sdk:** Tell plugins how the island looks with host.appearance() ([d8e99ae](https://github.com/Satcomx00-x00/AiN/commit/d8e99ae543de1fc4c4d1e946ea6452023e310878))
- **settings:** Set a plugin's options under its switch in Plugins ([704bed4](https://github.com/Satcomx00-x00/AiN/commit/704bed4c176c1866d0618cc71109eda4aa562501))

### Documentation

- **plugins:** Explain host.appearance() and options under the switch ([3b740df](https://github.com/Satcomx00-x00/AiN/commit/3b740dff6b7585b0b7864080cee89e1e0e1ec5ee))

### CI

- **release:** Check latest.json entries that point at draft asset ids ([cd754f5](https://github.com/Satcomx00-x00/AiN/commit/cd754f5851992456ae52cdb672879f743a1ab57b))
## [0.4.0](https://github.com/Satcomx00-x00/AiN/compare/v0.3.0..v0.4.0) - 2026-10-17

### Features

- **updater:** Self-update on Windows, macOS and Linux from GitHub releases ([22e3869](https://github.com/Satcomx00-x00/AiN/commit/22e38699bab64d55867eeb1391c7f4ed429084cf))
- **settings:** Updates card in About ([d088e62](https://github.com/Satcomx00-x00/AiN/commit/d088e62a8bb3610807e4a7002e555f1d35576c68))

### Documentation

- **updater:** How updates work, set up and test ([0dc613f](https://github.com/Satcomx00-x00/AiN/commit/0dc613f2c102fa009d524603d24b49c99ddc35c8))

### Tests

- **updater:** Run the update flow against a local server ([028bf54](https://github.com/Satcomx00-x00/AiN/commit/028bf540ca9eef81a1b569b2f988bbe40bd2a828))

### CI

- **release:** Sign updates and check latest.json before publishing ([da90ccd](https://github.com/Satcomx00-x00/AiN/commit/da90ccd9e4b2e5300dc9832b1d887ebf9aadb0c2))
## [0.3.0](https://github.com/Satcomx00-x00/AiN/compare/v0.2.0..v0.3.0) - 2026-10-16

### Features

- **store:** Read the community plugin store and install from it ([67a8564](https://github.com/Satcomx00-x00/AiN/commit/67a856444a41013379c3398116c9310e1dd8979f))
- **settings:** Show the community store in Settings → Plugins ([c378916](https://github.com/Satcomx00-x00/AiN/commit/c37891655d2c76b27496eb561d36cfebd3784c03))

### Documentation

- Explain the community store and the plugin template ([f13c5f6](https://github.com/Satcomx00-x00/AiN/commit/f13c5f60382cbf4f5ef6739d300dff36a8425042))

### Tests

- **settings:** Cover installing from the community store ([0e21a06](https://github.com/Satcomx00-x00/AiN/commit/0e21a0685e9fd547f9cbc7fb32024cd264c88a77))
- **smoke:** Answer the store commands in the stand-in backend ([8adc78e](https://github.com/Satcomx00-x00/AiN/commit/8adc78e226553b1e42a8298d1cf1227ab999c0f2))

### CI

- Bump the actions group across 1 directory with 3 updates ([e65bff1](https://github.com/Satcomx00-x00/AiN/commit/e65bff1cabc9d63a57beee9a90726af48bffa84d))
## [0.2.0](https://github.com/Satcomx00-x00/AiN/compare/v0.1.2..v0.2.0) - 2026-10-16

### Features

- Run every widget on Windows, Linux and macOS ([6d34ae8](https://github.com/Satcomx00-x00/AiN/commit/6d34ae88879f82f13839ee6519e0c9f3e9b464f4))
- **island:** Pick the pill's style and size, from low profile to large ([a522132](https://github.com/Satcomx00-x00/AiN/commit/a522132cd8b7bb844502f2bd35b297d35bef8db5))
- **island:** Add the Solo, Stub and Sliver pill styles ([7bcf07f](https://github.com/Satcomx00-x00/AiN/commit/7bcf07f66059d6757b64461fbc4f4bb7ed866f63))
- **plugins:** Add an example pill style ([4b6c56a](https://github.com/Satcomx00-x00/AiN/commit/4b6c56a368fae82aea38b7ea2eac57a45e3bb355))
- [**breaking**] Rename the app to AiN ([bc07cb1](https://github.com/Satcomx00-x00/AiN/commit/bc07cb11fea9dd6d4da1c94cffa9355aaa81163b))
- **appearance:** Name the default theme AiN ([205799e](https://github.com/Satcomx00-x00/AiN/commit/205799e9373c71818b777f98de85f0cc821b8e4e))

### Bug fixes

- **media:** Build the image sniffer only where it is used ([39dc145](https://github.com/Satcomx00-x00/AiN/commit/39dc14506582b627949407835df3b23e392a14ab))

### Miscellaneous

- **preview:** Pick the pill size and style from the URL ([5fe3ef9](https://github.com/Satcomx00-x00/AiN/commit/5fe3ef98b177e5d0aa1463af32ffb9c0b2a54e66))
- Take the README's pictures with bun run screenshots ([772a0a4](https://github.com/Satcomx00-x00/AiN/commit/772a0a493b4ae47ad136cbb470e293aad3da3bea))

### Refactoring

- **sdk:** Move the glance spot into the SDK ([2cb3d46](https://github.com/Satcomx00-x00/AiN/commit/2cb3d46d490dc8d2955995cfffef0bf6c1b1870f))
- **settings:** Take the settings page's backend from one place ([18b36ce](https://github.com/Satcomx00-x00/AiN/commit/18b36cebb1599db2199cdff1c76c0136e0731392))
- Move the app to the ain folder ([a7b39f3](https://github.com/Satcomx00-x00/AiN/commit/a7b39f39b0362dd623e5738d603a34070f4827ae))

### Documentation

- Explain pill styles and sizes ([dd98e0e](https://github.com/Satcomx00-x00/AiN/commit/dd98e0e759815791bd52e6cf4ed0a3631890a188))
- List the test suites and how to run them ([c3d88c5](https://github.com/Satcomx00-x00/AiN/commit/c3d88c57b63c47ab8afd8b1762904c2790c1ae19))
- List every built-in feature with what each OS supports ([4d19428](https://github.com/Satcomx00-x00/AiN/commit/4d194280d2c9d3887e32aa2a34d4dfc92676dc0a))
- Show the pill styles, sizes and startup animation ([54b0970](https://github.com/Satcomx00-x00/AiN/commit/54b0970222a43ea3c792b9482acb1a738865baee))
- Retake the settings screenshots, which still showed the old name ([21431d0](https://github.com/Satcomx00-x00/AiN/commit/21431d07b7efffe31f28aea25896783a7ca3f817))

### Tests

- Run the island and its settings page together in integration tests ([94f052b](https://github.com/Satcomx00-x00/AiN/commit/94f052bc4acc0e258dfb0173a6e4051b90152a2a))
- Cover the clipboard, the volume mixer, layout lists and the popup windows ([1f833ec](https://github.com/Satcomx00-x00/AiN/commit/1f833ec726d51aa09f0739e8cc39c922a854370e))
- Measure coverage with test:coverage ([2f50d3d](https://github.com/Satcomx00-x00/AiN/commit/2f50d3de7a3afcb12c8492b29902d101137b2e7d))
- Add end-to-end tests in Chromium ([93299b8](https://github.com/Satcomx00-x00/AiN/commit/93299b8100f883c53034c015bd2ced9e9b540a72))
- Smoke-test each window of the production build ([0582712](https://github.com/Satcomx00-x00/AiN/commit/05827122b57d4e6c46fef5aa1703df77301fd704))
- Read the clock the same on every machine in integration tests ([11a0d50](https://github.com/Satcomx00-x00/AiN/commit/11a0d5047914c51c18d4b0f5739609526d7a647f))
- Run the browser tests in WebKit too ([970651c](https://github.com/Satcomx00-x00/AiN/commit/970651cc805932ce27a17795dde80da49fa73779))
- Keep the integration tests from timing out on a busy machine ([f8d1e66](https://github.com/Satcomx00-x00/AiN/commit/f8d1e667faaca2eb48b171107e84130651616eee))
- Watch the size animation frame by frame ([c0567c4](https://github.com/Satcomx00-x00/AiN/commit/c0567c4e0d42a5e89b2e631cc241db54b9be1d65))

### Build

- **deps:** Add Playwright and Vitest coverage for the tests ([930daff](https://github.com/Satcomx00-x00/AiN/commit/930daff3e4137ca65b77bf06489547b91108d1c0))
- Put Cargo.lock at version 0.2.0, like Cargo.toml ([47dabe1](https://github.com/Satcomx00-x00/AiN/commit/47dabe1689cd0d1a9cab969bffbf5a16143292e4))

### CI

- Run the end-to-end and smoke tests ([e30808b](https://github.com/Satcomx00-x00/AiN/commit/e30808b28e7f6a7d20bf0fa19b7a811667a8954c))
- Launch the AppImage on a virtual display ([c8a6c0e](https://github.com/Satcomx00-x00/AiN/commit/c8a6c0e2a7239651d49a4f51263ac66d8dddc496))
- **release:** Bump the ain package's version in Cargo.lock ([57de010](https://github.com/Satcomx00-x00/AiN/commit/57de0107f137a525b069402c66c3e9478535a339))
## [0.1.2](https://github.com/Satcomx00-x00/AiN/compare/v0.1.1..v0.1.2) - 2026-10-16

### CI

- **release:** Upload the builds to the release, never publish it empty ([c0c6af3](https://github.com/Satcomx00-x00/AiN/commit/c0c6af3a5e285b8750a0d70b02d4f97baa34d220))
## [0.1.1](https://github.com/Satcomx00-x00/AiN/compare/v0.1.0..v0.1.1) - 2026-10-16

### CI

- **release:** Build and publish after an automatic release ([41904e8](https://github.com/Satcomx00-x00/AiN/commit/41904e8271fba92160ec889029025bea18fc8b02))
## [0.1.0](https://github.com/Satcomx00-x00/AiN/releases/tag/v0.1.0) - 2026-10-16

### Features

- Add widget island Tauri application ([dc37ce8](https://github.com/Satcomx00-x00/AiN/commit/dc37ce83ad8d730f25c93afdd75519c5477c05d9))
- **screenshot:** Select an area first, then edit it ([3f0109a](https://github.com/Satcomx00-x00/AiN/commit/3f0109af9904458e3eb84c95b1da716052eb08f3))
- **dictation:** Local speech-to-text typed at the cursor ([8410ad7](https://github.com/Satcomx00-x00/AiN/commit/8410ad7386ad1c53a8a7922ac56cc5000b02795c))
- **settings:** Add a folder option with a system folder picker ([d1e7e30](https://github.com/Satcomx00-x00/AiN/commit/d1e7e30aff43406011011e20d9328be0923b8b5b))
- **dictation:** Choose the speech model and its folder ([4df3f01](https://github.com/Satcomx00-x00/AiN/commit/4df3f011d87f7f4ada782c5babf49fd85509d730))
- **appearance:** Customize the pill's shape, colors and theme ([dd414a3](https://github.com/Satcomx00-x00/AiN/commit/dd414a3a0817d4a258015b01f69f0542c7bc0a09))
- **dictation:** Choose and manage the speech model in Settings only ([fb36313](https://github.com/Satcomx00-x00/AiN/commit/fb36313a754eb93e268a07171e427db858bd853e))
- **app:** Quit Island from Settings or the island itself ([6f5e1c3](https://github.com/Satcomx00-x00/AiN/commit/6f5e1c37f90d3ed40063880c019b6697df717bce))
- **settings:** Show long choice lists as a drop-down ([3fdac2f](https://github.com/Satcomx00-x00/AiN/commit/3fdac2f83e37188bc3cc4425e8bfe9123eb8d773))
- **settings:** An island-styled drop-down, and the speech model picker ([a044c0c](https://github.com/Satcomx00-x00/AiN/commit/a044c0ccd40ca7875ee105035e3cd04888fd5a48))
- **dictation:** Choose the microphone; shorter Settings texts ([8f592dd](https://github.com/Satcomx00-x00/AiN/commit/8f592dd3f8334e93d98b34a2629bf07098276a50))
- **island:** The pill says hello at startup ([376fd5f](https://github.com/Satcomx00-x00/AiN/commit/376fd5fb59dd10191c3fb4602abe5f42eba35f50))
- **island:** Pluggable startup animations, with a showcase ([66859d5](https://github.com/Satcomx00-x00/AiN/commit/66859d55f97a98c25e884af2c132d7689028151b))
- **settings:** A Play button for the startup animation ([b130ede](https://github.com/Satcomx00-x00/AiN/commit/b130ededd2a8a29075f44537d08acdf00e6213cb))
- **island:** Hide the pill until the cursor rests at the top center ([3b91b10](https://github.com/Satcomx00-x00/AiN/commit/3b91b109249e6222766a2468ff469bfddc2f7113))

### Bug fixes

- Add missing Tauri library entry point ([0d1e926](https://github.com/Satcomx00-x00/AiN/commit/0d1e926e6486d6b5560ec2cd6a27e9b121641137))
- **ci:** Repair the Rust, Linux and Dependabot jobs and ship an AppImage ([#4](https://github.com/Satcomx00-x00/AiN/pull/4)) ([25d85a9](https://github.com/Satcomx00-x00/AiN/commit/25d85a920301e70b764ca6702bcb676f98a186cf))
- **backend:** Say when media and volume controls are unsupported ([003de41](https://github.com/Satcomx00-x00/AiN/commit/003de417bbaf2f5ca871b1914d59643f0f2a070a))
- **privacy:** Detect cameras on Linux ([38e203b](https://github.com/Satcomx00-x00/AiN/commit/38e203b900eeace985b027e5f088d6438c05b55e))
- **app:** The island's quit button actually quits ([4b44821](https://github.com/Satcomx00-x00/AiN/commit/4b448212e3cfb34df42ca8bb79da062cd67d9c04))

### Refactoring

- **backend:** Split shell from features and drive IPC from one manifest ([8c78550](https://github.com/Satcomx00-x00/AiN/commit/8c78550fe682bb3575fbf25075538b6af7d7df7d))
- **frontend:** Sdk, shell and features on generated bindings, with plugins ([a9fc92e](https://github.com/Satcomx00-x00/AiN/commit/a9fc92e61cf119e5df798bae3e276035a5064576))

### Documentation

- Document development, CI and release process ([8d77ce4](https://github.com/Satcomx00-x00/AiN/commit/8d77ce4164238f08b3d5c81b5d9de56495b6c4df))
- Expand the README with a showcase and screenshots ([6c1e442](https://github.com/Satcomx00-x00/AiN/commit/6c1e4421d14654ba223f7a87f783024d379abdb1))
- Architecture and plugin guide; ci: check generated bindings ([1873253](https://github.com/Satcomx00-x00/AiN/commit/1873253580e5037e4eae98c8ef3a9aaa1c7b8b82))

### Style

- Add rustfmt configuration matching the code style ([7271968](https://github.com/Satcomx00-x00/AiN/commit/7271968c21162cab03bb227ea84a3253fe95ec20))

### Tests

- **ipc:** Fail cargo test when the generated bindings were stale ([df93de4](https://github.com/Satcomx00-x00/AiN/commit/df93de4d10bdc3a8b1190d6d4e6fc3df903a32bb))

### Build

- Lint commit messages with commitlint ([ee75ecb](https://github.com/Satcomx00-x00/AiN/commit/ee75ecb1164a99424fbfd44ab743803d361f4fb5))
- Run checks as prek hooks, scoped to what changed ([d3390df](https://github.com/Satcomx00-x00/AiN/commit/d3390df3629cd0a53f172a6c60fd7ac42f5c4113))

### CI

- Add CI pipeline for frontend and x64 Rust targets ([7dd1cf5](https://github.com/Satcomx00-x00/AiN/commit/7dd1cf59844fc208fc43d4bdd4d7ddb95a7333fc))
- Add git-cliff release workflow for Windows, Linux and macOS x64 ([929380f](https://github.com/Satcomx00-x00/AiN/commit/929380f419c03fa63e50a4539d621e2b1677c07c))
- Pin third-party actions to commit SHAs ([a5641bb](https://github.com/Satcomx00-x00/AiN/commit/a5641bbf00d78979d20a1b786d744b09d9be35a4))
- Refetch sherpa-onnx libraries, run prek, and harden the workflows ([879edb8](https://github.com/Satcomx00-x00/AiN/commit/879edb85a0fd60eb67ae35ce4ece9e8ada81e966))
- **release:** Release automatically from green CI runs on main ([067a9f2](https://github.com/Satcomx00-x00/AiN/commit/067a9f237ab246622c1a1a123a26a43e8f76aa81))
- **release:** Render the changelog without calling the GitHub API ([ea5bdb4](https://github.com/Satcomx00-x00/AiN/commit/ea5bdb40b2451dac65466608b5d4bb4ce1ef8c71))

