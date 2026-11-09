import { vec2 } from "gl-matrix";
import PicoGL, {
    DrawCall,
    App as PicoApp,
    Program,
    Texture,
    UniformBuffer,
    VertexArray,
    VertexBuffer,
} from "picogl";

import { BasTypeLoader } from "../../rs/config/bastype/BasTypeLoader";
import { NpcTypeLoader } from "../../rs/config/npctype/NpcTypeLoader";
import { SeqTypeLoader } from "../../rs/config/seqtype/SeqTypeLoader";
import { getMapSquareId } from "../../rs/map/MapFileIndex";
import { CollisionFlag } from "../../rs/pathfinder/flag/CollisionFlag";
import { CollisionMap } from "../../rs/scene/CollisionMap";
import { Scene } from "../../rs/scene/Scene";
import { DrawRange, newDrawRange } from "./DrawRange";
import { LOC_REF_INDEX_RANGE, LOC_REF_SIZE, SdLocTable, findLoc } from "./loader/SdLocTable";
import { SdMapData } from "./loader/SdMapData";
import { LocAnimated } from "./loc/LocAnimated";
import { Npc } from "./npc/Npc";

const FRAME_RENDER_DELAY = 3;

const NPC_DATA_TEXTURE_BUFFER_SIZE = 5;

// An instance texel with both coords at 0xffff is drawn nowhere (main.vert.glsl).
const HIDDEN_TEXEL = 0xffff;

// A static loc hidden by live zone state: what its texels held before, and the index ranges
// the loc table has no copy of (read back from the GPU, see readIndices).
type HiddenLoc = {
    texels: number[];
    indices?: Int32Array[];
};

// Degenerate indices to write over a hidden range (grown as needed).
let degenerateIndices = new Int32Array(1024);

// picogl keeps these private; reading an index range back needs them.
type RawVertexBuffer = {
    buffer: WebGLBuffer;
    appState: { vertexArray: unknown };
};

function createModelInfoTexture(app: PicoApp, data: Uint16Array): Texture {
    return app.createTexture2D(data, 16, Math.max(Math.ceil(data.length / 16 / 4), 1), {
        internalFormat: PicoGL.RGBA16UI,
        minFilter: PicoGL.NEAREST,
        magFilter: PicoGL.NEAREST,
    });
}

export type DrawCallRange = {
    drawCall: DrawCall;
    drawRanges: DrawRange[];
};

export class WebGLMapSquare {
    readonly id: number;

    npcDataTextureOffsets: number[];

    heightMapData?: Int16Array;

    // Live zone state: where the static locs are in the GPU data, the CPU copies of the model
    // info textures, and the locs hidden now (by local key, see SdLocTable).
    locTable?: SdLocTable;
    modelTextureDatas?: Uint16Array[];
    hiddenLocs: Map<number, HiddenLoc> = new Map();

