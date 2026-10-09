import PicoGL, {
    DrawCall,
    App as PicoApp,
    Program,
    Texture,
    UniformBuffer,
    VertexArray,
    VertexBuffer,
} from "picogl";

import { MapManager } from "../mapviewer/MapManager";
import { DrawRange } from "../mapviewer/webgl/DrawRange";
import { InteractType } from "../mapviewer/webgl/InteractType";
import { WebGLMapSquare } from "../mapviewer/webgl/WebGLMapSquare";
import { RenderDataWorkerPool } from "../mapviewer/worker/RenderDataWorkerPool";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { EntityAnimData, EntityModelSpec } from "./EntityModelLoader";
import { LiveEntity, LiveNpc, LivePlayer } from "./LiveEntity";
import { LiveWorld } from "./LiveWorld";

const MAX_PENDING_BAKES = 6;
const MAX_INSTANCES = 4096;
// Baked frames are cheap to rebuild, GPU memory isn't. Over budget, pages not drawn for a couple
// of seconds are evicted (least recently drawn first), and distant players share default-colour
// bodies so a crowd of individually-dressed players can't bake thousands of pages.
const MAX_PAGE_BYTES = 192 * 1024 * 1024;
const PAGE_IDLE_MS = 2000;
const EVICT_INTERVAL_MS = 500;
const LOD_DISTANCE_TILES = 24;

// One baked (model, seq): every frame of the animation in a single vertex/index buffer.
class EntityAnimPage {
    lastUsedAt: number = 0;

    constructor(
        readonly key: string,
        readonly interleavedBuffer: VertexBuffer,
        readonly indexBuffer: VertexBuffer,
        readonly vertexArray: VertexArray,
        readonly drawCall: DrawCall,
        readonly frames: DrawRange[],
        readonly framesAlpha: DrawRange[] | undefined,
        readonly frameHeights: Int16Array,
        readonly byteSize: number,
    ) {}

    delete(): void {
        this.vertexArray.delete();
        this.interleavedBuffer.delete();
        this.indexBuffer.delete();
    }
}

type PageState = EntityAnimPage | "loading" | "failed";

type RenderItem = {
    page: EntityAnimPage;
    frame: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    plane: number;
    interactId: number;
    interactType: number;
};

export type DrawFunction = (drawCall: DrawCall, drawRanges: number[][]) => void;

export class LiveEntityRenderer {
    pages: Map<string, PageState> = new Map();
    pageBytes: number = 0;
    pendingBakes: number = 0;

    items: RenderItem[] = [];
    // Last pose drawn per entity, held while a new appearance or anim is still baking.
    lastDrawn: WeakMap<LiveEntity, { page: EntityAnimPage; frame: number }> = new WeakMap();
    // Draw order: items grouped by page, plus where each page's run starts in the data texture.
    pageRuns: { page: EntityAnimPage; start: number; count: number }[] = [];
    data: Int32Array = new Int32Array(16 * 4);
    dataTexture?: Texture;

    showPlayers: boolean = true;
    showNpcs: boolean = true;

    private now: number = 0;
    private lastEvictAt: number = 0;
    private cameraX: number = 0;
    private cameraZ: number = 0;
    // Set while pages are near the budget: far players use shared default-colour bodies.
    private lod: boolean = false;

    constructor(
        readonly app: PicoApp,
        readonly program: Program,
        readonly sceneUniformBuffer: UniformBuffer,
        readonly workerPool: RenderDataWorkerPool,
        readonly seqTypeLoader: SeqTypeLoader,
        readonly mapManager: MapManager<WebGLMapSquare>,
        readonly world: LiveWorld,
    ) {}

    // Ground height at a fine coord in the RS convention (negative is up), or undefined when the
    // map square isn't loaded. Bridges lift entities onto the level above, like the client.
    getGroundHeight(level: number, fineX: number, fineZ: number): { y: number; plane: number } | undefined {
        const tileX = fineX >> 7;
        const tileZ = fineZ >> 7;
        const map = this.mapManager.getMap(tileX >> 6, tileZ >> 6);
        if (!map || !map.heightMapData) {
            return undefined;
        }
        const localX = tileX & 63;
        const localZ = tileZ & 63;
        let plane = level;
        if (plane < 3 && (map.getTileRenderFlag(1, localX, localZ) & 0x2) === 2) {
            plane++;
        }
        const y = map.getHeightInterp(plane, fineX & 0x1fff, fineZ & 0x1fff);
        return { y, plane };
    }

    prepare(maxLevel: number, cameraX: number, cameraZ: number): void {
        this.items.length = 0;
        this.now = performance.now();
        this.cameraX = cameraX;
        this.cameraZ = cameraZ;
        this.lod = this.pageBytes > MAX_PAGE_BYTES * 0.75;

        if (this.showPlayers) {
            for (const player of this.world.players.values()) {
                this.addEntity(player, maxLevel);
            }
        }
        if (this.showNpcs) {
            for (const npc of this.world.npcs.values()) {
                this.addEntity(npc, maxLevel);
            }
        }

        this.buildRuns();
        this.uploadData();
        this.evictPages();
    }

