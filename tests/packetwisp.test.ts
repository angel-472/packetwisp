import { describe, it, expect, beforeEach } from "vitest";
import { PacketWisp } from "../src/index";
import type { WispSchema } from "../src/index";

// setSchema mutates the schema objects it is given (it stamps _sizeInBytes etc.
// onto them), so build a fresh copy per test instead of sharing one module-level
// object between them.
function makeSchema(): WispSchema {
  return [
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
}

const player = {
  health: 100,
  posX: 12.5,
  posY: -3.25,
  isAlive: true,
  isJumping: false,
  playerName: "angel",
};

// Layout for "example-packet":
//   [0]      packet id
//   [1]      health        (byte)
//   [2..5]   posX          (float32, big-endian)
//   [6..9]   posY          (float32, big-endian)
//   [10]     boolean group (isAlive = bit 7, isJumping = bit 6)
//   [11..]   playerName    (UTF-8, fills the remainder)
const OFF = { id: 0, health: 1, posX: 2, posY: 6, bools: 10, string: 11 } as const;

let wisp: PacketWisp;

beforeEach(() => {
  wisp = new PacketWisp();
  wisp.setSchema(makeSchema());
});

describe("setSchema", () => {
  it("assigns a packet id per schema", () => {
    expect(wisp.getPacketIdFromName("example-packet")).toBeDefined();
  });

  it("computes the fixed-size footprint of a schema", () => {
    // 1 byte + 4 + 4 + one shared byte for the two booleans
    expect(wisp.getSchemaFromName("example-packet")?._sizeInBytes).toBe(10);
  });

  it("records the string field", () => {
    expect(wisp.getSchemaFromName("example-packet")?._stringFieldName).toBe("playerName");
  });
});

describe("encode", () => {
  it("throws on an unknown schema name", () => {
    expect(() => wisp.encode("nope", player)).toThrow(/does not match any valid and loaded schema/);
  });

  it("sizes the buffer as header + fields + utf8 string", () => {
    // 1 header + 10 fixed + 5 bytes of "angel"
    expect(wisp.encode("example-packet", player).byteLength).toBe(16);
  });

  it("grows the buffer with a longer string", () => {
    const buf = wisp.encode("example-packet", { ...player, playerName: "angeldiaz" });
    expect(buf.byteLength).toBe(20);
  });

  it("sizes by utf8 byte length, not character count", () => {
    // "Ángel" is 5 characters but 6 UTF-8 bytes
    const buf = wisp.encode("example-packet", { ...player, playerName: "Ángel" });
    expect(buf.byteLength).toBe(17);
  });

  it("writes the packet id into the header byte", () => {
    const view = new DataView(wisp.encode("example-packet", player));
    expect(view.getUint8(OFF.id)).toBe(Number(wisp.getPacketIdFromName("example-packet")));
  });

  it("writes byte and float32 fields at their offsets", () => {
    const view = new DataView(wisp.encode("example-packet", player));
    expect(view.getUint8(OFF.health)).toBe(100);
    expect(view.getFloat32(OFF.posX)).toBe(12.5);
    expect(view.getFloat32(OFF.posY)).toBe(-3.25);
  });

  it("packs booleans into a single byte, most significant bit first", () => {
    const view = new DataView(wisp.encode("example-packet", player));
    // isAlive = true -> bit 7, isJumping = false -> bit 6
    expect(view.getUint8(OFF.bools)).toBe(0b1000_0000);
  });

  it("packs a different boolean combination", () => {
    const view = new DataView(wisp.encode("example-packet", { ...player, isJumping: true }));
    expect(view.getUint8(OFF.bools)).toBe(0b1100_0000);
  });

  it("treats missing booleans as false", () => {
    const { isAlive, isJumping, ...rest } = player;
    const view = new DataView(wisp.encode("example-packet", rest));
    expect(view.getUint8(OFF.bools)).toBe(0b0000_0000);
  });

  it("writes the string as utf8 at the end of the buffer", () => {
    const buf = wisp.encode("example-packet", player);
    const tail = new Uint8Array(buf).subarray(OFF.string);
    expect(new TextDecoder().decode(tail)).toBe("angel");
  });

  it("round-trips a multi-byte string through the tail bytes", () => {
    const buf = wisp.encode("example-packet", { ...player, playerName: "Ángel 🔥" });
    const tail = new Uint8Array(buf).subarray(OFF.string);
    expect(new TextDecoder().decode(tail)).toBe("Ángel 🔥");
  });

  it("handles an empty string", () => {
    const buf = wisp.encode("example-packet", { ...player, playerName: "" });
    expect(buf.byteLength).toBe(11);
  });

  it("omits fields that are not in the schema", () => {
    const buf = wisp.encode("example-packet", { ...player, secret: 42 });
    expect(buf.byteLength).toBe(16);
  });
});

describe("decode", () => {
  it("round-trips every field of a packet", () => {
    const out = wisp.decode(wisp.encode("example-packet", player));
    expect(out).toEqual({ packetName: "example-packet", ...player });
  });

  it("reports the packet name it decoded", () => {
    const out = wisp.decode(wisp.encode("example-packet", player));
    expect(out.packetName).toBe("example-packet");
  });

  it("round-trips byte and float32 fields", () => {
    const out = wisp.decode(wisp.encode("example-packet", player));
    expect(out.health).toBe(100);
    expect(out.posX).toBe(12.5);
    expect(out.posY).toBe(-3.25);
  });

  it("round-trips booleans that are set", () => {
    const out = wisp.decode(wisp.encode("example-packet", player));
    expect(out.isAlive).toBe(true);
    expect(out.isJumping).toBe(false);
  });

  it("round-trips the opposite boolean combination", () => {
    const packet = { ...player, isAlive: false, isJumping: true };
    const out = wisp.decode(wisp.encode("example-packet", packet));
    expect(out.isAlive).toBe(false);
    expect(out.isJumping).toBe(true);
  });

  it("round-trips both booleans false", () => {
    const packet = { ...player, isAlive: false, isJumping: false };
    const out = wisp.decode(wisp.encode("example-packet", packet));
    expect(out.isAlive).toBe(false);
    expect(out.isJumping).toBe(false);
  });

  it("round-trips an ascii string", () => {
    const out = wisp.decode(wisp.encode("example-packet", player));
    expect(out.playerName).toBe("angel");
  });

  it("round-trips an empty string", () => {
    const out = wisp.decode(wisp.encode("example-packet", { ...player, playerName: "" }));
    expect(out.playerName ?? "").toBe("");
  });

  it("round-trips a non-ascii string", () => {
    const packet = { ...player, playerName: "Ángel 🔥" };
    const out = wisp.decode(wisp.encode("example-packet", packet));
    expect(out.playerName).toBe("Ángel 🔥");
  });

  it("rejects a buffer whose packet id matches no schema", () => {
    const buf = new ArrayBuffer(16);
    new DataView(buf).setUint8(0, 200);
    expect(wisp.decode(buf)).toBeUndefined();
  });
});

// decode() receives whatever a client puts on the wire, so it must never throw.
// Anything it cannot make sense of should come back as undefined.
describe("decode: nonsensical input", () => {
  const garbage: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "hello"],
    ["a number", 42],
    ["a plain object", {}],
    ["an array", [0, 1, 2]],
    ["a Uint8Array rather than its buffer", new Uint8Array([0, 1, 2])],
    ["a DataView", new DataView(new ArrayBuffer(16))],
  ];

  it.each(garbage)("returns undefined for %s", (_label, value) => {
    expect(wisp.decode(value as ArrayBuffer)).toBeUndefined();
  });

  it("returns undefined for an empty buffer", () => {
    expect(wisp.decode(new ArrayBuffer(0))).toBeUndefined();
  });

  it("returns undefined when the packet id matches no schema", () => {
    const buf = new Uint8Array([200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    expect(wisp.decode(buf)).toBeUndefined();
  });

  // A valid id followed by too few bytes is the dangerous case: the id passes
  // validation, then the field reads run off the end of the buffer.
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "returns undefined for a packet truncated to %i byte(s)",
    (length) => {
      const full = new Uint8Array(wisp.encode("example-packet", player));
      expect(wisp.decode(full.slice(0, length).buffer)).toBeUndefined();
    },
  );

  it("does not throw on a buffer that is longer than the schema", () => {
    const full = new Uint8Array(wisp.encode("example-packet", player));
    const padded = new Uint8Array(full.byteLength + 500);
    padded.set(full);
    expect(() => wisp.decode(padded.buffer)).not.toThrow();
  });

  it("does not throw on random bytes of random length", () => {
    for (let i = 0; i < 500; i++) {
      const bytes = new Uint8Array(Math.floor(Math.random() * 40));
      for (let b = 0; b < bytes.length; b++) {
        bytes[b] = Math.floor(Math.random() * 256);
      }
      expect(() => wisp.decode(bytes.buffer)).not.toThrow();
    }
  });

  it("does not throw when every byte is 0xFF", () => {
    const bytes = new Uint8Array(32).fill(0xff);
    expect(() => wisp.decode(bytes.buffer)).not.toThrow();
  });

  it("does not throw on a buffer of only zeroes", () => {
    expect(() => wisp.decode(new ArrayBuffer(64))).not.toThrow();
  });
});

describe("encode: nonsensical input", () => {
  it("throws a clear error for an unknown schema name", () => {
    expect(() => wisp.encode("no-such-packet", player)).toThrow(
      /does not match any valid and loaded schema/,
    );
  });

  it("throws rather than silently emitting a bad packet for null data", () => {
    expect(() => wisp.encode("example-packet", null)).toThrow();
  });
});
