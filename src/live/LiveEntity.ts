import { NpcType } from "../rs/config/npctype/NpcType";
import { SeqType } from "../rs/config/seqtype/SeqType";
import { PlayerAppearance, getAppearanceModelKey } from "./PlayerAppearance";

// Seq movement interaction (SeqType preanim_move / postanim_move in the 289 client).
export const enum SeqMove {
    DELAYMOVE = 0,
    DELAYANIM = 1, // preanim only
    ABORTANIM = 1, // postanim only
    MERGE = 2,
}

export function getPreanimMove(seq: SeqType): number {
    if (seq.precedenceAnimating !== -1) {
        return seq.precedenceAnimating;
    }
    return seq.masks ? SeqMove.MERGE : SeqMove.DELAYMOVE;
}

export function getPostanimMove(seq: SeqType): number {
    if (seq.priority !== -1) {
        return seq.priority;
    }
    return seq.masks ? SeqMove.MERGE : SeqMove.DELAYMOVE;
}

// Client-side state of one player or npc, mirroring ClientEntity in the rs-sdk webclient.
// Coordinates are absolute: route in tiles, x/z in fine units (1/128 tile) at the entity centre.
export abstract class LiveEntity {
    level: number = 0;
    x: number = 0;
    z: number = 0;
    yaw: number = 0;
    dstYaw: number = 0;
    size: number = 1;
    turnspeed: number = 32;

    readyanim: number = -1;
    turnanim: number = -1;
    walkanim: number = -1;
    walkanim_b: number = -1;
    walkanim_l: number = -1;
    walkanim_r: number = -1;
    runanim: number = -1;

    routeLength: number = 0;
    routeX: Int32Array = new Int32Array(10);
    routeZ: Int32Array = new Int32Array(10);
    routeRun: boolean[] = new Array(10).fill(false);
    animDelayMove: number = 0;
    preanimRouteLength: number = 0;

    primaryAnim: number = -1;
    primaryAnimFrame: number = 0;
    primaryAnimCycle: number = 0;
    primaryAnimDelay: number = 0;
    primaryAnimLoop: number = 0;

    secondaryAnim: number = -1;
    secondaryAnimFrame: number = 0;
    secondaryAnimCycle: number = 0;

    spotanimId: number = -1;
    spotanimFrame: number = 0;
    spotanimCycle: number = 0;
    spotanimLastCycle: number = 0;
    spotanimHeight: number = 0;

    exactStartX: number = 0;
    exactStartZ: number = 0;
    exactEndX: number = 0;
    exactEndZ: number = 0;
    exactMoveEnd: number = 0;
    exactMoveStart: number = 0;
    exactMoveFacing: number = 0;

    faceEntity: number = -1;
    faceSquareX: number = 0;
    faceSquareZ: number = 0;

    chatMessage: string | null = null;
    chatTimer: number = 0;
    chatColour: number = 0;
    chatEffect: number = 0;

    combatCycle: number = -1000;
    health: number = 0;
    totalHealth: number = 0;
    damageValues: Int32Array = new Int32Array(4);
    damageTypes: Int32Array = new Int32Array(4);
    damageCycles: Int32Array = new Int32Array(4);

    // Height of the last rendered frame above the ground (fine units), for overlays.
    height: number = 200;

    constructor(readonly id: number) {}

    abstract getName(): string;

    abstract getCombatLevel(): number;

    getTileX(): number {
        return this.routeX[0];
    }

    getTileZ(): number {
        return this.routeZ[0];
    }

    // Snap (jump) or step to a tile, as the client does for teleports and newly seen entities.
    teleport(jump: boolean, tileX: number, tileZ: number, abortAnim: boolean): void {
        if (abortAnim) {
            this.primaryAnim = -1;
        }

        if (!jump) {
            const dx = tileX - this.routeX[0];
            const dz = tileZ - this.routeZ[0];
            if (dx >= -8 && dx <= 8 && dz >= -8 && dz <= 8) {
                if (this.routeLength < 9) {
                    this.routeLength++;
                }
                for (let i = this.routeLength; i > 0; i--) {
                    this.routeX[i] = this.routeX[i - 1];
                    this.routeZ[i] = this.routeZ[i - 1];
                    this.routeRun[i] = this.routeRun[i - 1];
                }
                this.routeX[0] = tileX;
                this.routeZ[0] = tileZ;
                this.routeRun[0] = false;
                return;
            }
        }

        this.routeLength = 0;
        this.preanimRouteLength = 0;
        this.animDelayMove = 0;
        this.routeX[0] = tileX;
        this.routeZ[0] = tileZ;
        this.x = tileX * 128 + this.size * 64;
        this.z = tileZ * 128 + this.size * 64;
    }