    private addEntity(e: LiveEntity, maxLevel: number): void {
        if (e.level > maxLevel || this.items.length >= MAX_INSTANCES) {
            return;
        }
        const ground = this.getGroundHeight(e.level, e.x, e.z);
        if (!ground) {
            return;
        }

        const isPlayer = e instanceof LivePlayer;
        const interactType = isPlayer ? InteractType.LIVE_PLAYER : InteractType.LIVE_NPC;

        // The client shows the primary anim over movement (we skip walkmerge blending).
        let seqId = e.secondaryAnim;
        let frame = e.secondaryAnimFrame;
        if (e.primaryAnim !== -1 && e.primaryAnimDelay === 0) {
            seqId = e.primaryAnim;
            frame = e.primaryAnimFrame;
        }

        const model = this.getModelKey(e, seqId);
        if (model) {
            let page = this.requestPage(model.key + "@" + seqId, model.spec, seqId);
            if (!page && e.readyanim !== -1 && seqId !== e.readyanim) {
                // Still baking: hold the idle pose instead of popping out.
                const idle = this.getModelKey(e, e.readyanim);
                page = idle ? this.requestPage(idle.key + "@" + e.readyanim, idle.spec, e.readyanim) : undefined;
                frame = 0;
            }
            if (!page) {
                // New body (e.g. just equipped something) not baked yet: keep the last pose.
                const last = this.lastDrawn.get(e);
                if (last && this.pages.get(last.page.key) === last.page) {
                    page = last.page;
                    frame = last.frame;
                }
            }
            if (page) {
                frame = Math.min(Math.max(frame, 0), page.frames.length - 1);
                page.lastUsedAt = this.now;
                this.lastDrawn.set(e, { page, frame });
                e.height = page.frameHeights[frame] || e.height;
                this.items.push({
                    page,
                    frame,
                    x: e.x,
                    y: ground.y,
                    z: e.z,
                    yaw: e.yaw,
                    plane: ground.plane,
                    interactId: e.id,
                    interactType,
                });
            }
        }

        if (e.spotanimId !== -1 && e.spotanimFrame >= 0) {
            const spot = this.world.spotAnimTypeLoader?.load(e.spotanimId);
            if (spot) {
                const spotSeq = spot.sequenceId;
                const page = this.requestPage(
                    "s" + e.spotanimId + "@" + spotSeq,
                    { kind: "spot", spotAnim: e.spotanimId },
                    spotSeq,
                );
                if (page) {
                    page.lastUsedAt = this.now;
                    this.items.push({
                        page,
                        frame: Math.min(e.spotanimFrame, page.frames.length - 1),
                        x: e.x,
                        y: ground.y - e.spotanimHeight,
                        z: e.z,
                        yaw: e.yaw,
                        plane: ground.plane,
                        interactId: e.id,
                        interactType,
                    });
                }
            }
        }
    }

    // Which body to draw: npc type, or player appearance plus any held-item swap the seq makes.
    private getModelKey(e: LiveEntity, seqId: number): { key: string; spec: EntityModelSpec } | undefined {
        if (e instanceof LiveNpc) {
            return { key: "n" + e.npcType.id, spec: { kind: "npc", npcType: e.npcType.id } };
        }
        const player = e as LivePlayer;
        if (!player.appearance) {
            return undefined;
        }
        let leftHand = -1;
        let rightHand = -1;
        if (seqId !== -1 && seqId === player.primaryAnim) {
            const seq = this.seqTypeLoader.load(seqId);
            leftHand = seq.leftHandItem;
            rightHand = seq.rightHandItem;
        }
        const far =
            this.lod &&
            (Math.abs(e.x / 128 - this.cameraX) > LOD_DISTANCE_TILES ||
                Math.abs(e.z / 128 - this.cameraZ) > LOD_DISTANCE_TILES);
        const appearance = far ? player.lodAppearance! : player.appearance;
        const modelKey = far ? player.lodModelKey : player.modelKey;
        return {
            key: "p" + modelKey + (leftHand >= 0 || rightHand >= 0 ? `|${leftHand}|${rightHand}` : ""),
            spec: { kind: "player", appearance, leftHand, rightHand },
        };
    }

    private requestPage(key: string, spec: EntityModelSpec, seqId: number): EntityAnimPage | undefined {
        const state = this.pages.get(key);
        if (state instanceof EntityAnimPage) {
            return state;
        }
        if (state || this.pendingBakes >= MAX_PENDING_BAKES) {
            return undefined;
        }

        this.pages.set(key, "loading");
        this.pendingBakes++;
        this.workerPool
            .queueEntityAnim({ key, spec, seqId })
            .then((data) => {
                if (this.pages.get(key) !== "loading") {
                    return;
                }
                if (!data || data.indices.length === 0) {
                    this.pages.set(key, "failed");
                    return;
                }
                this.pages.set(key, this.createPage(data));
            })
            .catch((e) => {
                console.error("Failed baking live entity", key, e);
                this.pages.set(key, "failed");
            })
            .finally(() => {
                this.pendingBakes--;
            });
        return undefined;
    }

