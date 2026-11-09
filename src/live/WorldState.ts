import { LOC_LAYER_GROUND, LOC_SHAPE_TO_LAYER } from "../mapviewer/webgl/loader/SdLocTable";
import { TypeLoader } from "../rs/config/TypeLoader";
import { LocTypeLoader } from "../rs/config/loctype/LocTypeLoader";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { SpotAnimType } from "../rs/config/spotanimtype/SpotAnimType";
import { SeqFrameLoader } from "../rs/model/seq/SeqFrameLoader";
import { LiveWorld } from "./LiveWorld";
import { ZoneRecord } from "./protocol";

// What a logged-in player sees of the engine's zones that is not a player or npc: loc changes
// (fires, stumps, open doors, depleted rocks), loc anims, public ground objs, projectiles and map
// anims. One store for the whole viewer; it can take several feeds at once (each tick applies once).
// Each feed holds an area (za, all levels); a zone is held while any feed's area covers it and
// is dropped once none does. The feeds describe the same server, so a zone keeps the tick its
// state is current as of, and a feed's records for it apply only when they are newer: that way
// overlapping feeds never apply the same tick twice, whichever arrives first.

export { LOC_LAYER_GROUND, LOC_SHAPE_TO_LAYER };

// Override ids besides a loc type: the static loc is removed, or the static loc beneath plays a
// loc anim (its type comes from the map square).
export const REMOVED_LOC = -1;
export const STATIC_LOC = -2;

// Client cycles are 20ms; the store keeps its own clock so every view sees one timeline.
const CYCLE_MS = 20;
const MAX_CYCLES_PER_UPDATE = 50;
// A map anim without a seq never completes in the client; let it go after a while.
const STILL_MAP_ANIM_CYCLES = 100;

export function getTileKey(x: number, z: number, level: number): number {
    return (level * 16384 + x) * 16384 + z;
}

export function getLocKey(x: number, z: number, level: number, layer: number): number {
    return ((level * 4 + layer) * 16384 + x) * 16384 + z;
}

function getZoneKey(x: number, z: number, level: number): number {
    return (level * 2048 + (x >> 3)) * 2048 + (z >> 3);
}

function getSquareId(x: number, z: number): number {
    return ((x >> 6) << 8) + (z >> 6);
}

// A loc on one tile and layer that differs from the cache: removed, replaced or added (id), or
// animated (seq). Animation state follows the client's ClientLocAnim.
export class LocOverride {
    seq?: SeqType;
    animFrame: number = 0;
    animCycle: number = 0;
    // An explicit loc anim (an) rather than the loc type's own.
    explicitAnim: boolean = false;

    constructor(
        readonly key: number,
        readonly x: number,
        readonly z: number,
        readonly level: number,
        readonly layer: number,
        public id: number,
        public shape: number,
        public angle: number,
    ) {}
}

export type GroundObj = { id: number; count: number };

export class ObjTile {
    objs: GroundObj[] = [];

    constructor(
        readonly key: number,
        readonly x: number,
        readonly z: number,
        readonly level: number,
    ) {}
}

// Port of the client's MapSpotAnim (fine coords; y resolved once the ground is loaded).
export class MapAnim {
    y: number = 0;
    placed: boolean = false;
    animFrame: number = 0;
    animCycle: number = 0;
    complete: boolean = false;

    constructor(
        readonly spotAnim: number,
        readonly seq: SeqType | undefined,
        readonly level: number,
        readonly x: number,
        readonly z: number,
        readonly height: number,
        readonly startCycle: number,
    ) {}
}

// Port of the client's ClientProj; the target is resolved in the feed's own LiveWorld.
export class Projectile {
    mobile: boolean = false;
    placed: boolean = false;
    x: number = 0;
    y: number = 0;
    z: number = 0;
    velocityX: number = 0;
    velocityZ: number = 0;
    velocity: number = 0;
    velocityY: number = 0;
    accelerationY: number = 0;
    yaw: number = 0;
    pitch: number = 0;
    animFrame: number = 0;
    animCycle: number = 0;
    srcY: number = 0;

