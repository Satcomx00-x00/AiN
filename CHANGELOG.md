# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

