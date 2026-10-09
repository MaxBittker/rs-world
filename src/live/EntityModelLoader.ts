import { TypeLoader } from "../rs/config/TypeLoader";
import { IdkType } from "../rs/config/idktype/IdkType";
import { NpcModelLoader } from "../rs/config/npctype/NpcModelLoader";
import { NpcTypeLoader } from "../rs/config/npctype/NpcTypeLoader";
import { ObjType } from "../rs/config/objtype/ObjType";
import { ObjTypeLoader } from "../rs/config/objtype/ObjTypeLoader";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { SpotAnimType } from "../rs/config/spotanimtype/SpotAnimType";
import { Model } from "../rs/model/Model";
import { ModelData } from "../rs/model/ModelData";
import { ModelLoader } from "../rs/model/ModelLoader";
import { TextureLoader } from "../rs/texture/TextureLoader";
import { DrawRange, NULL_DRAW_RANGE } from "../mapviewer/webgl/DrawRange";
import { SceneBuffer } from "../mapviewer/webgl/buffer/SceneBuffer";
import { PLAYER_RECOL_1D, PLAYER_RECOL_2D, PlayerAppearance } from "./PlayerAppearance";

// What to build a model from. Player bodies are keyed by appearance + held-item overrides so
// identical-looking players share baked frames.
export type EntityModelSpec =
    | { kind: "npc"; npcType: number }
    | { kind: "player"; appearance: PlayerAppearance; leftHand: number; rightHand: number }
    | { kind: "spot"; spotAnim: number };

export type EntityAnimRequest = {
    key: string;
    spec: EntityModelSpec;
    // -1 bakes the unanimated model as a single frame.
    seqId: number;
};

// Every frame of one (model, seq) baked into one vertex/index buffer pair, in the same vertex
// format as map squares so the scene shaders' decoding is reused.
export type EntityAnimData = {
    key: string;
    vertices: Uint8Array;
    indices: Int32Array;
    frames: DrawRange[];
    framesAlpha: DrawRange[] | undefined;
    // Height of each frame above its origin (positive is up), for overhead text and hitsplats.
    frameHeights: Int16Array;
};

export class EntityModelLoader {
    bodyCache: Map<string, Model | undefined> = new Map();

    constructor(
        readonly npcTypeLoader: NpcTypeLoader,
        readonly objTypeLoader: ObjTypeLoader,
        readonly idkTypeLoader: TypeLoader<IdkType>,
        readonly spotAnimTypeLoader: TypeLoader<SpotAnimType>,
        readonly seqTypeLoader: SeqTypeLoader,
        readonly modelLoader: ModelLoader,
        readonly textureLoader: TextureLoader,
        readonly npcModelLoader: NpcModelLoader,
    ) {}

    bake(request: EntityAnimRequest, textureIdIndexMap: Map<number, number>): EntityAnimData {
        const sceneBuf = new SceneBuffer(this.textureLoader, textureIdIndexMap, 4096);

        const seqType = request.seqId !== -1 ? this.seqTypeLoader.load(request.seqId) : undefined;
        const frameCount = seqType?.frameIds?.length ?? 0;

        const models: (Model | undefined)[] = [];
        if (!seqType || frameCount === 0) {
            models.push(this.getModel(request.spec, -1, -1));
        } else {
            for (let frame = 0; frame < frameCount; frame++) {
                models.push(this.getModel(request.spec, request.seqId, frame));
            }
        }

        const frames: DrawRange[] = [];
        const framesAlpha: DrawRange[] = [];
        const frameHeights = new Int16Array(models.length);
        let alphaFrameCount = 0;
        for (let i = 0; i < models.length; i++) {
            const model = models[i];
            if (!model) {
                frames.push(NULL_DRAW_RANGE);
                framesAlpha.push(NULL_DRAW_RANGE);
                continue;
            }
            frames.push(sceneBuf.addModelAnimFrame(model, false));
            const alpha = sceneBuf.addModelAnimFrame(model, true);
            framesAlpha.push(alpha);
            if (alpha[1] > 0) {
                alphaFrameCount++;
            }
            frameHeights[i] = getModelHeight(model);
        }

        return {
            key: request.key,
            vertices: sceneBuf.vertexBuf.byteArray(),
            indices: new Int32Array(sceneBuf.indices),
            frames,
            framesAlpha: alphaFrameCount > 0 ? framesAlpha : undefined,
            frameHeights,
        };
    }

    getModel(spec: EntityModelSpec, seqId: number, frame: number): Model | undefined {
        switch (spec.kind) {
            case "npc": {
                const npcType = this.npcTypeLoader.load(spec.npcType);
                return npcType ? this.npcModelLoader.getModel(npcType, seqId, frame) : undefined;
            }
            case "player": {
                if (spec.appearance.transmog !== -1) {
                    const npcType = this.npcTypeLoader.load(spec.appearance.transmog);
                    return npcType ? this.npcModelLoader.getModel(npcType, seqId, frame) : undefined;
                }
                const body = this.getPlayerBody(spec.appearance, spec.leftHand, spec.rightHand);
                return body ? this.animate(body, seqId, frame) : undefined;
            }
            case "spot":
                return this.getSpotAnimModel(spec.spotAnim, seqId, frame);
        }
    }