    private createPage(data: EntityAnimData): EntityAnimPage {
        const interleavedBuffer = this.app.createInterleavedBuffer(12, data.vertices);
        const indexBuffer = this.app.createIndexBuffer(PicoGL.UNSIGNED_INT, data.indices);
        const vertexArray = this.app
            .createVertexArray()
            .vertexAttributeBuffer(0, interleavedBuffer, {
                type: PicoGL.UNSIGNED_INT,
                size: 3,
                stride: 12,
                integer: true as any,
            })
            .indexBuffer(indexBuffer);
        const drawCall = this.app
            .createDrawCall(this.program, vertexArray)
            .uniformBlock("SceneUniforms", this.sceneUniformBuffer);
        const byteSize = data.vertices.byteLength + data.indices.byteLength;
        this.pageBytes += byteSize;
        return new EntityAnimPage(
            data.key,
            interleavedBuffer,
            indexBuffer,
            vertexArray,
            drawCall,
            data.frames,
            data.framesAlpha,
            data.frameHeights,
            byteSize,
        );
    }

    private buildRuns(): void {
        const byPage = new Map<EntityAnimPage, RenderItem[]>();
        for (const item of this.items) {
            const list = byPage.get(item.page);
            if (list) {
                list.push(item);
            } else {
                byPage.set(item.page, [item]);
            }
        }

        this.pageRuns.length = 0;
        this.items.length = 0;
        for (const [page, list] of byPage) {
            this.pageRuns.push({ page, start: this.items.length, count: list.length });
            for (const item of list) {
                this.items.push(item);
            }
        }
    }

    private uploadData(): void {
        const count = this.items.length;
        const texels = Math.max(count * 2, 1);
        const rows = Math.ceil(texels / 16);
        if (this.data.length < rows * 16 * 4) {
            this.data = new Int32Array(Math.ceil(rows * 1.5) * 16 * 4);
        }
        const data = this.data;
        for (let i = 0; i < count; i++) {
            const item = this.items[i];
            const offset = i * 8;
            data[offset] = item.x;
            data[offset + 1] = item.y;
            data[offset + 2] = item.z;
            data[offset + 3] = (item.yaw & 0x7ff) | (item.plane << 11);
            data[offset + 4] = item.interactId;
            data[offset + 5] = item.interactType;
            data[offset + 6] = 0;
            data[offset + 7] = 0;
        }

        this.dataTexture?.delete();
        this.dataTexture = this.app.createTexture2D(data.subarray(0, rows * 16 * 4), 16, rows, {
            internalFormat: PicoGL.RGBA32I,
            minFilter: PicoGL.NEAREST,
            magFilter: PicoGL.NEAREST,
        });
    }

    render(transparent: boolean, textureArray: Texture, textureMaterials: Texture, draw: DrawFunction): void {
        if (!this.dataTexture) {
            return;
        }
        for (const run of this.pageRuns) {
            const frames = transparent ? run.page.framesAlpha : run.page.frames;
            if (!frames) {
                continue;
            }
            const ranges: number[][] = [];
            for (let i = 0; i < run.count; i++) {
                ranges.push(frames[this.items[run.start + i].frame]);
            }
            const drawCall = run.page.drawCall
                .uniform("u_entityDataOffset", run.start)
                .texture("u_entityData", this.dataTexture)
                .texture("u_textures", textureArray)
                .texture("u_textureMaterials", textureMaterials)
                .drawRanges(...ranges);
            draw(drawCall, ranges);
        }
    }

    private evictPages(): void {
        if (this.pageBytes <= MAX_PAGE_BYTES || this.now - this.lastEvictAt < EVICT_INTERVAL_MS) {
            return;
        }
        this.lastEvictAt = this.now;
        const idle: EntityAnimPage[] = [];
        for (const page of this.pages.values()) {
            if (page instanceof EntityAnimPage && this.now - page.lastUsedAt > PAGE_IDLE_MS) {
                idle.push(page);
            }
        }
        idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        for (const page of idle) {
            if (this.pageBytes <= MAX_PAGE_BYTES * 0.75) {
                break;
            }
            page.delete();
            this.pages.delete(page.key);
            this.pageBytes -= page.byteSize;
        }
    }

    getPageCount(): number {
        let count = 0;
        for (const page of this.pages.values()) {
            if (page instanceof EntityAnimPage) {
                count++;
            }
        }
        return count;
    }

    delete(): void {
        for (const page of this.pages.values()) {
            if (page instanceof EntityAnimPage) {
                page.delete();
            }
        }
        this.pages.clear();
        this.pageBytes = 0;
        this.dataTexture?.delete();
        this.dataTexture = undefined;
    }
}
