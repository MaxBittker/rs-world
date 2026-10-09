// Player appearance as the rev 289 client decodes it from the player_info APPEARANCE block.
// Mirrors rs-sdk server/webclient/src/dash3d/ClientPlayer.ts setAppearance(), so the viewer
// builds exactly the body the game client would.

export type PlayerAppearance = {
    gender: number;
    headIcons: number;
    // 12 body slots: 0 = empty, 0x100 + idk id = identity kit, 0x200 + obj id = worn object.
    parts: number[];
    // Npc type id when the player is transmogrified (slot 0 = 0xffff), else -1.
    transmog: number;
    // Indexes into PLAYER_RECOL_1D per slot (hair, torso, legs, feet, skin).
    colours: number[];
    readyAnim: number;
    turnAnim: number;
    walkAnim: number;
    walkAnimB: number;
    walkAnimL: number;
    walkAnimR: number;
    runAnim: number;
    name: string;
    combatLevel: number;
    skillLevel: number;
};

// Colour tables from the client: slot colour c recolours table[0] -> table[c]. The torso
// colour additionally recolours PLAYER_RECOL_2D[0] -> PLAYER_RECOL_2D[c].
// prettier-ignore
export const PLAYER_RECOL_2D: number[] = [
    9104, 10275, 7595, 3610, 7975, 8526, 918, 38802, 24466, 10145, 58654, 5027, 1457, 16565,
    34991, 25486,
];

// prettier-ignore
export const PLAYER_RECOL_1D: number[][] = [
    // hair
    [6798, 107, 10283, 16, 4797, 7744, 5799, 4634, 33697, 22433, 2983, 54193],
    // torso
    [8741, 12, 64030, 43162, 7735, 8404, 1701, 38430, 24094, 10153, 56621, 4783, 1341, 16578,
        35003, 25239],
    // legs
    [25238, 8742, 12, 64030, 43162, 7735, 8404, 1701, 38430, 24094, 10153, 56621, 4783, 1341,
        16578, 35003],
    // feet
    [4626, 11146, 6439, 12, 4758, 10270],
    // skin
    [4550, 4537, 5681, 5673, 5790, 6806, 8076, 4574],
];

const BASE37_CHARS = "_abcdefghijklmnopqrstuvwxyz0123456789";

export function base37ToName(value: bigint): string {
    if (value <= 0n || value >= 6582952005840035281n) {
        return "invalid_name";
    }
    if (value % 37n === 0n) {
        return "invalid_name";
    }
    let name = "";
    while (value !== 0n) {
        const index = Number(value % 37n);
        value /= 37n;
        name = BASE37_CHARS[index] + name;
    }
    return name;
}

export function toDisplayName(raw: string): string {
    return raw
        .split("_")
        .filter((part) => part.length > 0)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(" ");
}

class Reader {
    pos = 0;

    constructor(readonly data: Uint8Array) {}

    g1(): number {
        return this.data[this.pos++];
    }

    g2(): number {
        const value = (this.data[this.pos] << 8) | this.data[this.pos + 1];
        this.pos += 2;
        return value;
    }

    g8(): bigint {
        let value = 0n;
        for (let i = 0; i < 8; i++) {
            value = (value << 8n) | BigInt(this.data[this.pos++]);
        }
        return value;
    }
}

function anim(value: number): number {
    return value === 0xffff ? -1 : value;
}

export function decodePlayerAppearance(data: Uint8Array): PlayerAppearance {
    const buf = new Reader(data);

    const gender = buf.g1();
    const headIcons = buf.g1();

    const parts = new Array<number>(12).fill(0);
    let transmog = -1;
    for (let part = 0; part < 12; part++) {
        const msb = buf.g1();
        if (msb === 0) {
            continue;
        }
        parts[part] = (msb << 8) + buf.g1();
        if (part === 0 && parts[0] === 0xffff) {
            transmog = buf.g2();
            break;
        }
    }

    const colours = new Array<number>(5);
    for (let part = 0; part < 5; part++) {
        let colour = buf.g1();
        if (colour < 0 || colour >= PLAYER_RECOL_1D[part].length) {
            colour = 0;
        }
        colours[part] = colour;
    }

    const readyAnim = anim(buf.g2());
    const turnAnim = anim(buf.g2());
    const walkAnim = anim(buf.g2());
    const walkAnimB = anim(buf.g2());
    const walkAnimL = anim(buf.g2());
    const walkAnimR = anim(buf.g2());
    const runAnim = anim(buf.g2());

    const name = toDisplayName(base37ToName(buf.g8()));
    const combatLevel = buf.g1();
    const skillLevel = buf.g2();

    return {
        gender,
        headIcons,
        parts,
        transmog,
        colours,
        readyAnim,
        turnAnim,
        walkAnim,
        walkAnimB,
        walkAnimL,
        walkAnimR,
        runAnim,
        name,
        combatLevel,
        skillLevel,
    };
}

// Identifies the body (not the animations) so identical-looking players share baked models.
export function getAppearanceModelKey(appearance: PlayerAppearance): string {
    if (appearance.transmog !== -1) {
        return "t" + appearance.transmog;
    }
    return appearance.gender + ":" + appearance.parts.join(",") + ":" + appearance.colours.join(",");
}
