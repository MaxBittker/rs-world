import { TypeLoader } from "../rs/config/TypeLoader";
import { NpcTypeLoader } from "../rs/config/npctype/NpcTypeLoader";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { SpotAnimType } from "../rs/config/spotanimtype/SpotAnimType";
import { SeqFrameLoader } from "../rs/model/seq/SeqFrameLoader";
import {
    DIRECTION_DELTA_X,
    DIRECTION_DELTA_Z,
    LiveEntity,
    LiveNpc,
    LivePlayer,
    SeqMove,
    getPostanimMove,
    getPreanimMove,
} from "./LiveEntity";
import { decodePlayerAppearance } from "./PlayerAppearance";
import { FeedEntity, FeedRoster, FeedTick, RosterPlayer } from "./protocol";

const DUPLICATE_RESET = 1;
const DUPLICATE_RESETLOOP = 2;

// Live players and npcs from the world feed, simulated per 20ms client cycle exactly like the
// rs-sdk webclient (Client.moveEntity and friends), including its tick-rate speed scaling.
export class LiveWorld {
    players: Map<number, LivePlayer> = new Map();
    npcs: Map<number, LiveNpc> = new Map();

    loopCycle: number = 0;

    tick: number = -1;
    tickMs: number = 600;
    tickSpeedMultiplier: number = 1;
    ticksReceived: number = 0;

    rosterPlayers: RosterPlayer[] = [];
    rosterNpcCount: number = 0;
    rosterTick: number = -1;

    constructor(
        readonly npcTypeLoader: NpcTypeLoader,
        readonly seqTypeLoader: SeqTypeLoader,
        readonly seqFrameLoader: SeqFrameLoader,
        readonly spotAnimTypeLoader: TypeLoader<SpotAnimType> | undefined,
    ) {}

    clear(): void {
        this.players.clear();
        this.npcs.clear();
    }

    applyTick(msg: FeedTick): void {
        if (msg.reset) {
            this.clear();
        }
        this.tick = msg.k;
        this.ticksReceived++;
        if (msg.ms > 0 && msg.ms < 5000) {
            // Same smoothing and scale as the webclient's measured tick interval.
            this.tickMs = this.tickMs * 0.8 + msg.ms * 0.2;
            this.tickSpeedMultiplier = Math.max(1, 420 / this.tickMs);
        }

        if (msg.rp) {
            for (const id of msg.rp) {
                this.players.delete(id);
            }
        }
        if (msg.rn) {
            for (const id of msg.rn) {
                this.npcs.delete(id);
            }
        }
        if (msg.p) {
            for (const record of msg.p) {
                this.applyPlayer(record);
            }
        }
        if (msg.n) {
            for (const record of msg.n) {
                this.applyNpc(record);
            }
        }
    }

    applyRoster(msg: FeedRoster): void {
        this.rosterPlayers = msg.p;
        this.rosterNpcCount = msg.npcs;
        this.rosterTick = msg.k;
    }

    getEntity(faceIndex: number): LiveEntity | undefined {
        if (faceIndex >= 32768) {
            return this.players.get(faceIndex - 32768);
        }
        return this.npcs.get(faceIndex);
    }

    findPlayer(name: string): LivePlayer | undefined {
        const lower = name.toLowerCase();
        for (const player of this.players.values()) {
            if (player.name.toLowerCase() === lower) {
                return player;
            }
        }
        return undefined;
    }

    private applyPlayer(record: FeedEntity): void {
        let player = this.players.get(record.i);
        const isNew = record.f === 1 || !player;
        if (isNew) {
            player = new LivePlayer(record.i);
            this.players.set(record.i, player);
        }
        if (!player) {
            return;
        }
        if (record.ap) {
            player.setAppearance(decodePlayerAppearance(base64ToBytes(record.ap)));
        }
        this.applyMovement(player, record, isNew);
        this.applyMasks(player, record, true);
    }

    private applyNpc(record: FeedEntity): void {
        let npc = this.npcs.get(record.i);
        const isNew = record.f === 1 || !npc;
        if (isNew) {
            npc = new LiveNpc(record.i);
            this.npcs.set(record.i, npc);
        }
        if (!npc) {
            return;
        }
        if (record.t !== undefined) {
            npc.setType(this.npcTypeLoader.load(record.t));
        }
        if (!npc.npcType) {
            this.npcs.delete(record.i);
            return;
        }
        this.applyMovement(npc, record, isNew);
        this.applyMasks(npc, record, false);
    }

