import { PacketWisp } from "./index.js";
import type { WispSchema } from "./index.js";

// TEST RUN
const testSchema: WispSchema = [
  {
    name: "example-packet",
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
wisp.setSchema(testSchema);

const buffer = wisp.encode("example-packet", {
  health: 100,
  posX: 12.5,
  posY: -3.25,
  isAlive: true,
  isJumping: false,
  playerName: "angell",
});

console.log("encoded bytes:", buffer);
const decoded = wisp.decode(buffer);
console.log("decoded: ", decoded)
