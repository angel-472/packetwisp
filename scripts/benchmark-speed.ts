import { Bench } from "tinybench";
import { PacketWisp } from "../src/index";
import type { WispSchema } from "../src/index";

const schema: WispSchema = [
  {
    name: "player-state",
    fields: {
      health: "byte",
      posX: "float32",
      posY: "float32",
      isAlive: "boolean",
      isJumping: "boolean",
      playerName: "string",
    },
  },
];

const wisp = new PacketWisp();
wisp.setSchema(schema);

const player = {
  health: 100,
  posX: 12.5,
  posY: -3.25,
  isAlive: true,
  isJumping: false,
  playerName: "angel",
};

// JSON has to reach the wire as bytes too, so the fair comparison includes
// TextEncoder/TextDecoder rather than stopping at the string.
const utf8encode = new TextEncoder();
const utf8decode = new TextDecoder();

const wispBuffer = wisp.encode("player-state", player);
const jsonBytes = utf8encode.encode(JSON.stringify(player));

async function group(title: string, cases: Record<string, () => void>) {
  const bench = new Bench({ time: 500, warmupTime: 100 });
  for (const [name, fn] of Object.entries(cases)) bench.add(name, fn);
  await bench.run();

  const results = bench.tasks.map((t) => ({
    name: t.name,
    hz: t.result?.throughput.mean ?? 0,
  }));
  const max = Math.max(...results.map((r) => r.hz));
  const width = 30;

  console.log(`\n### ${title}\n`);
  for (const r of results) {
    const filled = Math.max(1, Math.round((r.hz / max) * width));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    const ops = (r.hz / 1e6).toFixed(2);
    const rel = r.hz === max ? "fastest" : `${(max / r.hz).toFixed(2)}x slower`;
    console.log(`${r.name.padEnd(30)} ${bar} ${ops.padStart(6)} M ops/s  ${rel}`);
  }
  return results;
}

async function main() {
  await group("Encode (object -> bytes)", {
    packetwisp: () => void wisp.encode("player-state", player),
    "JSON.stringify + TextEncoder": () =>
      void utf8encode.encode(JSON.stringify(player)),
  });

  await group("Decode (bytes -> object)", {
    packetwisp: () => void wisp.decode(wispBuffer),
    "TextDecoder + JSON.parse": () => void JSON.parse(utf8decode.decode(jsonBytes)),
  });

  await group("Round trip", {
    packetwisp: () => void wisp.decode(wisp.encode("player-state", player)),
    JSON: () =>
      void JSON.parse(utf8decode.decode(utf8encode.encode(JSON.stringify(player)))),
  });
}

main();