    constructor(
        readonly spotAnim: number,
        readonly seq: SeqType | undefined,
        readonly level: number,
        readonly srcX: number,
        readonly srcZ: number,
        readonly dstX: number,
        readonly dstZ: number,
        readonly h1: number,
        readonly h2: number,
        readonly t1: number,
        readonly t2: number,
        readonly angle: number,
        readonly startpos: number,
        readonly target: number,
        readonly world: LiveWorld,
    ) {}

    setTarget(dstX: number, dstY: number, dstZ: number, cycle: number): void {
        if (!this.mobile) {
            const dx = dstX - this.srcX;
            const dz = dstZ - this.srcZ;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > 0) {
                this.x = this.srcX + (dx * this.startpos) / d;
                this.z = this.srcZ + (dz * this.startpos) / d;
            } else {
                this.x = this.srcX;
                this.z = this.srcZ;
            }
            this.y = this.srcY;
        }
        const dt = this.t2 + 1 - cycle;
        this.velocityX = (dstX - this.x) / dt;
        this.velocityZ = (dstZ - this.z) / dt;
        this.velocity = Math.sqrt(
            this.velocityX * this.velocityX + this.velocityZ * this.velocityZ,
        );
        if (!this.mobile) {
            this.velocityY = -this.velocity * Math.tan(this.angle * 0.02454369);
        }
        this.accelerationY = ((dstY - this.y - this.velocityY * dt) * 2.0) / (dt * dt);
    }

    move(delta: number, frameDelay: (seq: SeqType, frame: number) => number): void {
        this.mobile = true;
        this.x += this.velocityX * delta;
        this.z += this.velocityZ * delta;
        this.y += this.velocityY * delta + this.accelerationY * 0.5 * delta * delta;
        this.velocityY += this.accelerationY * delta;
        this.yaw = ((Math.atan2(this.velocityX, this.velocityZ) * 325.949 + 1024) | 0) & 0x7ff;
        this.pitch = ((Math.atan2(this.velocityY, this.velocity) * 325.949) | 0) & 0x7ff;
        const seq = this.seq;
        const frameCount = seq?.frameIds?.length ?? 0;
        if (seq && frameCount > 0) {
            this.animCycle += delta;
            while (this.animCycle > frameDelay(seq, this.animFrame)) {
                this.animCycle -= frameDelay(seq, this.animFrame) + 1;
                this.animFrame++;
                if (this.animFrame >= frameCount) {
                    this.animFrame = 0;
                }
            }
        }
    }
}

// Only zones that have state (or had records) are kept; every other held zone is the default.
class Zone {
    // The server tick this zone's state is current as of, and the apply() call that may still
    // add to that tick.
    tick: number = -1;
    writer: number = 0;
    locs: Set<LocOverride> = new Set();
    objs: Set<ObjTile> = new Set();

    constructor(
        readonly key: number,
        // zone units (tile >> 3)
        readonly x: number,
        readonly z: number,
    ) {}
}

// A feed's held area in zone units, [x0, x1) x [z0, z1) on every level, and the tick it was set.
type FeedArea = { x0: number; z0: number; x1: number; z1: number; tick: number };

function inArea(area: FeedArea | undefined, x: number, z: number): boolean {
    return !!area && x >= area.x0 && x < area.x1 && z >= area.z0 && z < area.z1;
}

// Ground height at a fine coord (RS convention, negative is up), bridges included, or undefined
// while the map square isn't loaded.
export type GroundHeightFunction = (
    level: number,
    fineX: number,
    fineZ: number,
) => number | undefined;

// The cache's loc on a tile and layer, from the loaded map square.
export type StaticLoc = { id: number; shape: number; angle: number; raise: number };
export type StaticLocLookup = (
    x: number,
    z: number,
    level: number,
    layer: number,
    out: StaticLoc,
) => boolean;

function isSameLoc(loc: LocOverride, staticLoc: StaticLoc | undefined): boolean {
    return (
        !!staticLoc &&
        staticLoc.id === loc.id &&
        staticLoc.shape === loc.shape &&
        staticLoc.angle === loc.angle
    );
}