    animate(model: Model, seqId: number, frame: number): Model {
        const seqType = seqId !== -1 ? this.seqTypeLoader.load(seqId) : undefined;
        if (!seqType || frame === -1) {
            return model;
        }
        return this.npcModelLoader.transformNpcModel(model, seqType, frame);
    }

    // Port of ClientPlayer.getTempModel2 (rs-sdk webclient): identity kits and worn objects
    // merged, recoloured with the player's 5 colours, lit like the 289 client.
    getPlayerBody(appearance: PlayerAppearance, leftHand: number, rightHand: number): Model | undefined {
        const key = appearance.gender + ":" + appearance.parts.join(",") + ":" + appearance.colours.join(",") + ":" + leftHand + ":" + rightHand;
        if (this.bodyCache.has(key)) {
            return this.bodyCache.get(key);
        }

        const parts: ModelData[] = [];
        for (let slot = 0; slot < 12; slot++) {
            let value = appearance.parts[slot];
            if (rightHand >= 0 && slot === 3) {
                value = rightHand;
            }
            if (leftHand >= 0 && slot === 5) {
                value = leftHand;
            }

            let part: ModelData | undefined;
            if (value >= 0x100 && value < 0x200) {
                part = this.getIdkModel(value - 0x100);
            } else if (value >= 0x200) {
                part = this.getWornModel(this.objTypeLoader.load(value - 0x200), appearance.gender);
            }
            if (part) {
                parts.push(part);
            }
        }

        let model: Model | undefined;
        if (parts.length > 0) {
            const merged = ModelData.merge(parts, parts.length);
            for (let i = 0; i < 5; i++) {
                const colour = appearance.colours[i];
                if (colour === 0) {
                    continue;
                }
                merged.recolor(PLAYER_RECOL_1D[i][0], PLAYER_RECOL_1D[i][colour]);
                if (i === 1) {
                    merged.recolor(PLAYER_RECOL_2D[0], PLAYER_RECOL_2D[colour]);
                }
            }
            model = merged.light(this.textureLoader, 64, 850, -30, -50, -30);
        }

        this.bodyCache.set(key, model);
        return model;
    }

    getIdkModel(id: number): ModelData | undefined {
        const idk = this.idkTypeLoader.load(id);
        if (!idk?.modelIds || idk.modelIds.length === 0) {
            return undefined;
        }
        const models = this.loadModels(idk.modelIds);
        if (!models) {
            return undefined;
        }
        const merged = ModelData.merge(models, models.length);
        if (idk.recolorFrom) {
            for (let i = 0; i < idk.recolorFrom.length; i++) {
                merged.recolor(idk.recolorFrom[i], idk.recolorTo[i]);
            }
        }
        return merged;
    }

    getWornModel(obj: ObjType, gender: number): ModelData | undefined {
        const ids =
            gender === 1
                ? [obj.femaleModel, obj.femaleModel1, obj.femaleModel2]
                : [obj.maleModel, obj.maleModel1, obj.maleModel2];
        if (ids[0] === -1) {
            return undefined;
        }
        const models = this.loadModels(ids.filter((id) => id !== -1));
        if (!models) {
            return undefined;
        }
        const merged = ModelData.merge(models, models.length);
        const offset = gender === 1 ? obj.femaleOffset : obj.maleOffset;
        if (offset !== 0) {
            merged.translate(0, offset, 0);
        }
        if (obj.recolorFrom) {
            for (let i = 0; i < obj.recolorFrom.length; i++) {
                merged.recolor(obj.recolorFrom[i], obj.recolorTo[i]);
            }
        }
        return merged;
    }

    getSpotAnimModel(id: number, seqId: number, frame: number): Model | undefined {
        const spot = this.spotAnimTypeLoader.load(id);
        if (!spot || spot.modelId === undefined) {
            return undefined;
        }
        const key = "spot:" + id;
        let base = this.bodyCache.get(key);
        if (!this.bodyCache.has(key)) {
            const modelData = this.modelLoader.getModel(spot.modelId);
            if (modelData) {
                const copy = ModelData.merge([modelData], 1);
                if (spot.recolorFrom) {
                    for (let i = 0; i < spot.recolorFrom.length; i++) {
                        copy.recolor(spot.recolorFrom[i], spot.recolorTo[i]);
                    }
                }
                base = copy.light(this.textureLoader, spot.ambient + 64, spot.contrast + 850, -30, -50, -30);
            }
            this.bodyCache.set(key, base);
        }
        if (!base) {
            return undefined;
        }
        let model = this.animate(base, seqId, frame);
        if (spot.widthScale !== 128 || spot.heightScale !== 128) {
            if (model === base) {
                model = Model.copyAnimated(base, true, true);
            }
            model.scale(spot.widthScale, spot.heightScale, spot.widthScale);
        }
        return model;
    }

    loadModels(ids: number[]): ModelData[] | undefined {
        const models: ModelData[] = [];
        for (const id of ids) {
            const model = this.modelLoader.getModel(id);
            if (!model) {
                return undefined;
            }
            models.push(model);
        }
        return models;
    }

    clearCache(): void {
        this.bodyCache.clear();
    }
}

function getModelHeight(model: Model): number {
    let minY = 0;
    for (let i = 0; i < model.verticesCount; i++) {
        if (model.verticesY[i] < minY) {
            minY = model.verticesY[i];
        }
    }
    return Math.min(-minY, 0x7fff);
}