    moveCode(running: boolean, direction: number, abortAnim: boolean): void {
        let nextX = this.routeX[0];
        let nextZ = this.routeZ[0];
        nextX += DIRECTION_DELTA_X[direction];
        nextZ += DIRECTION_DELTA_Z[direction];

        if (abortAnim) {
            this.primaryAnim = -1;
        }

        if (this.routeLength < 9) {
            this.routeLength++;
        }
        for (let i = this.routeLength; i > 0; i--) {
            this.routeX[i] = this.routeX[i - 1];
            this.routeZ[i] = this.routeZ[i - 1];
            this.routeRun[i] = this.routeRun[i - 1];
        }
        this.routeX[0] = nextX;
        this.routeZ[0] = nextZ;
        this.routeRun[0] = running;
    }

    abortRoute(): void {
        this.routeLength = 0;
        this.preanimRouteLength = 0;
    }

    addHitmark(loopCycle: number, type: number, value: number): void {
        for (let i = 0; i < 4; i++) {
            if (this.damageCycles[i] <= loopCycle) {
                this.damageValues[i] = value;
                this.damageTypes[i] = type;
                this.damageCycles[i] = loopCycle + 70;
                return;
            }
        }
    }
}

// Protocol walk directions: NW, N, NE, W, E, SW, S, SE.
export const DIRECTION_DELTA_X = [-1, 0, 1, -1, 1, -1, 0, 1];
export const DIRECTION_DELTA_Z = [1, 1, 1, 0, 0, -1, -1, -1];

export class LivePlayer extends LiveEntity {
    appearance?: PlayerAppearance;
    // Identifies the body for baked-model sharing; empty until the appearance arrives.
    modelKey: string = "";
    // The same body in default colours, shared by distant players when GPU memory is tight.
    lodAppearance?: PlayerAppearance;
    lodModelKey: string = "";
    name: string = "";
    combatLevel: number = 0;

    setAppearance(appearance: PlayerAppearance): void {
        this.appearance = appearance;
        this.modelKey = getAppearanceModelKey(appearance);
        this.lodAppearance = { ...appearance, colours: [0, 0, 0, 0, 0] };
        this.lodModelKey = getAppearanceModelKey(this.lodAppearance);
        this.name = appearance.name;
        this.combatLevel = appearance.combatLevel;
        this.readyanim = appearance.readyAnim;
        this.turnanim = appearance.turnAnim;
        this.walkanim = appearance.walkAnim;
        this.walkanim_b = appearance.walkAnimB;
        this.walkanim_l = appearance.walkAnimL;
        this.walkanim_r = appearance.walkAnimR;
        this.runanim = appearance.runAnim;
    }

    getName(): string {
        return this.name;
    }

    getCombatLevel(): number {
        return this.combatLevel;
    }
}

export class LiveNpc extends LiveEntity {
    npcType!: NpcType;

    setType(npcType: NpcType): void {
        this.npcType = npcType;
        this.size = npcType.size;
        this.turnspeed = npcType.rotationSpeed;
        this.readyanim = npcType.idleSeqId;
        this.walkanim = npcType.walkSeqId;
        this.walkanim_b = npcType.walkBackSeqId;
        // Opcode 17's third/fourth anims; the client stores them crossed, see Client.getNpcPosNewVis.
        this.walkanim_l = npcType.walkLeftSeqId;
        this.walkanim_r = npcType.walkRightSeqId;
        this.turnanim = -1;
        this.runanim = -1;
    }

    getName(): string {
        return this.npcType?.name ?? "null";
    }

    getCombatLevel(): number {
        return this.npcType?.combatLevel ?? -1;
    }
}