    static load(
        seqTypeLoader: SeqTypeLoader,
        npcTypeLoader: NpcTypeLoader,
        basTypeLoader: BasTypeLoader,
        app: PicoApp,
        mainProgram: Program,
        mainAlphaProgram: Program,
        npcProgram: Program,
        textureArray: Texture,
        textureMaterials: Texture,
        sceneUniformBuffer: UniformBuffer,
        mapData: SdMapData,
        time: number,
        frame: number,
    ): WebGLMapSquare {
        const { mapX, mapY, borderSize, tileRenderFlags } = mapData;

        const collisionMaps = mapData.collisionDatas.map(CollisionMap.fromData);

        const mapPos = vec2.fromValues(mapX, mapY);

        const interleavedBuffer = app.createInterleavedBuffer(12, mapData.vertices);
        const indexBuffer = app.createIndexBuffer(PicoGL.UNSIGNED_INT, mapData.indices);

        const vertexArray = app
            .createVertexArray()
            // v0, v1, v2
            .vertexAttributeBuffer(0, interleavedBuffer, {
                type: PicoGL.UNSIGNED_INT,
                size: 3,
                stride: 12,
                integer: true as any,
            })
            .indexBuffer(indexBuffer);

        const modelInfoTexture = createModelInfoTexture(app, mapData.modelTextureData);
        const modelInfoTextureAlpha = createModelInfoTexture(app, mapData.modelTextureDataAlpha);

        const modelInfoTextureLod = createModelInfoTexture(app, mapData.modelTextureDataLod);
        const modelInfoTextureLodAlpha = createModelInfoTexture(
            app,
            mapData.modelTextureDataLodAlpha,
        );

        const modelInfoTextureInteract = createModelInfoTexture(
            app,
            mapData.modelTextureDataInteract,
        );
        const modelInfoTextureInteractAlpha = createModelInfoTexture(
            app,
            mapData.modelTextureDataInteractAlpha,
        );

        const modelInfoTextureInteractLod = createModelInfoTexture(
            app,
            mapData.modelTextureDataInteractLod,
        );
        const modelInfoTextureInteractLodAlpha = createModelInfoTexture(
            app,
            mapData.modelTextureDataInteractLodAlpha,
        );

        const heightMapSize = Scene.MAP_SQUARE_SIZE + borderSize * 2;
        const heightMapTexture = app.createTextureArray(
            mapData.heightMapTextureData,
            heightMapSize,
            heightMapSize,
            Scene.MAX_LEVELS,
            {
                internalFormat: PicoGL.R16I,
                minFilter: PicoGL.NEAREST,
                magFilter: PicoGL.NEAREST,
                type: PicoGL.SHORT,
                wrapS: PicoGL.CLAMP_TO_EDGE,
                wrapT: PicoGL.CLAMP_TO_EDGE,
            },
        );

        // const time = performance.now() * 0.001;

        const createDrawCall = (
            program: Program,
            modelInfoTexture: Texture | undefined,
            drawRanges: DrawRange[],
        ): DrawCallRange => {
            const drawCall = app
                .createDrawCall(program, vertexArray)
                .uniformBlock("SceneUniforms", sceneUniformBuffer)
                .uniform("u_timeLoaded", time)
                .uniform("u_mapPos", mapPos)
                // .uniform("u_drawIdOffset", drawIdOffset)
                .texture("u_textures", textureArray)
                .texture("u_textureMaterials", textureMaterials)
                .texture("u_heightMap", heightMapTexture)
                // .texture("u_modelInfoTexture", modelInfoTexture)
                .drawRanges(...drawRanges);
            if (modelInfoTexture) {
                drawCall.texture("u_modelInfoTexture", modelInfoTexture);
            }
            return {
                drawCall,
                drawRanges,
            };
        };

        const drawCall = createDrawCall(mainProgram, modelInfoTexture, mapData.drawRanges);
        const drawCallAlpha = createDrawCall(
            mainAlphaProgram,
            modelInfoTextureAlpha,
            mapData.drawRangesAlpha,
        );

        const drawCallLod = createDrawCall(mainProgram, modelInfoTextureLod, mapData.drawRangesLod);
        const drawCallLodAlpha = createDrawCall(
            mainAlphaProgram,
            modelInfoTextureLodAlpha,
            mapData.drawRangesLodAlpha,
        );

        const drawCallInteract = createDrawCall(
            mainProgram,
            modelInfoTextureInteract,
            mapData.drawRangesInteract,
        );
        const drawCallInteractAlpha = createDrawCall(
            mainAlphaProgram,
            modelInfoTextureInteractAlpha,
            mapData.drawRangesInteractAlpha,
        );

        const drawCallInteractLod = createDrawCall(
            mainProgram,
            modelInfoTextureInteractLod,
            mapData.drawRangesInteractLod,
        );
        const drawCallInteractLodAlpha = createDrawCall(
            mainAlphaProgram,
            modelInfoTextureInteractLodAlpha,
            mapData.drawRangesInteractLodAlpha,
        );

        const cycle = time / 0.02;

        const locsAnimated: LocAnimated[] = [];
        for (const loc of mapData.locsAnimated) {
            const seqType = seqTypeLoader.load(loc.seqId);
            locsAnimated.push(
                new LocAnimated(
                    loc.drawRangeIndex,
                    loc.drawRangeAlphaIndex,

                    loc.drawRangeLodIndex,
                    loc.drawRangeLodAlphaIndex,

                    loc.drawRangeInteractIndex,
                    loc.drawRangeInteractAlphaIndex,

                    loc.drawRangeInteractLodIndex,
                    loc.drawRangeInteractLodAlphaIndex,

                    loc.anim,
                    seqType,
                    cycle,
                    loc.randomStart,
                ),
            );
        }

        const npcs: Npc[] = [];
        for (const npc of mapData.npcs) {
            const npcType = npcTypeLoader.load(npc.id);

            npcs.push(
                new Npc(
                    npc.tileX,
                    npc.tileY,
                    npc.level,
                    npc.idleAnim,
                    npc.walkAnim,
                    npcType,
                    npcType.getIdleSeqId(basTypeLoader),
                    npcType.getWalkSeqId(basTypeLoader),
                ),
            );
        }

        for (const npc of npcs) {
            const collisionMap = collisionMaps[npc.level];

            const currentX = npc.pathX[0];
            const currentY = npc.pathY[0];

            const size = npc.getSize();

            for (let flagX = currentX; flagX < currentX + size; flagX++) {
                for (let flagY = currentY; flagY < currentY + size; flagY++) {
                    collisionMap.flag(
                        flagX + borderSize,
                        flagY + borderSize,
                        CollisionFlag.BLOCK_NPCS,
                    );
                }
            }
        }

        const drawRangesNpc = npcs.map((_npc) => newDrawRange(0, 0, 1));

        const drawCallNpc = createDrawCall(npcProgram, undefined, drawRangesNpc);

        const square = new WebGLMapSquare(
            mapX,
            mapY,

            borderSize,
            tileRenderFlags,
            collisionMaps,

            time,
            frame,

            interleavedBuffer,
            indexBuffer,
            vertexArray,

            heightMapTexture,

            modelInfoTexture,
            modelInfoTextureAlpha,

            modelInfoTextureLod,
            modelInfoTextureLodAlpha,

            modelInfoTextureInteract,
            modelInfoTextureInteractAlpha,

            modelInfoTextureInteractLod,
            modelInfoTextureInteractLodAlpha,

            drawCall,
            drawCallAlpha,

            drawCallLod,
            drawCallLodAlpha,

            drawCallInteract,
            drawCallInteractAlpha,

            drawCallInteractLod,
            drawCallInteractLodAlpha,

            drawCallNpc,

            locsAnimated,
            npcs,
        );
        // Kept on the CPU so live entities can be placed on the terrain.
        square.heightMapData = mapData.heightMapTextureData;
        square.locTable = mapData.locTable;
        square.modelTextureDatas = [
            mapData.modelTextureData,
            mapData.modelTextureDataAlpha,
            mapData.modelTextureDataLod,
            mapData.modelTextureDataLodAlpha,
            mapData.modelTextureDataInteract,
            mapData.modelTextureDataInteractAlpha,
            mapData.modelTextureDataInteractLod,
            mapData.modelTextureDataInteractLodAlpha,
        ];
        return square;
    }