    private applyMovement(e: LiveEntity, record: FeedEntity, isNew: boolean): void {
        if (record.l !== undefined) {
            e.level = record.l;
        }
        if (record.x === undefined || record.z === undefined) {
            return;
        }
        if (isNew) {
            e.teleport(true, record.x, record.z, false);
            if (record.fs) {
                // First sight: face the server-side orientation immediately.
                this.faceSquare(e, record.fs[0], record.fs[1]);
                e.yaw = e.dstYaw;
            }
            return;
        }

        if (record.m) {
            // Steps are relative to where the server had the entity last tick; if this view
            // disagrees (missed ticks), catch up to that origin first.
            let originX = record.x;
            let originZ = record.z;
            for (const dir of record.m) {
                originX -= DIRECTION_DELTA_X[dir];
                originZ -= DIRECTION_DELTA_Z[dir];
            }
            if (e.routeX[0] !== originX || e.routeZ[0] !== originZ) {
                e.teleport(false, originX, originZ, this.abortsOnMove(e));
            }
            const running = record.m.length > 1;
            for (const dir of record.m) {
                e.moveCode(running, dir, this.abortsOnMove(e));
            }
        } else {
            e.teleport(record.tp === 2, record.x, record.z, this.abortsOnMove(e));
        }
    }

    private applyMasks(e: LiveEntity, record: FeedEntity, isPlayer: boolean): void {
        const loopCycle = this.loopCycle;

        if (record.an) {
            this.applyAnim(e, record.an[0], record.an[1]);
        }

        if (record.fe !== undefined) {
            e.faceEntity = record.fe === 65535 ? -1 : record.fe;
        }

        if (record.sy) {
            e.chatMessage = record.sy;
            e.chatColour = 0;
            e.chatEffect = 0;
            e.chatTimer = isPlayer ? 150 : 100;
        }

        if (record.ch) {
            e.chatMessage = record.ch;
            e.chatColour = record.cc?.[0] ?? 0;
            e.chatEffect = record.cc?.[1] ?? 0;
            e.chatTimer = 150;
        }

        if (record.hm) {
            for (const [damage, type] of record.hm) {
                e.addHitmark(loopCycle, type, damage);
            }
            e.combatCycle = loopCycle + 400;
            if (record.hp) {
                e.health = record.hp[0];
                e.totalHealth = record.hp[1];
            }
        }

        if (record.fs && record.f !== 1) {
            e.faceSquareX = record.fs[0];
            e.faceSquareZ = record.fs[1];
        }

        if (record.sp) {
            const [id, height, delay] = record.sp;
            e.spotanimId = id === 65535 ? -1 : id;
            e.spotanimHeight = height;
            e.spotanimLastCycle = loopCycle + delay;
            e.spotanimFrame = 0;
            e.spotanimCycle = 0;
            if (e.spotanimLastCycle > loopCycle) {
                e.spotanimFrame = -1;
            }
        }

        if (record.em) {
            e.exactStartX = record.em[0];
            e.exactStartZ = record.em[1];
            e.exactEndX = record.em[2];
            e.exactEndZ = record.em[3];
            // The client names these the other way round (exactMoveEnd is the start cycle).
            e.exactMoveEnd = record.em[4] + loopCycle;
            e.exactMoveStart = record.em[5] + loopCycle;
            e.exactMoveFacing = record.em[6];
            e.abortRoute();
        }
    }

