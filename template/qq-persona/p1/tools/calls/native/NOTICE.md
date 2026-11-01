# Upstream attribution

`native-bridge.mjs`, `host.cjs` and `host.html` derive from ClaudiaGardner/maibot-qq-voice-call, commit `22f30c021cd3170f75af9dff66cc959a07ebda4b`, GPL-3.0-only; full license is retained in LICENSE.

Windows command 102, audio-engine rebind and the distinction between command 20050 diagnostic logs and login expiry were checked against RicterZ/maibot-qq-voice-call, commit `2c032a6d0619719d06921870e48acd92cf8a9eb0`, and its Momoi integration.

`audio-devices.cjs` is the parser from Big-Sh0t114/NachoBot, commit `b2e8e6b51b88c6cc74e0ef0313d3c8190ea20b39`, GPL-3.0; its copyright remains with the upstream contributors.

DSH modifications, 2026-10-27: Windows ESM bootstrap/config, loopback authentication, owner/private-only readiness lease, bounded initialization, no log-driven login loop, stale callback handling, native audio selection confirmation/invalidation, scoped chat integration and cleanup. Tencent QQ/AVSDK binaries are loaded from the user's installation and are not included.

v2.81: `windows_audio.py` MMDevice active-collection enumeration follows RicterZ's `bridge/windows/virtual_audio.py` at the commit above (GPL-3.0-only), adapted to read metadata in one bounded MTA thread without changing formats, visibility or defaults. The Host resolves selectors from that Windows collection and correlates 102 acknowledgments; the original 20061 list remains metadata, not the Windows selector namespace.

v2.83: The scoped Core Audio activation guard is a local implementation using documented IMMDevice interfaces and Frida 17.24.3 (wxWindows Library Licence 3.1 in its installed wheel). Its narrow routing approach was informed by the NachoBot audio_route prototype at the commit above; no QQ-build-specific upstream binary or private QQ function offsets are used. Frida and psutil wheel licenses are retained in the C-drive deployment. Silero VAD v5 (MIT) runs through existing sherpa-onnx; see docs/voice-calls.md for source, verified scope and acceptance limits.
