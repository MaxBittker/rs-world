import { PlayerAppearance, getAppearanceModelKey } from "./PlayerAppearance";
import { RosterPlayer } from "./protocol";

// A roster position change bigger than this is a teleport: jump instead of gliding.
const MAX_GLIDE_TILES = 12;

// One online player as the roster has them, in fine units at the tile centre.
export type FarPlayer = {
    slot: number;
    name: string;
    level: number;
    combatLevel: number;
    fromX: number;
    fromZ: number;
    toX: number;
    toZ: number;
    yaw: number;
    rosterTick: number;
};

// The engine's starting body (Player.body) in default colours, with the unarmed anims. Far
// players are a few pixels tall, so they all share it: one baked page per anim for everyone.
export const FAR_PLAYER_APPEARANCE: PlayerAppearance = {
    gender: 0,
    headIcons: 0,
    parts: [0, 0, 0, 0, 0x100 + 18, 0, 0x100 + 26, 0x100 + 36, 0x100 + 0, 0x100 + 33, 0x100 + 42, 0x100 + 10],
    transmog: -1,
    colours: [0, 0, 0, 0, 0],
    readyAnim: 808,
    turnAnim: 823,
    walkAnim: 819,
    walkAnimB: 820,
    walkAnimL: 821,
    walkAnimR: 822,
    runAnim: 824,
    name: "",
    combatLevel: 0,
    skillLevel: 0,
};
export const FAR_PLAYER_MODEL_KEY = getAppearanceModelKey(FAR_PLAYER_APPEARANCE);

// Every online player from the roster (sent every few ticks), so players outside the streamed
// area can still be drawn. Each roster update glides them from where they were drawn to the new
// tile over one roster interval, so they move instead of jumping.
export class FarPlayers {
    players: Map<number, FarPlayer> = new Map();

    private glideStartCycle: number = 0;
    private lastRosterCycle: number = -1;
    // Client cycles between roster updates (5 ticks), measured.
    private intervalCycles: number = 150;

    update(roster: RosterPlayer[], rosterTick: number, loopCycle: number): void {
        if (this.lastRosterCycle !== -1) {
            const measured = loopCycle - this.lastRosterCycle;
            if (measured > 0 && measured < 1000) {
                this.intervalCycles = this.intervalCycles * 0.7 + measured * 0.3;
            }
        }
        this.lastRosterCycle = loopCycle;
        const t = this.getProgress(loopCycle);
        this.glideStartCycle = loopCycle;

        for (const [slot, name, tileX, tileZ, level, combatLevel] of roster) {
            const x = tileX * 128 + 64;
            const z = tileZ * 128 + 64;
            const p = this.players.get(slot);
            if (!p || p.name !== name) {
                this.players.set(slot, { slot, name, level, combatLevel, fromX: x, fromZ: z, toX: x, toZ: z, yaw: 0, rosterTick });
                continue;
            }
            p.combatLevel = combatLevel;
            const curX = p.fromX + (p.toX - p.fromX) * t;
            const curZ = p.fromZ + (p.toZ - p.fromZ) * t;
            const far = Math.abs(x - curX) > MAX_GLIDE_TILES * 128 || Math.abs(z - curZ) > MAX_GLIDE_TILES * 128;
            p.fromX = far || p.level !== level ? x : curX;
            p.fromZ = far || p.level !== level ? z : curZ;
            p.toX = x;
            p.toZ = z;
            p.level = level;
            p.rosterTick = rosterTick;
            if (p.fromX !== x || p.fromZ !== z) {
                // Same convention as moving entities: 0 faces south, 512 west, 1024 north.
                p.yaw = Math.round((Math.atan2(p.fromX - x, p.fromZ - z) * 1024) / Math.PI) & 2047;
            }
        }

        for (const [slot, p] of this.players) {
            if (p.rosterTick !== rosterTick) {
                this.players.delete(slot);
            }
        }
    }

    clear(): void {
        this.players.clear();
        this.lastRosterCycle = -1;
    }

    // How far through the current glide (0..1).
    getProgress(loopCycle: number): number {
        return Math.min(Math.max((loopCycle - this.glideStartCycle) / this.intervalCycles, 0), 1);
    }

    isMoving(p: FarPlayer, t: number): boolean {
        return t < 1 && (p.fromX !== p.toX || p.fromZ !== p.toZ);
    }
}
