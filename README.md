# Class Clash 3D

Third-person 3D multiplayer King of the Hill brawler that runs in the browser. 2–8 players join from any phone or laptop with a 4-letter room code. No login, no install.

## Run it

```
npm install
npm start
```

Open http://localhost:3000. Other devices on the same Wi-Fi can join at `http://<your-computer's-IP>:3000`.

For quick testing, `ROUND_TIME=20 npm start` shortens rounds to 20 seconds.

## Live

https://class-clash-3d-production.up.railway.app (Railway). Redeploy with `railway up --service class-clash-3d --detach`.
Rooms live in server memory, so keep the service at **1 replica**: with more, players in the same room could land on different servers.

## Modes

- **Free-for-all / Teams:** King of the Hill in the colosseum (see Features).
- **Kill the King:** 8v8 on a long field (bots fill every empty spot). A 30 s draft (ends early when every human presses Ready): pick a line-up (Defenders–Midfield–Attackers, e.g. 3-3-2), take a spot, and choose a class for every bot. Each team has a slow 300 HP King with a 10 dmg short sword and an always-on aura: teammates within 5 m heal 4 HP/s, within 10 m move 20% faster. Kill theirs to win. Bot defenders cover their whole half, midfielders roam the map, attackers stay out of the back 25% of their half; humans go anywhere. Players who join mid-match take over a bot on the team with fewer humans; players who leave are replaced by a bot. Dying makes you explode ("YOU DIED"), then opens a death screen (10 s countdown, class swap, team stats, crowd vote) and you respawn on your 25% line. 5-minute rounds; if no King falls, the healthier King wins. Last 30 s = Final Frenzy: double damage, power-ups spawn 5x faster, 3 s respawns.
- **All modes:** a crowd of fans fills the stands and cheers on knockouts. Bots show "(bot)" under their names. The winning moment plays as a slow-motion finale (cinematic bars, winner banner, camera circling the fallen King or the winner) before MVP award cards and the results table. Knocked-out players (and knocked-out bots) vote where the next bonus power-up drops (every 12 s): Red side / Middle / Blue side (West / Middle / East in the colosseum). Every match gets a random pillar-and-wall layout (mirrored on the Kill the King field so it stays fair).

## Features

- 8 classes: Tank, Archer, Mage, Gladiator, Rogue, Paladin, Bomber, Lancer (each with an attack, a special and a passive; all numbers live in `shared/game.js`)
- Free-for-all or Teams: everyone starts split across Red and Blue and can switch to any of Red, Blue, Green or Gold in the lobby (no friendly fire)
- Bots fill empty seats, with Easy / Normal / Hard skill (aim wobble, reaction time, slower attacks, mistimed swings)
- King of the Hill: zone moves every 30 s with a 5 s warning; solo = 1 pt/s, contested = 0, KO = +3; 3-minute rounds, sudden death on ties
- Meteor shower in the last 45 s: red circles grow one at a time, then a meteor lands and knocks out anyone inside
- Power-ups: health bubble (+50% HP), sword (2x damage, 10 s), lightning (1.5x speed, 10 s)
- Gold star over the current leader
- Ranged attacks fly to the crosshair point (bombs arc onto it); light aim assist near enemies
- Hidden comeback boost after 3 deaths in a row without a kill (less damage taken, more dealt; fades after a kill)
- Server-authoritative: clients send inputs only; the server decides hits, HP, scores and the timer
- Client-side prediction for your own player, 100 ms interpolation for everyone else
- Laptop: WASD + mouse look (pointer lock), click = attack, E/right-click = special, Space = jump
- Phone (landscape): left joystick, drag right side to look, attack / special / jump buttons
- Invite links (`?room=CODE`) open straight into a join screen; locally they use the computer's Wi-Fi address
- Rejoin within 30 s with the same name keeps your score

## Files

- `server.js`: rooms, match loop (30 ticks/s), combat, bots
- `shared/game.js`: arena layout, class stats, movement physics (used by both server and client)
- `public/`: Three.js client (`main.js`), UI (`index.html`, `style.css`)