    constructor(
        readonly mapX: number,
        readonly mapY: number,

        readonly borderSize: number,
        readonly tileRenderFlags: Uint8Array[][],
        readonly collisionMaps: CollisionMap[],

        readonly timeLoaded: number,
        readonly frameLoaded: number,

        readonly interleavedBuffer: VertexBuffer,
        readonly indexBuffer: VertexBuffer,
        readonly vertexArray: VertexArray,

        readonly heightMapTexture: Texture,

        // Model info
        readonly modelInfoTexture: Texture,
        readonly modelInfoTextureAlpha: Texture,

        readonly modelInfoTextureLod: Texture,
        readonly modelInfoTextureLodAlpha: Texture,

        readonly modelInfoTextureInteract: Texture,
        readonly modelInfoTextureInteractAlpha: Texture,

        readonly modelInfoTextureInteractLod: Texture,
        readonly modelInfoTextureInteractLodAlpha: Texture,

        // Draw calls
        readonly drawCall: DrawCallRange,
        readonly drawCallAlpha: DrawCallRange,

        readonly drawCallLod: DrawCallRange,
        readonly drawCallLodAlpha: DrawCallRange,

        readonly drawCallInteract: DrawCallRange,
        readonly drawCallInteractAlpha: DrawCallRange,

        readonly drawCallInteractLod: DrawCallRange,
        readonly drawCallInteractLodAlpha: DrawCallRange,

        readonly drawCallNpc: DrawCallRange,

        // Animated locs
        readonly locsAnimated: LocAnimated[],

        // Npcs
        readonly npcs: Npc[],
    ) {
        this.id = getMapSquareId(mapX, mapY);
        this.npcDataTextureOffsets = new Array(NPC_DATA_TEXTURE_BUFFER_SIZE).fill(-1);
    }

