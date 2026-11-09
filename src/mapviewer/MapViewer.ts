import { vec3 } from "gl-matrix";
import { URLSearchParamsInit } from "react-router-dom";

import { OsrsMenuEntry } from "../components/rs/menu/OsrsMenu";
import { MenuTargetType } from "../rs/MenuEntry";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { CacheLoaderFactory, getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { BasTypeLoader } from "../rs/config/bastype/BasTypeLoader";
import { LocTypeLoader } from "../rs/config/loctype/LocTypeLoader";
import { NpcTypeLoader } from "../rs/config/npctype/NpcTypeLoader";
import { ObjTypeLoader } from "../rs/config/objtype/ObjTypeLoader";
import { SeqTypeLoader } from "../rs/config/seqtype/SeqTypeLoader";
import { VarManager } from "../rs/config/vartype/VarManager";
import { MapFileIndex, getMapSquareId } from "../rs/map/MapFileIndex";
import { SeqFrameLoader } from "../rs/model/seq/SeqFrameLoader";
import { Pathfinder } from "../rs/pathfinder/Pathfinder";
import { TextureLoader } from "../rs/texture/TextureLoader";
import { isTouchDevice } from "../util/DeviceUtil";
import { LiveController, MAX_AREA_RADIUS, getDefaultFeedUrl } from "../live/LiveController";
import { MAX_PANES, MultiPane, MultiView } from "../live/MultiView";
import { LoadedCache } from "./Caches";
import { Camera, CameraView, ProjectionType } from "./Camera";
import { InputManager } from "./InputManager";
import { MapManager } from "./MapManager";
import { MapViewerRenderer } from "./MapViewerRenderer";
import { NpcSpawn } from "./data/npc/NpcSpawn";
import { WebGLMapViewerRenderer } from "./webgl/WebGLMapViewerRenderer";
import { RenderDataWorkerPool } from "./worker/RenderDataWorkerPool";

const CACHED_MAP_IMAGE_PREFIX = "/map-images/";

export class MapViewer {
    inputManager: InputManager = new InputManager();
    camera: Camera = new Camera(3242, -26, 3202, -245, 1862);

    pathfinder: Pathfinder = new Pathfinder();

    renderer: MapViewerRenderer;

    // Cache
    loadedCache!: LoadedCache;
    cacheSystem!: CacheSystem;
    loaderFactory!: CacheLoaderFactory;

    textureLoader!: TextureLoader;
    seqTypeLoader!: SeqTypeLoader;
    seqFrameLoader!: SeqFrameLoader;

    locTypeLoader!: LocTypeLoader;
    objTypeLoader!: ObjTypeLoader;
    npcTypeLoader!: NpcTypeLoader;

    basTypeLoader!: BasTypeLoader;

    varManager!: VarManager;

    mapFileIndex!: MapFileIndex;

    isNewTextureAnim: boolean = false;

    // Settings

    // Tile distance. Follows the zoom: the renderer sets it every frame.
    renderDistance: number = 128;
    // Map square distance
    unloadDistance: number = 2;
    // Map square distance
    lodDistance: number = 3;

    tooltips: boolean = !isTouchDevice;

    // State
    needsSearchParamUpdate: boolean = false;
    lastTimeSearchParamsUpdated: number = 0;

    menuOpen: boolean = false;
    menuOpenedFrame: number = 0;
    menuX: number = -1;
    menuY: number = -1;
    menuEntries: OsrsMenuEntry[] = [];

    debugText?: string;

    mapImageUrls: Map<number, string> = new Map();
    minimapImageUrls: Map<number, string> = new Map();
    loadingMapImageIds: Set<number> = new Set();

    cameraSpeed: number = 1;

    // Live world feed (players + npcs from an rs-sdk server). ?live=<ws url> overrides the
    // default, ?live=off disables it.
    liveUrl: string | undefined = getDefaultFeedUrl();
    liveParam: string | undefined;
    live?: LiveController;
    followParam: string | undefined;

    // Multi-view (?multi=A,B,C): one renderer, up to 16 panes each following a player.
    multiNames?: string[];
    multi?: MultiView;
    // Pane view distance in tiles (?md=), smaller than a full view so 16 panes stay light.
    multiRenderDistance: number = 48;

    constructor(
        readonly workerPool: RenderDataWorkerPool,
        public npcSpawns: NpcSpawn[],
        readonly mapImageCache: Cache,
        cache: LoadedCache,
    ) {
        this.renderer = new WebGLMapViewerRenderer(this);
        this.initCache(cache);
    }

    getSearchParams(): URLSearchParamsInit {
        const cx = this.camera.getPosX().toFixed(2).toString();
        const cy = -this.camera.getPosY().toFixed(2).toString();
        const cz = this.camera.getPosZ().toFixed(2).toString();

        const yaw = this.camera.yaw & 2047;

        const p = (this.camera.pitch | 0).toString();
        const y = yaw.toString();

        const params: any = {
            cx,
            cy,
            cz,
            p,
            y,
        };

        if (this.camera.projectionType === ProjectionType.ORTHO) {
            params["pt"] = "o";
            params["z"] = this.camera.orthoZoom.toString();
        }

        if (this.liveParam !== undefined) {
            params["live"] = this.liveParam;
        }
        if (this.multi) {
            const multiParams: any = {
                multi: this.multi.panes.map((p) => p.getName() ?? "").join(","),
            };
            if (this.liveParam !== undefined) {
                multiParams["live"] = this.liveParam;
            }
            if (this.multiRenderDistance !== 48) {
                multiParams["md"] = this.multiRenderDistance.toString();
            }
            return multiParams;
        }
        const followName = this.live?.followName ?? this.live?.pendingFollow;
        if (followName) {
            params["follow"] = followName;
        }

        params["v"] = 1;

        return params;
    }

    applySearchParams(searchParams: URLSearchParams) {
        const cx = searchParams.get("cx");
        const cy = searchParams.get("cy");
        const cz = searchParams.get("cz");

        const pitch = searchParams.get("p");
        const yaw = searchParams.get("y");

        const v = searchParams.get("v");

        if (searchParams.get("pt") === "o") {
            this.camera.projectionType = ProjectionType.ORTHO;
        }

        const live = searchParams.get("live");
        if (live !== null) {
            this.liveParam = live;
            const url = live === "off" || live === "0" || live === "" ? undefined : live;
            if (url !== this.liveUrl) {
                this.liveUrl = url;
                this.initLive();
            }
        }

        const multi = searchParams.get("multi");
        if (multi !== null) {
            const names = multi
                .split(",")
                .map((n) => n.trim())
                .slice(0, MAX_PANES);
            const md = parseInt(searchParams.get("md") ?? "");
            if (md >= 16 && md <= 128) {
                this.multiRenderDistance = md;
            }
            this.multiNames = names.length > 0 ? names : [""];
            this.initLive();
        }

        const follow = searchParams.get("follow");
        if (follow) {
            this.followParam = follow;
            if (this.live) {
                this.live.pendingFollow = follow;
            }
        }

        const zoom = searchParams.get("z");
        if (zoom) {
            this.camera.orthoZoom = parseInt(zoom);
        }

        if (cx && cy && cz) {
            const pos = vec3.fromValues(parseFloat(cx), -parseFloat(cy), parseFloat(cz));
            this.camera.pos = pos;
        }
        if (pitch) {
            this.camera.pitch = parseInt(pitch);
            if (!v) {
                this.camera.pitch = -this.camera.pitch;
            }
        }
        if (yaw) {
            this.camera.yaw = parseInt(yaw);
            if (!v) {
                this.camera.yaw = 2048 - this.camera.yaw;
            }
        }
    }

    init(): void {
        this.workerPool.loadCachedMapImages().then((mapImageUrls) => {
            mapImageUrls.forEach((value, key) => this.mapImageUrls.set(key, value));
        });
    }

    initCache(cache: LoadedCache): void {
        this.loadedCache = cache;
        this.cacheSystem = CacheSystem.fromFiles(cache.type, cache.files);
        this.loaderFactory = getCacheLoaderFactory(cache.info, this.cacheSystem);
        this.workerPool.initCache(cache, this.npcSpawns);
        this.clearMapImageUrls();

        this.textureLoader = this.loaderFactory.getTextureLoader();
        this.seqTypeLoader = this.loaderFactory.getSeqTypeLoader();
        this.seqFrameLoader = this.loaderFactory.getSeqFrameLoader();
        this.locTypeLoader = this.loaderFactory.getLocTypeLoader();
        this.objTypeLoader = this.loaderFactory.getObjTypeLoader();
        this.npcTypeLoader = this.loaderFactory.getNpcTypeLoader();
        this.basTypeLoader = this.loaderFactory.getBasTypeLoader();

        this.varManager = new VarManager(this.loaderFactory.getVarBitTypeLoader());
        const questTypeLoader = this.loaderFactory.getQuestTypeLoader();
        if (questTypeLoader) {
            this.varManager.setQuestsCompleted(questTypeLoader);
        }

        const mapFileLoader = this.loaderFactory.getMapFileLoader();
        this.mapFileIndex = mapFileLoader.mapFileIndex;

        this.isNewTextureAnim = cache.info.game === "runescape" && cache.info.revision >= 681;

        this.renderer.initCache();

        this.initLive();

        this.updateSearchParams();
    }

    initLive(): void {
        this.live?.stop();
        this.live = undefined;
        this.multi?.stop();
        this.multi = undefined;
        // The live layer needs player kits/spotanims, only built for pre-dat2 (rs-sdk) caches.
        if (this.liveUrl && this.loaderFactory?.getIdkTypeLoader) {
            this.live = new LiveController(
                this.liveUrl,
                this.npcTypeLoader,
                this.seqTypeLoader,
                this.seqFrameLoader,
                this.loaderFactory.getSpotAnimTypeLoader?.(),
            );
            if (this.followParam) {
                this.live.pendingFollow = this.followParam;
            }
            this.live.hitmarkSprites = this.loaderFactory.getHitmarkSprites?.() ?? [];
            this.live.headIconSprites = this.loaderFactory.getHeadIconSprites?.() ?? [];
            const names = this.multiNames;
            if (names && names.length > 0) {
                if (names[0]) {
                    this.live.pendingFollow = names[0];
                }
                for (const name of names.slice(1)) {
                    this.addPane(name);
                }
                (this.multi as MultiView | undefined)?.setActive(0);
                this.syncActivePane();
            }
        }
        // Live npcs replace the static spawn list; without a feed, fall back to it.
        this.renderer.setLoadNpcs?.(!this.live);
    }

    canAddPane(): boolean {
        return !!this.live && (this.multi?.panes.length ?? 1) < MAX_PANES;
    }

    // Splits the single view into panes, or adds one more. The new pane starts at the selected
    // pane's camera and is selected, so the Live panel's list picks who it follows.
    addPane(name?: string): void {
        if (!this.live || !this.liveUrl || !this.canAddPane()) {
            return;
        }
        if (!this.multi) {
            const multi = new MultiView();
            this.live.maxAreaRadius = this.multiRenderDistance;
            multi.addPane(this.makePane(this.camera, this.live));
            multi.setActive(0);
            this.multi = multi;
        }
        const multi = this.multi;
        const from = multi.panes[multi.active].camera;
        const camera = new Camera(from.pos[0], from.pos[1], from.pos[2], from.pitch, from.yaw);
        camera.projectionType = from.projectionType;
        const live = new LiveController(
            this.liveUrl,
            this.npcTypeLoader,
            this.seqTypeLoader,
            this.seqFrameLoader,
            this.loaderFactory.getSpotAnimTypeLoader?.(),
            false,
        );
        live.hitmarkSprites = multi.panes[0].live.hitmarkSprites;
        live.headIconSprites = multi.panes[0].live.headIconSprites;
        live.maxAreaRadius = this.multiRenderDistance;
        // Start from the roster we already have, so a typed name is found right away.
        const roster = multi.panes[0].live.lastRoster;
        if (roster) {
            live.world.applyRoster(roster);
        }
        if (name) {
            live.pendingFollow = name;
        }
        multi.addPane(this.makePane(camera, live));
        multi.setActive(multi.panes.length - 1);
        this.wireRoster();
        this.syncActivePane();
        this.updateSearchParams();
    }

    // Closes a pane; with one left, back to the single view (its feed keeps running).
    removePane(pane: MultiPane): void {
        const multi = this.multi;
        if (!multi || multi.panes.length <= 1) {
            return;
        }
        multi.removePane(pane);
        pane.live.stop();
        if (multi.panes.length === 1) {
            const last = multi.panes[0];
            (this.renderer as { leaveMultiMaps?(level?: number): void }).leaveMultiMaps?.(
                last.level,
            );
            multi.detach();
            this.multi = undefined;
            last.live.maxAreaRadius = MAX_AREA_RADIUS;
            last.live.rosterListeners.length = 0;
            last.live.feed.setRoster(true);
            this.camera = last.camera;
            this.live = last.live;
        } else {
            this.wireRoster();
            this.syncActivePane();
        }
        this.updateSearchParams();
    }

    // The selected pane is what the camera controls, the Live panel and click menus act on.
    syncActivePane(): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        const pane = multi.panes[multi.active];
        this.camera = pane.camera;
        this.live = pane.live;
    }

    private makePane(camera: Camera, live: LiveController): MultiPane {
        return new MultiPane(camera, live, {
            rename: (pane, newName) => {
                pane.live.unfollow();
                pane.live.pendingFollow = newName || undefined;
                this.updateSearchParams();
            },
            close: (pane) => this.removePane(pane),
        });
    }

    // Only the first pane's feed subscribes to the roster; it hands each roster to the others.
    private wireRoster(): void {
        const multi = this.multi;
        if (!multi) {
            return;
        }
        multi.panes.forEach((pane, i) => {
            pane.live.rosterListeners.length = 0;
            pane.live.feed.setRoster(i === 0);
        });
        const source = multi.panes[0].live;
        source.rosterListeners.push((roster) => {
            for (const pane of multi.panes) {
                if (pane.live !== source) {
                    pane.live.world.applyRoster(roster);
                }
            }
        });
    }

    /**
     * Sets the camera position to a new arbitrary position
     * @param newView Any of the items you want to move: Position, pitch, yaw
     */
    setCamera(newView: Partial<CameraView>): void {
        if (newView.position) {
            vec3.copy(this.camera.pos, newView.position);
        }
        if (newView.pitch !== undefined) {
            this.camera.pitch = newView.pitch;
        }
        if (newView.yaw !== undefined) {
            this.camera.yaw = newView.yaw;
        }
        if (newView.fov !== undefined) {
            this.camera.fov = newView.fov;
        }
        if (newView.orthoZoom !== undefined) {
            this.camera.orthoZoom = newView.orthoZoom;
        }
        this.camera.updated = true;
    }

    updateSearchParams(): void {
        this.needsSearchParamUpdate = true;
        this.lastTimeSearchParamsUpdated = performance.now();
    }

    closeMenu = () => {
        this.menuOpen = false;
        this.menuX = -1;
        this.menuY = -1;
        this.renderer.canvas.focus();
    };

    resetMenu = () => {
        this.closeMenu();
        this.menuOpenedFrame = 0;
    };

    onExamine = (entry: OsrsMenuEntry) => {
        let lookupType: string | undefined;
        switch (entry.targetType) {
            case MenuTargetType.NPC:
                lookupType = "npc";
                break;
            case MenuTargetType.LOC:
                lookupType = "object";
                break;
            case MenuTargetType.OBJ:
                lookupType = "item";
                break;
        }
        if (lookupType) {
            window.open(
                `https://oldschool.runescape.wiki/w/Special:Lookup?type=${lookupType}&id=${entry.targetId}`,
                "_blank",
            );
        }
        this.closeMenu();
    };

    updateVars(): void {
        this.workerPool.setVars(this.varManager.values);
    }

    static getCachedMapImageUrl(mapX: number, mapY: number): string {
        return CACHED_MAP_IMAGE_PREFIX + `${mapX}_${mapY}.png`;
    }

    async queueLoadMapImage(mapX: number, mapY: number) {
        const mapManager = this.renderer.mapManager;
        const mapId = getMapSquareId(mapX, mapY);
        if (
            this.loadingMapImageIds.size > this.workerPool.size * 4 ||
            this.mapImageUrls.has(mapId) ||
            this.loadingMapImageIds.has(mapId) ||
            mapManager.invalidMapIds.has(mapId) ||
            mapManager.loadingMapIds.has(mapId)
        ) {
            return;
        }
        this.loadingMapImageIds.add(mapId);

        const minimapData = await this.workerPool.queueMapImage(mapX, mapY, 0, true);
        if (minimapData) {
            const url = URL.createObjectURL(minimapData.minimapBlob);
            this.setMapImageUrl(mapX, mapY, url, false);
        } else {
            mapManager.invalidMapIds.add(mapId);
        }

        this.loadingMapImageIds.delete(mapId);
    }

    getMapImageUrl(mapX: number, mapY: number, minimap: boolean): string | undefined {
        if (mapX < 0 || mapY < 0 || mapX >= MapManager.MAX_MAP_X || mapY >= MapManager.MAX_MAP_Y) {
            return undefined;
        }
        const urls = minimap ? this.minimapImageUrls : this.mapImageUrls;
        if (minimap) {
            this.renderer.mapManager.loadMap(mapX, mapY);
        } else {
            this.queueLoadMapImage(mapX, mapY);
        }
        const mapId = getMapSquareId(mapX, mapY);
        return urls.get(mapId);
    }

    setMapImageUrl(
        mapX: number,
        mapY: number,
        url: string,
        minimap: boolean,
        cache: boolean = true,
    ): void {
        const mapId = getMapSquareId(mapX, mapY);
        const urls = minimap ? this.minimapImageUrls : this.mapImageUrls;
        const old = urls.get(mapId);
        if (old) {
            URL.revokeObjectURL(old);
        }
        if (cache) {
            fetch(url).then((resp) => {
                if (resp.ok) {
                    const request = new Request(MapViewer.getCachedMapImageUrl(mapX, mapY), {
                        headers: {
                            "RS-Cache-Name": this.loadedCache.info.name,
                        },
                    });
                    this.mapImageCache.put(request, resp);
                }
            });
        }
        urls.set(mapId, url);
    }

    clearMapImageUrls(): void {
        for (const url of this.mapImageUrls.values()) {
            URL.revokeObjectURL(url);
        }
        for (const url of this.minimapImageUrls.values()) {
            URL.revokeObjectURL(url);
        }
        this.mapImageUrls.clear();
        this.minimapImageUrls.clear();
        this.loadingMapImageIds.clear();
    }
}