    private applyAnim(e: LiveEntity, seqId: number, delay: number): void {
        if (seqId === 65535) {
            seqId = -1;
        }
        if (seqId === e.primaryAnim) {
            e.primaryAnimLoop = 0;
        }
        if (e.primaryAnim === seqId && seqId !== -1) {
            const restartMode = this.seqTypeLoader.load(seqId).replyMode;
            if (restartMode === DUPLICATE_RESET) {
                e.primaryAnimFrame = 0;
                e.primaryAnimCycle = 0;
                e.primaryAnimDelay = delay;
                e.primaryAnimLoop = 0;
            } else if (restartMode === DUPLICATE_RESETLOOP) {
                e.primaryAnimLoop = 0;
            }
        } else if (
            seqId === -1 ||
            e.primaryAnim === -1 ||
            this.seqTypeLoader.load(seqId).forcedPriority >=
                this.seqTypeLoader.load(e.primaryAnim).forcedPriority
        ) {
            e.primaryAnim = seqId;
            e.primaryAnimFrame = 0;
            e.primaryAnimCycle = 0;
            e.primaryAnimDelay = delay;
            e.primaryAnimLoop = 0;
            e.preanimRouteLength = e.routeLength;
        }
    }

    private abortsOnMove(e: LiveEntity): boolean {
        return (
            e.primaryAnim !== -1 &&
            getPostanimMove(this.seqTypeLoader.load(e.primaryAnim)) === SeqMove.ABORTANIM
        );
    }

    private faceSquare(e: LiveEntity, fineX: number, fineZ: number): void {
        const dstX = e.x - fineX * 64;
        const dstZ = e.z - fineZ * 64;
        if (dstX !== 0 || dstZ !== 0) {
            e.dstYaw = ((Math.atan2(dstX, dstZ) * 325.949) | 0) & 0x7ff;
        }
    }

    // One 20ms client cycle.
    cycle(): void {
        this.loopCycle++;
        for (const player of this.players.values()) {
            this.moveEntity(player);
        }
        for (const npc of this.npcs.values()) {
            this.moveEntity(npc);
        }
    }

    private moveEntity(e: LiveEntity): void {
        if (e.exactMoveEnd > this.loopCycle) {
            this.exactMove1(e);
        } else if (e.exactMoveStart >= this.loopCycle) {
            this.exactMove2(e);
        } else {
            this.routeMove(e);
        }
        this.entityFace(e);
        this.entityAnim(e);
        if (e.chatTimer > 0) {
            e.chatTimer--;
        }
    }

    private exactMove1(e: LiveEntity): void {
        const delta = e.exactMoveEnd - this.loopCycle;
        const dstX = e.exactStartX * 128 + e.size * 64;
        const dstZ = e.exactStartZ * 128 + e.size * 64;
        e.x += ((dstX - e.x) / delta) | 0;
        e.z += ((dstZ - e.z) / delta) | 0;
        e.animDelayMove = 0;
        e.dstYaw = EXACT_MOVE_YAW[e.exactMoveFacing & 3];
    }

    private exactMove2(e: LiveEntity): void {
        if (
            e.exactMoveStart === this.loopCycle ||
            e.primaryAnim === -1 ||
            e.primaryAnimDelay !== 0 ||
            e.primaryAnimCycle + 1 > this.getFrameDelay(this.seqTypeLoader.load(e.primaryAnim), e.primaryAnimFrame)
        ) {
            const duration = e.exactMoveStart - e.exactMoveEnd;
            const delta = this.loopCycle - e.exactMoveEnd;
            const x0 = e.exactStartX * 128 + e.size * 64;
            const z0 = e.exactStartZ * 128 + e.size * 64;
            const x1 = e.exactEndX * 128 + e.size * 64;
            const z1 = e.exactEndZ * 128 + e.size * 64;
            e.x = ((x0 * (duration - delta) + x1 * delta) / duration) | 0;
            e.z = ((z0 * (duration - delta) + z1 * delta) / duration) | 0;
        }
        e.animDelayMove = 0;
        e.dstYaw = EXACT_MOVE_YAW[e.exactMoveFacing & 3];
        e.yaw = e.dstYaw;
    }

