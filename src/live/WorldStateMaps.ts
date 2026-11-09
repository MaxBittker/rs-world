import { MapManager } from "../mapviewer/MapManager";
import { WebGLMapSquare } from "../mapviewer/webgl/WebGLMapSquare";
import { getLocalLocKey } from "../mapviewer/webgl/loader/SdLocTable";
import { LocTypeLoader } from "../rs/config/loctype/LocTypeLoader";
import { ObjTypeLoader } from "../rs/config/objtype/ObjTypeLoader";
import { LiveEntityRenderer, getGroundHeight } from "./LiveEntityRenderer";
import { StaticLoc, WorldState, getLocKey, hidesStaticLoc } from "./WorldState";

// Applies the shared zone state to the map squares (hiding static locs that are removed or
// replaced, in every MapManager copy, and again whenever a square loads) and hands it to the
// entity renderer, which draws the dynamic part.
export class WorldStateMaps {
    private state?: WorldState;
    private renderer?: LiveEntityRenderer;
    private staticLoc: StaticLoc = { id: -1, shape: 0, angle: 0, raise: 0 };

    constructor(
        readonly gl: WebGL2RenderingContext,
        readonly getMapManagers: () => Iterable<MapManager<WebGLMapSquare>>,
    ) {}

    // Once per frame, before the entity renderer prepares.
    update(
        state: WorldState | undefined,
        renderer: LiveEntityRenderer | undefined,
        locTypeLoader: LocTypeLoader,
        objTypeLoader: ObjTypeLoader,
    ): void {
        if (state !== this.state) {
            this.unbind();
            this.state = state;
            if (state) {
                state.groundHeight = this.groundHeight;
                state.locChangeListeners.push(this.onLocChanged);
                for (const manager of this.getMapManagers()) {
                    for (const square of manager.mapSquares.values()) {
                        this.onSquareLoaded(square);
                    }
                }
            }
        }
        this.renderer = renderer;
        if (renderer) {
            renderer.worldState = state;
            renderer.locTypeLoader = locTypeLoader;
            renderer.objTypeLoader = objTypeLoader;
            renderer.getStaticLoc = this.getStaticLoc;
        }
        state?.update();
    }

    private unbind(): void {
        const state = this.state;
        if (!state) {
            return;
        }
        state.locChangeListeners = state.locChangeListeners.filter((l) => l !== this.onLocChanged);
        if (state.groundHeight === this.groundHeight) {
            state.groundHeight = undefined;
        }
        for (const manager of this.getMapManagers()) {
            for (const square of manager.mapSquares.values()) {
                for (const key of Array.from(square.hiddenLocs.keys())) {
                    square.setLocHidden(this.gl, key, false);
                }
            }
        }
    }

    // A square was built (first time or again): hide what the zone state removed or replaced.
    onSquareLoaded(square: WebGLMapSquare): void {
        const locs = this.state?.locsBySquare.get(square.id);
        if (!locs) {
            return;
        }
        for (const loc of locs) {
            this.applyLoc(square, loc.x, loc.z, loc.level, loc.layer);
        }
    }

    private onLocChanged = (x: number, z: number, level: number, layer: number): void => {
        for (const manager of this.getMapManagers()) {
            const square = manager.getMap(x >> 6, z >> 6);
            if (square) {
                this.applyLoc(square, x, z, level, layer);
            }
        }
    };

    private applyLoc(
        square: WebGLMapSquare,
        x: number,
        z: number,
        level: number,
        layer: number,
    ): void {
        const key = getLocalLocKey(level, layer, x & 63, z & 63);
        const info = square.getLocInfo(key);
        if (info === -1) {
            return;
        }
        const loc = this.state?.locs.get(getLocKey(x, z, level, layer));
        const staticLoc = unpackLocInfo(info, 0, this.staticLoc);
        square.setLocHidden(this.gl, key, !!loc && hidesStaticLoc(loc, staticLoc));
    }

    // The cache's loc in the squares the entity renderer draws over (the view's own MapManager).
    private getStaticLoc = (
        x: number,
        z: number,
        level: number,
        layer: number,
        out: StaticLoc,
    ): boolean => {
        const square = this.renderer?.mapManager.getMap(x >> 6, z >> 6);
        if (!square) {
            return false;
        }
        const key = getLocalLocKey(level, layer, x & 63, z & 63);
        const info = square.getLocInfo(key);
        if (info === -1) {
            return false;
        }
        unpackLocInfo(info, square.getLocRaise(key), out);
        return true;
    };

    private groundHeight = (level: number, fineX: number, fineZ: number): number | undefined => {
        for (const manager of this.getMapManagers()) {
            const ground = getGroundHeight(manager, level, fineX, fineZ);
            if (ground) {
                return ground.y;
            }
        }
        return undefined;
    };
}

function unpackLocInfo(info: number, raise: number, out: StaticLoc): StaticLoc {
    out.id = info & 0xffff;
    out.shape = (info >> 16) & 0x1f;
    out.angle = (info >> 21) & 0x3;
    out.raise = raise;
    return out;
}