// Whether an override hides the static loc beneath (undefined: none, or not loaded).
export function hidesStaticLoc(loc: LocOverride, staticLoc: StaticLoc | undefined): boolean {
    if (loc.id === REMOVED_LOC) {
        return true;
    }
    if (loc.id === STATIC_LOC) {
        return !!loc.seq;
    }
    // Changed back to the cache's loc: the baked one shows (with its own anim).
    return loc.explicitAnim || !isSameLoc(loc, staticLoc);
}

// The loc type an override draws through the dynamic path, or -1 for none.
export function getDrawnLocId(loc: LocOverride, staticLoc: StaticLoc | undefined): number {
    if (loc.id === REMOVED_LOC) {
        return -1;
    }
    if (loc.id === STATIC_LOC) {
        return staticLoc && loc.seq ? staticLoc.id : -1;
    }
    return loc.explicitAnim || !isSameLoc(loc, staticLoc) ? loc.id : -1;
}

// Told whenever the override on a tile and layer is added, changed or dropped.
export type LocChangeListener = (x: number, z: number, level: number, layer: number) => void;

export class WorldState {
    zones: Map<number, Zone> = new Map();
    // Held area per feed.
    areas: Map<number, FeedArea> = new Map();
    locs: Map<number, LocOverride> = new Map();
    // Overrides by map square ((mapX << 8) + mapY), to apply to a square when it loads.
    locsBySquare: Map<number, Set<LocOverride>> = new Map();
    objTiles: Map<number, ObjTile> = new Map();
    mapAnims: MapAnim[] = [];
    projectiles: Projectile[] = [];
    // Overrides that are animating, stepped by update().
    private animating: Set<LocOverride> = new Set();

    loopCycle: number = 0;
    private lastUpdateCycle: number = -1;
    private nextFeedId: number = 1;
    // apply() calls so far, and the newest server tick seen.
    private applyCount: number = 0;
    private serverTick: number = -1;

    // Bumped on any change to the objs, and to the loc overrides (the renderer caches its obj
    // stacks, whose heights depend on the locs beneath).
    objVersion: number = 0;
    locVersion: number = 0;

    groundHeight?: GroundHeightFunction;
    locChangeListeners: LocChangeListener[] = [];

    constructor(
        readonly locTypeLoader: LocTypeLoader,
        readonly seqTypeLoader: SeqTypeLoader,
        readonly seqFrameLoader: SeqFrameLoader,
        readonly spotAnimTypeLoader: TypeLoader<SpotAnimType> | undefined,
    ) {
        this.loopCycle = Math.floor(performance.now() / CYCLE_MS);
    }

    newFeedId(): number {
        return this.nextFeedId++;
    }

    // A feed (re)connected: it holds nothing until its first za. A tick older than any seen
    // means a new server, so no zone's tick can be trusted any more.
    onHello(feed: number, tick: number): void {
        this.dropFeed(feed);
        if (tick < this.serverTick) {
            for (const zone of this.zones.values()) {
                zone.tick = -1;
            }
            for (const area of this.areas.values()) {
                area.tick = -1;
            }
        }
        this.serverTick = tick;
    }