    private routeMove(e: LiveEntity): void {
        e.secondaryAnim = e.readyanim;

        if (e.routeLength === 0) {
            e.animDelayMove = 0;
            return;
        }

        if (e.primaryAnim !== -1 && e.primaryAnimDelay === 0) {
            const seq = this.seqTypeLoader.load(e.primaryAnim);
            if (e.preanimRouteLength > 0 && getPreanimMove(seq) === SeqMove.DELAYMOVE) {
                e.animDelayMove++;
                return;
            }
            if (e.preanimRouteLength <= 0 && getPostanimMove(seq) === SeqMove.DELAYMOVE) {
                e.animDelayMove++;
                return;
            }
        }

        const x = e.x;
        const z = e.z;
        const dstX = e.routeX[e.routeLength - 1] * 128 + e.size * 64;
        const dstZ = e.routeZ[e.routeLength - 1] * 128 + e.size * 64;

        if (dstX - x > 256 || dstX - x < -256 || dstZ - z > 256 || dstZ - z < -256) {
            e.x = dstX;
            e.z = dstZ;
            return;
        }

        if (x < dstX) {
            if (z < dstZ) {
                e.dstYaw = 1280;
            } else if (z > dstZ) {
                e.dstYaw = 1792;
            } else {
                e.dstYaw = 1536;
            }
        } else if (x > dstX) {
            if (z < dstZ) {
                e.dstYaw = 768;
            } else if (z > dstZ) {
                e.dstYaw = 256;
            } else {
                e.dstYaw = 512;
            }
        } else if (z < dstZ) {
            e.dstYaw = 1024;
        } else {
            e.dstYaw = 0;
        }

        let deltaYaw = (e.dstYaw - e.yaw) & 0x7ff;
        if (deltaYaw > 1024) {
            deltaYaw -= 2048;
        }

        let seqId = e.walkanim_b;
        if (deltaYaw >= -256 && deltaYaw <= 256) {
            seqId = e.walkanim;
        } else if (deltaYaw >= 256 && deltaYaw < 768) {
            seqId = e.walkanim_r;
        } else if (deltaYaw >= -768 && deltaYaw <= -256) {
            seqId = e.walkanim_l;
        }
        if (seqId === -1) {
            seqId = e.walkanim;
        }
        e.secondaryAnim = seqId;

        let moveSpeed = 4;
        if (e.yaw !== e.dstYaw && e.faceEntity === -1 && e.turnspeed !== 0) {
            moveSpeed = 2;
        }
        if (e.routeLength > 2) {
            moveSpeed = 6;
        }
        if (e.routeLength > 3) {
            moveSpeed = 8;
        }
        if (e.animDelayMove > 0 && e.routeLength > 1) {
            moveSpeed = 8;
            e.animDelayMove--;
        }
        if (e.routeRun[e.routeLength - 1]) {
            moveSpeed <<= 1;
        }
        if (moveSpeed >= 8 && e.secondaryAnim === e.walkanim && e.runanim !== -1) {
            e.secondaryAnim = e.runanim;
        }

        moveSpeed = Math.ceil(moveSpeed * this.tickSpeedMultiplier);

        if (x < dstX) {
            e.x = Math.min(e.x + moveSpeed, dstX);
        } else if (x > dstX) {
            e.x = Math.max(e.x - moveSpeed, dstX);
        }
        if (z < dstZ) {
            e.z = Math.min(e.z + moveSpeed, dstZ);
        } else if (z > dstZ) {
            e.z = Math.max(e.z - moveSpeed, dstZ);
        }

        if (e.x === dstX && e.z === dstZ) {
            e.routeLength--;
            if (e.preanimRouteLength > 0) {
                e.preanimRouteLength--;
            }
        }
    }

    private entityFace(e: LiveEntity): void {
        if (e.turnspeed === 0) {
            return;
        }

        if (e.faceEntity !== -1) {
            const target = this.getEntity(e.faceEntity);
            if (target && target.level === e.level) {
                const dstX = e.x - target.x;
                const dstZ = e.z - target.z;
                if (dstX !== 0 || dstZ !== 0) {
                    e.dstYaw = ((Math.atan2(dstX, dstZ) * 325.949) | 0) & 0x7ff;
                }
            }
        }

        if ((e.faceSquareX !== 0 || e.faceSquareZ !== 0) && (e.routeLength === 0 || e.animDelayMove > 0)) {
            this.faceSquare(e, e.faceSquareX, e.faceSquareZ);
            e.faceSquareX = 0;
            e.faceSquareZ = 0;
        }

        const turnSpeed = Math.ceil(e.turnspeed * this.tickSpeedMultiplier);
        const remainingYaw = (e.dstYaw - e.yaw) & 0x7ff;
        if (remainingYaw !== 0) {
            if (remainingYaw < turnSpeed || remainingYaw > 2048 - turnSpeed) {
                e.yaw = e.dstYaw;
            } else if (remainingYaw > 1024) {
                e.yaw -= turnSpeed;
            } else {
                e.yaw += turnSpeed;
            }
            e.yaw &= 0x7ff;

            if (e.secondaryAnim === e.readyanim && e.yaw !== e.dstYaw) {
                e.secondaryAnim = e.turnanim !== -1 ? e.turnanim : e.walkanim;
            }
        }
    }

