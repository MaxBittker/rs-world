import { LocTypeLoader } from "../../../rs/config/loctype/LocTypeLoader";
import { SceneLoc } from "../../../rs/scene/SceneLoc";
import { getIdFromTag } from "../../../rs/scene/entity/EntityTag";
import { DrawCommand, SceneBuffer, SceneModel } from "../buffer/SceneBuffer";

// The client's LOC_SHAPE_TO_LAYER: wall, wall decor, ground (scenery), ground decor.
export const LOC_SHAPE_TO_LAYER = [
    0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3,
];
export const LOC_LAYER_GROUND = 2;

// Where each static loc of a map square ended up in its GPU data, so live zone state (a fire
// replacing nothing, a stump replacing a tree, an opened door) can hide it without rebuilding the
// square. Instanced models are hidden through their instance texel in one of the 8 model info
// textures; merged models through their range in the index buffer.
export const LOC_REF_INDEX_RANGE = 8;
// Ints per ref.
export const LOC_REF_SIZE = 4;

export type SdLocTable = {
    // Sorted local keys (see getLocalLocKey), one per tile and layer.
    keys: Int32Array;
    // Per loc: [id | shape << 16 | angle << 21, obj raise (height of a table's top)].
    info: Int32Array;
    // Per loc, its refs are refs[refStart[i] * LOC_REF_SIZE .. refStart[i + 1] * LOC_REF_SIZE].
    refStart: Int32Array;
    // [kind, a, b, c]: kind 0..7 = model info texture (normal, alpha, lod, lod alpha, interact,
    // interact alpha, interact lod, interact lod alpha) with a = texel index; kind 8 = index range
    // with a = byte offset, b = element count and c = where its original indices start in
    // rangeIndices (-1: not kept).
    refs: Int32Array;
    // The original indices of the merged ranges of locs with an op (doors, gates, trees, rocks:
    // the locs the game changes), so hiding and showing them needs no GPU readback.
    rangeIndices: Int32Array;
};

export function getLocalLocKey(
    level: number,
    layer: number,
    localX: number,
    localZ: number,
): number {
    return (level << 14) | (layer << 12) | (localX << 6) | localZ;
}

export function packLocInfo(id: number, shape: number, angle: number): number {
    return id | (shape << 16) | (angle << 21);
}

export function findLoc(table: SdLocTable, key: number): number {
    const keys = table.keys;
    let lo = 0;
    let hi = keys.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const k = keys[mid];
        if (k < key) {
            lo = mid + 1;
        } else if (k > key) {
            hi = mid - 1;
        } else {
            return mid;
        }
    }
    return -1;
}

type LocEntry = { info: number; raise: number; refs: number[] };

export function createLocTable(
    locTypeLoader: LocTypeLoader,
    sceneBuf: SceneBuffer,
    borderSize: number,
    commandLists: DrawCommand[][],
): SdLocTable {
    const entries = new Map<number, LocEntry>();

    const getEntry = (
        sceneLoc: SceneLoc,
        level: number,
        model?: SceneModel,
    ): LocEntry | undefined => {
        const tag = sceneLoc.tag;
        const localX = Number(tag & 0x7fn) - borderSize;
        const localZ = Number((tag >> 7n) & 0x7fn) - borderSize;
        if (localX < 0 || localZ < 0 || localX >= 64 || localZ >= 64) {
            return undefined;
        }
        const shape = sceneLoc.flags & 0x3f;
        const angle = (sceneLoc.flags >> 6) & 0x3;
        const layer = LOC_SHAPE_TO_LAYER[shape] ?? LOC_LAYER_GROUND;
        const key = getLocalLocKey(level & 0x3, layer, localX, localZ);
        let entry = entries.get(key);
        if (!entry) {
            const id = getIdFromTag(tag);
            entry = { info: packLocInfo(id, shape, angle), raise: 0, refs: [] };
            entries.set(key, entry);
        }
        if (model && layer === LOC_LAYER_GROUND && entry.raise === 0) {
            const locType = locTypeLoader.load(getIdFromTag(tag));
            if (locType.supportItems === 1) {
                entry.raise = getModelHeight(model);
            }
        }
        return entry;
    };

    for (let kind = 0; kind < commandLists.length; kind++) {
        const commands = commandLists[kind];
        // Same layout as createModelInfoTextureData: one texel per command, then the instances.
        let texel = commands.length;
        for (const command of commands) {
            for (const instance of command.instances) {
                const sceneLoc = (instance as { sceneLoc?: SceneLoc }).sceneLoc;
                if (sceneLoc) {
                    const model = "model" in instance ? (instance as SceneModel) : undefined;
                    getEntry(sceneLoc, instance.level, model)?.refs.push(kind, texel, 0, 0);
                }
                texel++;
            }
        }
    }

    const indices = sceneBuf.indices;
    const kept: number[] = [];
    for (const [sceneModel, offset, elements] of sceneBuf.mergedLocRanges) {
        const sceneLoc = sceneModel.sceneLoc!;
        const entry = getEntry(sceneLoc, sceneModel.level, sceneModel);
        if (!entry) {
            continue;
        }
        let start = -1;
        if (hasOp(locTypeLoader, getIdFromTag(sceneLoc.tag))) {
            start = kept.length;
            const first = offset / 4;
            for (let i = 0; i < elements; i++) {
                kept.push(indices[first + i]);
            }
        }
        entry.refs.push(LOC_REF_INDEX_RANGE, offset, elements, start);
    }

    const keys = Int32Array.from(entries.keys()).sort();
    const info = new Int32Array(keys.length * 2);
    const refStart = new Int32Array(keys.length + 1);
    let refCount = 0;
    for (const entry of entries.values()) {
        refCount += entry.refs.length / LOC_REF_SIZE;
    }
    const refs = new Int32Array(refCount * LOC_REF_SIZE);
    let ref = 0;
    for (let i = 0; i < keys.length; i++) {
        const entry = entries.get(keys[i])!;
        info[i * 2] = entry.info;
        info[i * 2 + 1] = entry.raise;
        refStart[i] = ref;
        refs.set(entry.refs, ref * LOC_REF_SIZE);
        ref += entry.refs.length / LOC_REF_SIZE;
    }
    refStart[keys.length] = ref;

    return { keys, info, refStart, refs, rangeIndices: Int32Array.from(kept) };
}

function hasOp(locTypeLoader: LocTypeLoader, id: number): boolean {
    const actions = locTypeLoader.load(id).actions;
    for (let i = 0; i < actions.length; i++) {
        if (actions[i]) {
            return true;
        }
    }
    return false;
}

function getModelHeight(sceneModel: SceneModel): number {
    const model = sceneModel.model;
    let minY = 0;
    for (let i = 0; i < model.verticesCount; i++) {
        if (model.verticesY[i] < minY) {
            minY = model.verticesY[i];
        }
    }
    return -minY;
}