    // Applies one tick's zone records from a feed.
    apply(feed: number, tick: number, world: LiveWorld, records: ZoneRecord[]): void {
        this.syncClock();
        const writer = ++this.applyCount;
        if (tick > this.serverTick) {
            this.serverTick = tick;
        }
        for (const record of records) {
            if (record.e === "za") {
                this.setArea(feed, tick, writer, record);
                continue;
            }
            const zone = this.getZoneToApply(feed, tick, writer, record.x, record.z, record.l);
            if (!zone) {
                continue;
            }
            switch (record.e) {
                case "la":
                    this.setLoc(zone, record.x, record.z, record.l, record.id, record.s, record.r);
                    break;
                case "ld":
                    this.setLoc(
                        zone,
                        record.x,
                        record.z,
                        record.l,
                        REMOVED_LOC,
                        record.s,
                        record.r,
                    );
                    break;
                case "an":
                    this.animateLoc(
                        zone,
                        record.x,
                        record.z,
                        record.l,
                        record.s,
                        record.r,
                        record.q,
                    );
                    break;
                case "oa":
                    this.addObj(zone, record.x, record.z, record.l, record.id, record.n);
                    break;
                case "od":
                    this.delObj(record.x, record.z, record.l, record.id);
                    break;
                case "oc":
                    this.countObj(record.x, record.z, record.l, record.id, record.n0, record.n);
                    break;
                case "ma":
                    this.addMapAnim(record.x, record.z, record.l, record.id, record.h, record.d);
                    break;
                case "pj":
                    this.addProjectile(world, record);
                    break;
                // lm (a loc merged into a player's model, e.g. agility shortcuts) isn't drawn.
            }
        }
    }

    // A feed went away (closed or reconnected): it holds nothing any more.
    dropFeed(feed: number): void {
        const area = this.areas.get(feed);
        if (!area) {
            return;
        }
        this.areas.delete(feed);
        for (const zone of this.zones.values()) {
            if (inArea(area, zone.x, zone.z) && !this.isHeld(zone.x, zone.z)) {
                this.dropZone(zone);
            }
        }
    }

    // za: zones newly held (all of them on a reset) start at the cache default unless another
    // feed already applied this tick; zones no feed holds any more are dropped.
    private setArea(
        feed: number,
        tick: number,
        writer: number,
        r: Extract<ZoneRecord, { e: "za" }>,
    ): void {
        const prev = this.areas.get(feed);
        const x0 = r.x >> 3;
        const z0 = r.z >> 3;
        const next: FeedArea = { x0, z0, x1: x0 + (r.w >> 3), z1: z0 + (r.h >> 3), tick };
        this.areas.set(feed, next);
        for (const zone of this.zones.values()) {
            if (inArea(next, zone.x, zone.z)) {
                if ((r.r || !inArea(prev, zone.x, zone.z)) && zone.tick < tick) {
                    this.resetZone(zone);
                    zone.tick = tick;
                    zone.writer = writer;
                }
            } else if (inArea(prev, zone.x, zone.z) && !this.isHeld(zone.x, zone.z)) {
                this.dropZone(zone);
            }
        }
    }

    private isHeld(x: number, z: number): boolean {
        for (const area of this.areas.values()) {
            if (inArea(area, x, z)) {
                return true;
            }
        }
        return false;
    }

    private dropZone(zone: Zone): void {
        this.resetZone(zone);
        this.zones.delete(zone.key);
    }

    // The zone a feed's record of this tick applies to, or undefined when the zone's state is
    // already current as of this tick (another feed got there first).
    private getZoneToApply(
        feed: number,
        tick: number,
        writer: number,
        x: number,
        z: number,
        level: number,
    ): Zone | undefined {
        const key = getZoneKey(x, z, level);
        let zone = this.zones.get(key);
        if (zone && zone.writer === writer) {
            return zone;
        }
        if (!zone) {
            // A default zone is current as of the newest za of another feed holding it (that
            // feed's state for it came with its za).
            const zx = x >> 3;
            const zz = z >> 3;
            for (const [other, area] of this.areas) {
                if (other !== feed && area.tick >= tick && inArea(area, zx, zz)) {
                    return undefined;
                }
            }
            zone = new Zone(key, zx, zz);
            this.zones.set(key, zone);
        } else if (zone.tick >= tick) {
            return undefined;
        }
        zone.tick = tick;
        zone.writer = writer;
        return zone;
    }

    private resetZone(zone: Zone): void {
        for (const loc of zone.locs) {
            this.removeLoc(loc);
        }
        zone.locs.clear();
        if (zone.objs.size > 0) {
            for (const tile of zone.objs) {
                this.objTiles.delete(tile.key);
            }
            zone.objs.clear();
            this.objVersion++;
        }
    }

