// Wire format of the rs-sdk world feed (engine src/web/worldfeed.ts, protocol v2).

export const WORLD_FEED_VERSION = 2;

export type FeedHello = {
    t: "hello";
    v: number;
    rev: number;
    tick: number;
    tickMs: number;
    players: number;
};

// One entity's changes this tick. Keys are only present when relevant.
export type FeedEntity = {
    // player slot / npc nid
    i: number;
    // 1 = first sight: a full record that replaces whatever was in this slot
    f?: number;
    // npc type (first sight and change_type)
    t?: number;
    x?: number;
    z?: number;
    l?: number;
    // steps this tick: [walkDir] or [walkDir, runDir], 0..7 (NW=0 .. SE=7)
    m?: number[];
    // 1 = moved without stepping (teleport), 2 = jump (never interpolate)
    tp?: number;
    // player appearance block, base64
    ap?: string;
    // [seq, delay]
    an?: [number, number];
    // [spotanim, height, delay]
    sp?: [number, number, number];
    // face entity: npc nid or 32768 + player slot, -1 clears
    fe?: number;
    // face fine coord [x, z] (tile * 2 + size)
    fs?: [number, number];
    // [[damage, type], ...]
    hm?: [number, number][];
    // [current, max]
    hp?: [number, number];
    // forced overhead text
    sy?: string;
    // public chat (players) and its [colour, effect]
    ch?: string;
    cc?: [number, number];
    // [startX, startZ, endX, endZ, startCycle, endCycle, facing]
    em?: [number, number, number, number, number, number, number];
};

export type FeedTick = {
    t: "tick";
    k: number;
    ms: number;
    reset?: number;
    p?: FeedEntity[];
    n?: FeedEntity[];
    rp?: number[];
    rn?: number[];
    // v2: zone state (locs, ground objs, projectiles, map anims), applied in order.
    w?: ZoneRecord[];
};

// Zone records use absolute tiles x, z and level l. A zone is the engine's 8x8 area on one level.
export type ZoneRecord =
    // the held area (zone-aligned tiles, every level), first in w when it changes: zones newly
    // held start at the cache default (all of them when r = 1, a reset), zones left are dropped;
    // the state of newly held zones follows as la/ld/oa
    | { e: "za"; x: number; z: number; w: number; h: number; r?: number }
    // loc add/change (s = shape, r = angle) and loc del
    | { e: "la"; x: number; z: number; l: number; id: number; s: number; r: number }
    | { e: "ld"; x: number; z: number; l: number; s: number; r: number }
    // loc anim (q = seq)
    | { e: "an"; x: number; z: number; l: number; s: number; r: number; q: number }
    // loc merged onto a player (p = slot, sc/ec = start/end cycle, bx = [east, south, west, north])
    | {
          e: "lm";
          x: number;
          z: number;
          l: number;
          id: number;
          s: number;
          r: number;
          sc: number;
          ec: number;
          p: number;
          bx: number[];
      }
    // public obj add/reveal, del and count change
    | { e: "oa"; x: number; z: number; l: number; id: number; n: number }
    | { e: "od"; x: number; z: number; l: number; id: number }
    | { e: "oc"; x: number; z: number; l: number; id: number; n0: number; n: number }
    // map anim (id = spotanim, h = height, d = delay in client cycles)
    | { e: "ma"; x: number; z: number; l: number; id: number; h: number; d: number }
    // projectile from (x, z) to the absolute tile (dx, dz). tg = target as the client protocol
    // encodes it (0 none, > 0 npc nid + 1, < 0 -(player slot + 1)), sh/dh = heights in 4-unit
    // steps, sd/ed = start/end delay in client cycles, pk = peak (pitch), ar = arc (start offset)
    | {
          e: "pj";
          x: number;
          z: number;
          l: number;
          dx: number;
          dz: number;
          tg: number;
          id: number;
          sh: number;
          dh: number;
          sd: number;
          ed: number;
          pk: number;
          ar: number;
      };

// [slot, name, x, z, level, combatLevel]
export type RosterPlayer = [number, string, number, number, number, number];

export type FeedRoster = {
    t: "roster";
    k: number;
    p: RosterPlayer[];
    npcs: number;
};

export type FeedMessage = FeedHello | FeedTick | FeedRoster;