    canRender(frameCount: number): boolean {
        return frameCount - this.frameLoaded > FRAME_RENDER_DELAY;
    }

    getTileRenderFlag(level: number, tileX: number, tileY: number): number {
        return this.tileRenderFlags[level][tileX + this.borderSize][tileY + this.borderSize];
    }

    // Interpolated ground height (RS convention, negative is up) at a fine coord within this
    // square, matching the client's getHeightmapY and the npc shader's getHeightInterp.
    getHeightInterp(level: number, localFineX: number, localFineZ: number): number {
        const data = this.heightMapData;
        if (!data) {
            return 0;
        }
        const size = Scene.MAP_SQUARE_SIZE + this.borderSize * 2;
        const levelOffset = level * size * size;
        const tileX = (localFineX >> 7) + this.borderSize;
        const tileZ = (localFineZ >> 7) + this.borderSize;
        const offsetX = localFineX & 127;
        const offsetZ = localFineZ & 127;
        const h00 = -data[levelOffset + tileZ * size + tileX] * 8;
        const h10 = -data[levelOffset + tileZ * size + tileX + 1] * 8;
        const h01 = -data[levelOffset + (tileZ + 1) * size + tileX] * 8;
        const h11 = -data[levelOffset + (tileZ + 1) * size + tileX + 1] * 8;
        const y0 = (h00 * (128 - offsetX) + h10 * offsetX) >> 7;
        const y1 = (h01 * (128 - offsetX) + h11 * offsetX) >> 7;
        return (y0 * (128 - offsetZ) + y1 * offsetZ) >> 7;
    }

    getMapDistance(mapX: number, mapY: number): number {
        return Math.max(Math.abs(mapX - this.mapX), Math.abs(mapY - this.mapY));
    }

    getDrawCall(isAlpha: boolean, isInteract: boolean, isLod: boolean): DrawCallRange {
        if (isInteract) {
            if (isLod) {
                return isAlpha ? this.drawCallInteractLodAlpha : this.drawCallInteractLod;
            } else {
                return isAlpha ? this.drawCallInteractAlpha : this.drawCallInteract;
            }
        } else {
            if (isLod) {
                return isAlpha ? this.drawCallLodAlpha : this.drawCallLod;
            } else {
                return isAlpha ? this.drawCallAlpha : this.drawCall;
            }
        }
    }

    // The static loc on a tile and layer (local key), packed as SdLocTable.info, or -1.
    getLocInfo(key: number): number {
        const index = this.locTable ? findLoc(this.locTable, key) : -1;
        return index === -1 ? -1 : this.locTable!.info[index * 2];
    }

    getLocRaise(key: number): number {
        const index = this.locTable ? findLoc(this.locTable, key) : -1;
        return index === -1 ? 0 : this.locTable!.info[index * 2 + 1];
    }