    private removeLoc(loc: LocOverride): void {
        this.locs.delete(loc.key);
        this.animating.delete(loc);
        const squareId = getSquareId(loc.x, loc.z);
        const square = this.locsBySquare.get(squareId);
        if (square) {
            square.delete(loc);
            if (square.size === 0) {
                this.locsBySquare.delete(squareId);
            }
        }
        this.notifyLoc(loc);
    }

    private notifyLoc(loc: LocOverride): void {
        this.locVersion++;
        for (const listener of this.locChangeListeners) {
            listener(loc.x, loc.z, loc.level, loc.layer);
        }
    }

    private getOrAddLoc(
        zone: Zone,
        x: number,
        z: number,
        level: number,
        shape: number,
    ): LocOverride {
        const layer = LOC_SHAPE_TO_LAYER[shape] ?? LOC_LAYER_GROUND;
        const key = getLocKey(x, z, level, layer);
        let loc = this.locs.get(key);
        if (!loc) {
            loc = new LocOverride(key, x, z, level, layer, REMOVED_LOC, shape, 0);
            this.locs.set(key, loc);
            zone.locs.add(loc);
            const squareId = getSquareId(x, z);
            let square = this.locsBySquare.get(squareId);
            if (!square) {
                square = new Set();
                this.locsBySquare.set(squareId, square);
            }
            square.add(loc);
        }
        return loc;
    }

    private setLoc(
        zone: Zone,
        x: number,
        z: number,
        level: number,
        id: number,
        shape: number,
        angle: number,
    ): void {
        const loc = this.getOrAddLoc(zone, x, z, level, shape);
        loc.id = id;
        loc.shape = shape;
        loc.angle = angle;
        loc.explicitAnim = false;
        // A changed loc plays its type's own anim from a random frame, like the client's addLoc.
        const seqId = id >= 0 ? this.locTypeLoader.load(id)?.seqId ?? -1 : -1;
        this.startAnim(loc, seqId, true);
        this.notifyLoc(loc);
    }

    private animateLoc(
        zone: Zone,
        x: number,
        z: number,
        level: number,
        shape: number,
        angle: number,
        seqId: number,
    ): void {
        const layer = LOC_SHAPE_TO_LAYER[shape] ?? LOC_LAYER_GROUND;
        let loc = this.locs.get(getLocKey(x, z, level, layer));
        if (loc && loc.id === REMOVED_LOC) {
            // Nothing there to animate.
            return;
        }
        const added = !loc;
        if (!loc) {
            // Animates the loc from the cache: the renderer draws it from the map square's type.
            loc = this.getOrAddLoc(zone, x, z, level, shape);
            loc.id = STATIC_LOC;
            loc.shape = shape;
            loc.angle = angle;
        }
        loc.explicitAnim = true;
        this.startAnim(loc, seqId, false);
        if (!loc.seq && added) {
            // Not a seq we can play: leave the static loc alone.
            this.removeLoc(loc);
            zone.locs.delete(loc);
            return;
        }
        // An explicit anim draws even an unchanged static loc dynamically.
        this.notifyLoc(loc);
    }

    private startAnim(loc: LocOverride, seqId: number, randomFrame: boolean): void {
        const seq = seqId !== -1 ? this.seqTypeLoader.load(seqId) : undefined;
        const frameCount = seq?.frameIds?.length ?? 0;
        if (!seq || frameCount === 0) {
            loc.seq = undefined;
            this.animating.delete(loc);
            return;
        }
        loc.seq = seq;
        loc.animFrame = 0;
        loc.animCycle = this.loopCycle;
        if (randomFrame && seq.frameStep !== -1) {
            loc.animFrame = Math.floor(Math.random() * frameCount);
            loc.animCycle -= Math.floor(Math.random() * this.frameDelay(seq, loc.animFrame));
        }
        this.animating.add(loc);
    }

