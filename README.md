# MonolithAR — Clash of Monoliths

A real-time **multiplayer augmented-reality arena game** that runs entirely in the
browser. Anchor a glowing battle arena onto your floor, harvest energy wisps by
physically walking into them, and fire plasma bolts at your rivals' monoliths.
Last monolith standing wins.

No app install, no accounts, no asset downloads — every mesh is procedural and
every sound is synthesized in WebAudio.

```
┌──────────────────────────────────────────────────────────────┐
│   ▲ wisps drift through the arena — walk into them for ⚡    │
│                                                              │
│        ⬒  your monolith        ⬒  rival monolith             │
│        100 HP                   64 HP                        │
│                                                              │
│   tap to fire ⦿ →→→→→→→→→→→→→→→→→→→→→→→  💥                  │
└──────────────────────────────────────────────────────────────┘
```

## How multiplayer AR works here

Every player anchors the *same* virtual arena onto their *own* floor — in their
bedroom, office, or garden. The game state lives in **arena space** (metres,
arena centre at the origin) on an authoritative Node.js server ticking at 20 Hz.
Each client transforms its camera pose into arena space and streams it up at
15 Hz, so you see your rivals as glowing avatars walking around *your* room
while they walk around theirs. No cloud anchors or shared-space calibration
required.

## Play modes

| Mode | Devices | Controls |
|------|---------|----------|
| **AR** | Android Chrome, WebXR-capable headsets | Scan floor → tap to anchor → walk around, tap to shoot, hold 🛡 to shield |
| **3D desktop** | Any browser | Click to capture mouse, `WASD` move, click/`Space` shoot, hold `F` shield |
| **3D mobile** | Any phone (incl. iPhone) | Virtual joystick, drag to look, on-screen fire/shield buttons |

All modes play in the same rooms against each other.

## Rules

- Up to **8 players** per room. Rooms are 4-letter codes — share one to play together.
- Everyone starts with **50⚡ energy** (max 100) and a **100 HP monolith** on the arena rim.
- **Wisps** spawn around the arena; walk within ~0.5 m to harvest **+15⚡**.
- **Shooting** costs 10⚡ and deals **12 damage** to monoliths.
- Hitting a rival **player** steals 15⚡ from them (you gain 8⚡).
- **Shield** (hold) makes your monolith invulnerable but burns 9⚡/s.
- Matches last **3 minutes**; alone in a room you get a practice totem to farm.
- Win by being the **last monolith standing**, or healthiest at the buzzer.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

For phones, WebXR requires a **secure context**. Easiest options:

```bash
# Option A: any HTTPS tunnel
npx ngrok http 3000          # or cloudflared, localtunnel, tailscale serve…

# Option B: Chrome port forwarding (Android)
# chrome://inspect → Port forwarding → 3000 → localhost:3000
```

Desktop 3D mode works fine on plain `http://localhost:3000`.

### Tests

```bash
npm test
```

Covers the server simulation (wisps, projectiles, damage, phases, victory) and
a full WebSocket integration round-trip with two simulated players.

## Architecture

```
shared/constants.js   protocol + game balance, imported by BOTH sides
server/index.js       Express static hosting + WebSocket rooms
server/game.js        authoritative simulation @ 20 Hz (snapshots @ 15 Hz)
public/js/main.js     client state machine / glue
public/js/world.js    Three.js scene — procedural arena, monoliths, FX
public/js/modes/ar.js WebXR: hit-test placement, tap-to-shoot, DOM overlay HUD
public/js/modes/flat.js  desktop pointer-lock & mobile joystick fallback
public/js/net.js      WebSocket client
public/js/hud.js      DOM HUD (energy/HP bars, scoreboard, kill feed)
public/js/audio.js    synthesized SFX (WebAudio, zero assets)
```

The server is authoritative: clients only send *intents* (pose, shoot, shield)
and the server simulates projectiles, collisions, energy, and phases. Snapshots
are small JSON blobs; clients interpolate remote entities and dead-reckon
projectiles between snapshots.
