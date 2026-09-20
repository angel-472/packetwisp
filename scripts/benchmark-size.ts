import { createDeflateRaw, constants } from "node:zlib";
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
const utf8 = new TextEncoder();

// deterministic PRNG so the numbers in the README are reproducible
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHORT_NAMES = ["angel", "kai", "mira", "jon", "zed", "luna", "rex"];
const LONG_NAMES = [
  "xXx_ShadowSniper_2011_xXx",
  "TheRealDragonSlayer9000",
  "ProGamerMoments_Official",
  "NotACheater_IPromise_42",
];

function makePackets(count: number, names: string[], seed = 1) {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    health: Math.floor(rnd() * 256),
    posX: Math.round((rnd() * 2000 - 1000) * 100) / 100,
    posY: Math.round((rnd() * 2000 - 1000) * 100) / 100,
    isAlive: rnd() > 0.2,
    isJumping: rnd() > 0.7,
    playerName: names[Math.floor(rnd() * names.length)]!,
  }));
}

// Simulates permessage-deflate: one shared deflate context for the whole
// connection, flushed after every message so each one is independently
// readable. This is the honest comparison -- context takeover is what lets
// repeated JSON field names compress away after the first few packets.
function deflateStream(messages: Uint8Array[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const z = createDeflateRaw({ level: constants.Z_DEFAULT_COMPRESSION });
    let total = 0;
    z.on("data", (c: Buffer) => (total += c.length));
    z.on("error", reject);
    let i = 0;
    const next = () => {
      if (i >= messages.length) {
        z.end(() => resolve(total));
        return;
      }
      z.write(Buffer.from(messages[i]!), () => {
        i++;
        z.flush(constants.Z_SYNC_FLUSH, next);
      });
    };
    next();
  });
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

async function measure(label: string, names: string[], count = 2000) {
  const packets = makePackets(count, names);

  const wispMsgs = packets.map((p) => new Uint8Array(wisp.encode("player-state", p)));
  const jsonMsgs = packets.map((p) => utf8.encode(JSON.stringify(p)));

  const rows: [string, number][] = [
    ["packetwisp", sum(wispMsgs.map((m) => m.length)) / count],
    ["packetwisp + deflate", (await deflateStream(wispMsgs)) / count],
    ["JSON", sum(jsonMsgs.map((m) => m.length)) / count],
    ["JSON + deflate", (await deflateStream(jsonMsgs)) / count],
  ];

  const max = Math.max(...rows.map(([, v]) => v));
  const width = 34;
  console.log(`\n### ${label}  (${count} varied packets, avg bytes/message)\n`);
  for (const [name, v] of rows) {
    const filled = Math.max(1, Math.round((v / max) * width));
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    console.log(`${name.padEnd(22)} ${bar} ${v.toFixed(1).padStart(6)} B`);
  }
  return Object.fromEntries(rows) as Record<string, number>;
}

async function main() {
  const short = await measure("Short names", SHORT_NAMES);
  const long = await measure("Long names", LONG_NAMES);

  // ---- bandwidth scenario -----------------------------------------------------
  const PLAYERS = 1000;
  const TICKS = 20;
  const msgs = PLAYERS * TICKS * 60 * 60 * 24 * 30;

  const fmt = (b: number) =>
    b / 1e12 >= 1 ? `${(b / 1e12).toFixed(2)} TB` : `${(b / 1e9).toFixed(0)} GB`;

  console.log(
    `\n### Bandwidth: ${PLAYERS} players x ${TICKS} ticks/sec x 30 days ` +
      `(${(msgs / 1e9).toFixed(1)}B messages, short names)\n`,
  );
  for (const key of ["packetwisp", "packetwisp + deflate", "JSON", "JSON + deflate"]) {
    const v = short[key]!;
    console.log(
      `${key.padEnd(22)} ${v.toFixed(1).padStart(6)} B/msg  ${fmt(v * msgs).padStart(8)}/month`,
    );
  }
  console.log(
    `\nvs raw JSON:        ${fmt((short["JSON"]! - short["packetwisp"]!) * msgs)}/month saved`,
  );
  console.log(
    `vs compressed JSON: ${fmt((short["JSON + deflate"]! - short["packetwisp"]!) * msgs)}/month saved`,
  );
  console.log(
    `\nratio short: ${(short["JSON"]! / short["packetwisp"]!).toFixed(2)}x raw, ` +
      `${(short["JSON + deflate"]! / short["packetwisp"]!).toFixed(2)}x deflated`,
  );
  console.log(
    `ratio long:  ${(long["JSON"]! / long["packetwisp"]!).toFixed(2)}x raw, ` +
      `${(long["JSON + deflate"]! / long["packetwisp"]!).toFixed(2)}x deflated`,
  );
}

main();