    // ClientLocAnim.getTempModel's timing: the seq frame to draw this cycle, -1 for none.
    private stepLocAnim(loc: LocOverride): void {
        const seq = loc.seq;
        if (!seq) {
            return;
        }
        const frameCount = seq.frameIds.length;
        let delta = this.loopCycle - loc.animCycle;
        if (delta > 100 && seq.frameStep > 0) {
            delta = 100;
        }
        while (delta > this.frameDelay(seq, loc.animFrame)) {
            delta -= this.frameDelay(seq, loc.animFrame);
            loc.animFrame++;
            if (loc.animFrame < frameCount) {
                continue;
            }
            loc.animFrame -= seq.frameStep;
            if (loc.animFrame < 0 || loc.animFrame >= frameCount) {
                loc.seq = undefined;
                loc.animFrame = 0;
                break;
            }
        }
        loc.animCycle = this.loopCycle - delta;
        if (!loc.seq) {
            this.animating.delete(loc);
            if (loc.id === STATIC_LOC) {
                // The static loc's own model is back.
                this.removeLoc(loc);
                this.zones.get(getZoneKey(loc.x, loc.z, loc.level))?.locs.delete(loc);
            } else if (loc.explicitAnim) {
                loc.explicitAnim = false;
                this.notifyLoc(loc);
            }
        }
    }

    private addObj(
        zone: Zone,
        x: number,
        z: number,
        level: number,
        id: number,
        count: number,
    ): void {
        const key = getTileKey(x, z, level);
        let tile = this.objTiles.get(key);
        if (!tile) {
            tile = new ObjTile(key, x, z, level);
            this.objTiles.set(key, tile);
            zone.objs.add(tile);
        }
        tile.objs.push({ id, count });
        this.objVersion++;
    }

    private delObj(x: number, z: number, level: number, id: number): void {
        const key = getTileKey(x, z, level);
        const tile = this.objTiles.get(key);
        if (!tile) {
            return;
        }
        const index = tile.objs.findIndex((obj) => obj.id === (id & 0x7fff));
        if (index === -1) {
            return;
        }
        tile.objs.splice(index, 1);
        if (tile.objs.length === 0) {
            this.objTiles.delete(key);
            this.zones.get(getZoneKey(x, z, level))?.objs.delete(tile);
        }
        this.objVersion++;
    }

    private countObj(
        x: number,
        z: number,
        level: number,
        id: number,
        oldCount: number,
        count: number,
    ): void {
        const tile = this.objTiles.get(getTileKey(x, z, level));
        const type = id & 0x7fff;
        // The one with the old count, else the first of that type (a snapshot taken on the tick
        // the count changed already has the new count).
        const obj =
            tile?.objs.find((obj) => obj.id === type && obj.count === oldCount) ??
            tile?.objs.find((obj) => obj.id === type);
        if (obj) {
            obj.count = count;
            this.objVersion++;
        }
    }

    private getSpotSeq(spotAnim: number): SeqType | undefined {
        const spot = this.spotAnimTypeLoader?.load(spotAnim);
        if (!spot || spot.sequenceId === -1) {
            return undefined;
        }
        const seq = this.seqTypeLoader.load(spot.sequenceId);
        return seq.frameIds && seq.frameIds.length > 0 ? seq : undefined;
    }

    private addMapAnim(
        x: number,
        z: number,
        level: number,
        spotAnim: number,
        height: number,
        delay: number,
    ): void {
        this.mapAnims.push(
            new MapAnim(
                spotAnim,
                this.getSpotSeq(spotAnim),
                level,
                x * 128 + 64,
                z * 128 + 64,
                height,
                this.loopCycle + delay,
            ),
        );
    }

    private addProjectile(world: LiveWorld, r: Extract<ZoneRecord, { e: "pj" }>): void {
        this.projectiles.push(
            new Projectile(
                r.id,
                this.getSpotSeq(r.id),
                r.l,
                r.x * 128 + 64,
                r.z * 128 + 64,
                r.dx * 128 + 64,
                r.dz * 128 + 64,
                r.sh * 4,
                r.dh * 4,
                this.loopCycle + r.sd,
                this.loopCycle + r.ed,
                r.pk,
                r.ar,
                r.tg,
                world,
            ),
        );
    }

    private syncClock(): void {
        this.loopCycle = Math.floor(performance.now() / CYCLE_MS);
    }

