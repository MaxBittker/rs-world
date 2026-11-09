import { LiveWorld } from "./LiveWorld";
import { REMOVED_LOC, STATIC_LOC, WorldState, getLocKey, getTileKey } from "./WorldState";
import { ZoneRecord } from "./protocol";

function createState(): WorldState {
    const locTypeLoader = { load: () => ({ seqId: -1 }) } as any;
    const seqTypeLoader = { load: () => ({ frameIds: [] }) } as any;
    return new WorldState(locTypeLoader, seqTypeLoader, {} as any, undefined);
}

const world = {} as LiveWorld;

// 64 x 64 tiles at (3200, 3200): zones 400..407 x 400..407.
const AREA: ZoneRecord = { e: "za", x: 3200, z: 3200, w: 64, h: 64 };
const FAR_AREA: ZoneRecord = { e: "za", x: 3400, z: 3400, w: 64, h: 64 };
const STUMP: ZoneRecord = { e: "la", x: 3217, z: 3241, l: 0, id: 1342, s: 10, r: 1 };
const COINS: ZoneRecord = { e: "oa", x: 3218, z: 3242, l: 0, id: 995, n: 5 };
const STUMP_KEY = getLocKey(3217, 3241, 0, 2);
const COINS_KEY = getTileKey(3218, 3242, 0);

function objsAt(state: WorldState, key: number) {
    return state.objTiles.get(key)?.objs;
}

test("overlapping feeds apply each tick once, whichever arrives first", () => {
    const state = createState();
    const a = state.newFeedId();
    const b = state.newFeedId();
    const changes: number[][] = [];
    state.locChangeListeners.push((x, z, level, layer) => changes.push([x, z, level, layer]));

    state.apply(a, 10, world, [AREA, STUMP, COINS]);
    state.apply(b, 10, world, [AREA, STUMP, COINS]);
    const add: ZoneRecord[] = [{ e: "oa", x: 3218, z: 3242, l: 0, id: 526, n: 1 }];
    state.apply(a, 11, world, add);
    state.apply(b, 11, world, add);
    // b ahead of a for tick 12.
    const del: ZoneRecord[] = [{ e: "od", x: 3218, z: 3242, l: 0, id: 995 }];
    state.apply(b, 12, world, del);
    state.apply(a, 12, world, del);

    expect(state.locs.get(STUMP_KEY)?.id).toBe(1342);
    expect(objsAt(state, COINS_KEY)).toEqual([{ id: 526, count: 1 }]);
    expect(changes).toEqual([[3217, 3241, 0, 2]]);
});

test("a zone is dropped when no area holds it and starts at default when held again", () => {
    const state = createState();
    const a = state.newFeedId();
    const b = state.newFeedId();
    state.apply(a, 10, world, [AREA, STUMP, COINS]);
    state.apply(b, 10, world, [AREA]);

    // a leaves; b still holds the area, so the state stays and b's events now apply.
    state.apply(a, 11, world, [FAR_AREA]);
    expect(state.locs.get(STUMP_KEY)?.id).toBe(1342);
    state.apply(b, 12, world, [{ e: "ld", x: 3217, z: 3241, l: 0, s: 10, r: 1 }]);
    expect(state.locs.get(STUMP_KEY)?.id).toBe(REMOVED_LOC);

    // Nobody holds it: back to the cache.
    state.apply(b, 13, world, [FAR_AREA]);
    expect(state.locs.size).toBe(0);
    expect(state.objTiles.size).toBe(0);
    expect(state.zones.size).toBe(0);

    // Held again: only the state the server sends.
    state.apply(a, 14, world, [AREA, COINS]);
    expect(state.locs.size).toBe(0);
    expect(objsAt(state, COINS_KEY)).toEqual([{ id: 995, count: 5 }]);

    state.dropFeed(a);
    expect(state.zones.size).toBe(0);
});

test("a newly held zone is reset unless another feed is already as new", () => {
    const state = createState();
    const a = state.newFeedId();
    const b = state.newFeedId();
    state.apply(a, 10, world, [AREA, STUMP, COINS]);
    state.apply(a, 12, world, [{ e: "oa", x: 3218, z: 3242, l: 0, id: 526, n: 1 }]);
    // b joins with tick 11's snapshot after a applied tick 12: ignored.
    state.apply(b, 11, world, [AREA, STUMP, COINS]);
    expect(objsAt(state, COINS_KEY)).toEqual([
        { id: 995, count: 5 },
        { id: 526, count: 1 },
    ]);
    // b's tick 13 area is newer: its snapshot is the state (the coins were picked up).
    state.apply(b, 13, world, [FAR_AREA]);
    state.apply(b, 14, world, [AREA, STUMP]);
    expect(objsAt(state, COINS_KEY)).toBeUndefined();
    expect(state.locs.get(STUMP_KEY)?.id).toBe(1342);
    // a's late tick 13 event for the zone is older than b's snapshot.
    state.apply(a, 13, world, [{ e: "oa", x: 3219, z: 3242, l: 0, id: 1, n: 1 }]);
    expect(objsAt(state, getTileKey(3219, 3242, 0))).toBeUndefined();
});

test("a lagging feed's events for a zone another feed just snapshotted are skipped", () => {
    const state = createState();
    const a = state.newFeedId();
    const b = state.newFeedId();
    state.apply(a, 10, world, [AREA]);
    // b gains the area at tick 12 with nothing in it, before a's tick 11 arrives.
    state.apply(b, 12, world, [AREA]);
    state.apply(a, 11, world, [COINS]);
    expect(state.objTiles.size).toBe(0);
    state.apply(a, 13, world, [COINS]);
    expect(objsAt(state, COINS_KEY)).toEqual([{ id: 995, count: 5 }]);
});

test("a reset starts every held zone again; a new server resets the ticks", () => {
    const state = createState();
    const a = state.newFeedId();
    state.onHello(a, 5);
    state.apply(a, 10, world, [AREA, STUMP, COINS]);
    state.apply(a, 20, world, [{ ...AREA, r: 1 } as ZoneRecord, COINS]);
    expect(state.locs.size).toBe(0);
    expect(objsAt(state, COINS_KEY)).toEqual([{ id: 995, count: 5 }]);

    // The engine restarted: ticks start over.
    state.onHello(a, 1);
    state.apply(a, 3, world, [AREA, STUMP]);
    expect(objsAt(state, COINS_KEY)).toBeUndefined();
    expect(state.locs.get(STUMP_KEY)?.id).toBe(1342);
});

test("a loc anim on an unchanged tile animates the static loc, and ld removes it", () => {
    const state = createState();
    const feed = state.newFeedId();
    state.apply(feed, 1, world, [AREA]);
    // The stub seq has no frames, so nothing changes for the static loc.
    state.apply(feed, 2, world, [{ e: "an", x: 3201, z: 3201, l: 0, s: 10, r: 0, q: 1 }]);
    expect(state.locs.size).toBe(0);
    state.apply(feed, 3, world, [{ e: "ld", x: 3201, z: 3201, l: 0, s: 0, r: 0 }]);
    const loc = state.locs.get(getLocKey(3201, 3201, 0, 0));
    expect(loc?.id).toBe(REMOVED_LOC);
    expect(loc?.id).not.toBe(STATIC_LOC);
    // A reset of the area resets the zone.
    state.apply(feed, 4, world, [{ ...AREA, r: 1 } as ZoneRecord]);
    expect(state.locs.size).toBe(0);
});
