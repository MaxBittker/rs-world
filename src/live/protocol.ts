// Wire format of the rs-sdk world feed (engine src/web/worldfeed.ts, protocol v1).

export const WORLD_FEED_VERSION = 1;

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