    // Hides or shows a static loc without rebuilding the square: instanced models get a hidden
    // instance texel, merged models have their index range collapsed to one vertex.
    setLocHidden(gl: WebGL2RenderingContext, key: number, hidden: boolean): void {
        const table = this.locTable;
        const datas = this.modelTextureDatas;
        if (!table || !datas || this.hiddenLocs.has(key) === hidden) {
            return;
        }
        const index = findLoc(table, key);
        if (index === -1) {
            return;
        }
        const refs = table.refs;
        const start = table.refStart[index];
        const end = table.refStart[index + 1];
        let dirty = 0;
        if (hidden) {
            const saved: HiddenLoc = { texels: [] };
            for (let r = start; r < end; r++) {
                const kind = refs[r * LOC_REF_SIZE];
                const a = refs[r * LOC_REF_SIZE + 1];
                const b = refs[r * LOC_REF_SIZE + 2];
                const c = refs[r * LOC_REF_SIZE + 3];
                if (kind === LOC_REF_INDEX_RANGE) {
                    let first: number;
                    if (c !== -1) {
                        first = table.rangeIndices[c];
                    } else {
                        // A loc without ops: rarely changed, so no copy was kept.
                        const original = new Int32Array(b);
                        this.readIndices(gl, a, original);
                        (saved.indices ??= []).push(original);
                        first = original[0];
                    }
                    if (degenerateIndices.length < b) {
                        const size = Math.max(b, degenerateIndices.length * 2);
                        degenerateIndices = new Int32Array(size);
                    }
                    const degenerate = degenerateIndices.subarray(0, b);
                    this.indexBuffer.data(degenerate.fill(first), a);
                } else {
                    const data = datas[kind];
                    saved.texels.push(data[a * 4], data[a * 4 + 1]);
                    data[a * 4] = HIDDEN_TEXEL;
                    data[a * 4 + 1] = HIDDEN_TEXEL;
                    dirty |= 1 << kind;
                }
            }
            this.hiddenLocs.set(key, saved);
        } else {
            const saved = this.hiddenLocs.get(key)!;
            this.hiddenLocs.delete(key);
            let texel = 0;
            let range = 0;
            for (let r = start; r < end; r++) {
                const kind = refs[r * LOC_REF_SIZE];
                const a = refs[r * LOC_REF_SIZE + 1];
                const b = refs[r * LOC_REF_SIZE + 2];
                const c = refs[r * LOC_REF_SIZE + 3];
                if (kind === LOC_REF_INDEX_RANGE) {
                    const original =
                        c !== -1 ? table.rangeIndices.subarray(c, c + b) : saved.indices![range++];
                    this.indexBuffer.data(original, a);
                } else {
                    const data = datas[kind];
                    data[a * 4] = saved.texels[texel++];
                    data[a * 4 + 1] = saved.texels[texel++];
                    dirty |= 1 << kind;
                }
            }
        }
        const textures = this.getModelInfoTextures();
        for (let kind = 0; kind < textures.length; kind++) {
            if (dirty & (1 << kind)) {
                textures[kind].data(datas[kind]);
            }
        }
    }

    private readIndices(gl: WebGL2RenderingContext, byteOffset: number, out: Int32Array): void {
        const raw = this.indexBuffer as unknown as RawVertexBuffer;
        // Like picogl's VertexBuffer.data: don't touch the bound vertex array's index buffer.
        if (raw.appState.vertexArray) {
            gl.bindVertexArray(null);
            raw.appState.vertexArray = null;
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, raw.buffer);
        gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, byteOffset, out);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }

    // Same order as SdLocTable's ref kinds.
    getModelInfoTextures(): Texture[] {
        return [
            this.modelInfoTexture,
            this.modelInfoTextureAlpha,
            this.modelInfoTextureLod,
            this.modelInfoTextureLodAlpha,
            this.modelInfoTextureInteract,
            this.modelInfoTextureInteractAlpha,
            this.modelInfoTextureInteractLod,
            this.modelInfoTextureInteractLodAlpha,
        ];
    }

    delete() {
        this.vertexArray.delete();
        this.interleavedBuffer.delete();
        this.indexBuffer.delete();

        this.heightMapTexture.delete();

        // Model info
        this.modelInfoTexture.delete();
        this.modelInfoTextureAlpha.delete();

        this.modelInfoTextureLod.delete();
        this.modelInfoTextureLodAlpha.delete();

        this.modelInfoTextureInteract.delete();
        this.modelInfoTextureInteractAlpha.delete();

        this.modelInfoTextureInteractLod.delete();
        this.modelInfoTextureInteractLodAlpha.delete();
    }
}