    // Once per rendered frame (more calls in the same cycle are no-ops): steps loc anims, map
    // anims and projectiles to the current client cycle.
    update(): void {
        this.syncClock();
        if (this.lastUpdateCycle === -1) {
            this.lastUpdateCycle = this.loopCycle;
        }
        const delta = Math.min(this.loopCycle - this.lastUpdateCycle, MAX_CYCLES_PER_UPDATE);
        if (delta <= 0) {
            return;
        }
        this.lastUpdateCycle = this.loopCycle;

        for (const loc of this.animating) {
            this.stepLocAnim(loc);
        }
        this.updateMapAnims(delta);
        this.updateProjectiles(delta);
    }

    private updateMapAnims(delta: number): void {
        const anims = this.mapAnims;
        let kept = 0;
        for (let i = 0; i < anims.length; i++) {
            const anim = anims[i];
            if (this.loopCycle >= anim.startCycle) {
                if (!anim.placed) {
                    const ground = this.groundHeight?.(anim.level, anim.x, anim.z);
                    if (ground !== undefined) {
                        anim.y = ground - anim.height;
                        anim.placed = true;
                    }
                }
                const seq = anim.seq;
                if (seq) {
                    const frameCount = seq.frameIds.length;
                    for (
                        anim.animCycle += delta;
                        anim.animCycle > this.frameDelay(seq, anim.animFrame);

                    ) {
                        anim.animCycle -= this.frameDelay(seq, anim.animFrame) + 1;
                        anim.animFrame++;
                        if (anim.animFrame >= frameCount) {
                            anim.animFrame = 0;
                            anim.complete = true;
                        }
                    }
                } else if (this.loopCycle - anim.startCycle > STILL_MAP_ANIM_CYCLES) {
                    anim.complete = true;
                }
            }
            if (!anim.complete) {
                anims[kept++] = anim;
            }
        }
        anims.length = kept;
    }

    private updateProjectiles(delta: number): void {
        const projectiles = this.projectiles;
        const loopCycle = this.loopCycle;
        let kept = 0;
        for (let i = 0; i < projectiles.length; i++) {
            const proj = projectiles[i];
            if (loopCycle > proj.t2) {
                continue;
            }
            projectiles[kept++] = proj;
            if (loopCycle < proj.t1) {
                continue;
            }
            if (!proj.placed) {
                // The client places it on receipt; we wait for the ground to be loaded.
                const srcGround = this.groundHeight?.(proj.level, proj.srcX, proj.srcZ);
                const dstGround = this.groundHeight?.(proj.level, proj.dstX, proj.dstZ);
                if (srcGround === undefined || dstGround === undefined) {
                    continue;
                }
                proj.srcY = srcGround - proj.h1;
                proj.placed = true;
                proj.setTarget(proj.dstX, dstGround - proj.h2, proj.dstZ, proj.t1);
            }
            const target =
                proj.target > 0
                    ? proj.world.npcs.get(proj.target - 1)
                    : proj.target < 0
                    ? proj.world.players.get(-proj.target - 1)
                    : undefined;
            if (target) {
                const ground = this.groundHeight?.(proj.level, target.x, target.z);
                if (ground !== undefined) {
                    proj.setTarget(target.x, ground - proj.h2, target.z, loopCycle);
                }
            }
            proj.move(delta, this.frameDelayBound);
        }
        projectiles.length = kept;
    }

    private frameDelay(seq: SeqType, frame: number): number {
        if (!seq.frameIds || frame < 0 || frame >= seq.frameIds.length) {
            return 1;
        }
        return seq.getFrameLength(this.seqFrameLoader, frame);
    }

    private frameDelayBound = (seq: SeqType, frame: number): number => this.frameDelay(seq, frame);

    // Drops everything (e.g. the cache changed).
    clear(): void {
        for (const zone of this.zones.values()) {
            this.resetZone(zone);
        }
        this.zones.clear();
        this.areas.clear();
        this.mapAnims.length = 0;
        this.projectiles.length = 0;
    }
}