    private entityAnim(e: LiveEntity): void {
        const animSpeed = Math.ceil(this.tickSpeedMultiplier);

        if (e.secondaryAnim !== -1) {
            const seq = this.seqTypeLoader.load(e.secondaryAnim);
            const frameCount = getFrameCount(seq);
            e.secondaryAnimCycle += animSpeed;
            if (e.secondaryAnimFrame < frameCount && e.secondaryAnimCycle > this.getFrameDelay(seq, e.secondaryAnimFrame)) {
                e.secondaryAnimCycle = 0;
                e.secondaryAnimFrame++;
            }
            if (e.secondaryAnimFrame >= frameCount) {
                e.secondaryAnimCycle = 0;
                e.secondaryAnimFrame = 0;
            }
        }

        if (e.spotanimId !== -1 && this.loopCycle >= e.spotanimLastCycle) {
            if (e.spotanimFrame < 0) {
                e.spotanimFrame = 0;
            }
            const spot = this.spotAnimTypeLoader?.load(e.spotanimId);
            const seq = spot && spot.sequenceId !== -1 ? this.seqTypeLoader.load(spot.sequenceId) : undefined;
            e.spotanimCycle += animSpeed;
            if (seq) {
                const frameCount = getFrameCount(seq);
                while (e.spotanimFrame < frameCount && e.spotanimCycle > this.getFrameDelay(seq, e.spotanimFrame)) {
                    e.spotanimCycle -= this.getFrameDelay(seq, e.spotanimFrame);
                    e.spotanimFrame++;
                }
                if (e.spotanimFrame >= frameCount) {
                    e.spotanimId = -1;
                }
            } else {
                e.spotanimId = -1;
            }
        }

        if (e.primaryAnim !== -1 && e.primaryAnimDelay <= 1) {
            const seq = this.seqTypeLoader.load(e.primaryAnim);
            if (
                getPreanimMove(seq) === SeqMove.DELAYANIM &&
                e.preanimRouteLength > 0 &&
                this.loopCycle >= e.exactMoveStart &&
                this.loopCycle > e.exactMoveEnd
            ) {
                e.primaryAnimDelay = 1;
                return;
            }
        }

        if (e.primaryAnim !== -1 && e.primaryAnimDelay === 0) {
            const seq = this.seqTypeLoader.load(e.primaryAnim);
            const frameCount = getFrameCount(seq);
            e.primaryAnimCycle += animSpeed;
            while (e.primaryAnimFrame < frameCount && e.primaryAnimCycle > this.getFrameDelay(seq, e.primaryAnimFrame)) {
                e.primaryAnimCycle -= this.getFrameDelay(seq, e.primaryAnimFrame);
                e.primaryAnimFrame++;
            }
            if (e.primaryAnimFrame >= frameCount) {
                e.primaryAnimFrame -= seq.frameStep;
                e.primaryAnimLoop++;
                if (e.primaryAnimLoop >= seq.maxLoops) {
                    e.primaryAnim = -1;
                }
                if (e.primaryAnimFrame < 0 || e.primaryAnimFrame >= frameCount) {
                    e.primaryAnim = -1;
                }
            }
        }

        if (e.primaryAnimDelay > 0) {
            e.primaryAnimDelay = Math.max(e.primaryAnimDelay - animSpeed, 0);
        }
    }

    private getFrameDelay(seq: SeqType, frame: number): number {
        if (!seq.frameIds || frame < 0 || frame >= seq.frameIds.length) {
            return 1;
        }
        return seq.getFrameLength(this.seqFrameLoader, frame);
    }
}

const EXACT_MOVE_YAW = [1024, 1536, 0, 512];

function getFrameCount(seq: SeqType): number {
    return seq.frameIds?.length ?? 0;
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}
