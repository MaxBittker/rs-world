import { vec4 } from "gl-matrix";

import { Camera } from "../mapviewer/Camera";
import { IndexedSprite } from "../rs/sprite/IndexedSprite";
import { LiveController } from "./LiveController";
import { LiveEntity, LiveNpc, LivePlayer } from "./LiveEntity";

// Labels are only drawn this close to the camera (tiles), so busy areas stay readable.
const LABEL_DISTANCE = 40;

// Label decluttering: screen space is split into cells; a name or chat line is only drawn if
// its cells are free, nearest entities first. Chat may move up a line or two, like the client
// stacks overlapping chat, before it's dropped.
const GRID_CELL = 8;
const CHAT_LINE = 16;
const CHAT_MAX_SHIFTS = 2;

// Overhead chat colours 0-5 from the client (yellow, red, green, cyan, purple, white); 6-11
// flash/glow and are approximated by cycling.
const CHAT_COLOURS = ["#ffff00", "#ff0000", "#00ff00", "#00ffff", "#ff00ff", "#ffffff"];

// Where the client puts each of an entity's 4 hitmark slots, relative to its mid-height.
const HITMARK_OFFSETS: [number, number][] = [
    [0, 0],
    [0, -20],
    [-15, -10],
    [15, -10],
];

type ScreenPos = { x: number; y: number };

type OverlayEntity = {
    e: LiveEntity;
    distance: number;
    followed: boolean;
    top: ScreenPos;
    head: ScreenPos;
    name?: string;
    nameColour: string;
    nameY: number;
    chatY?: number;
    combat: boolean;
    hitmarks: boolean;
};

// Draws names, overhead chat, hitsplats and health bars on a 2D canvas over the GL view,
// projected with the same camera matrices as the frame that was just rendered.
export class LiveOverlay {
    readonly canvas: HTMLCanvasElement;
    readonly ctx: CanvasRenderingContext2D;

    private clip = vec4.create();

    // The cache's hitmark sprites as canvases, rebuilt when the controller's sprites change.
    private hitmarkSource?: IndexedSprite[];
    private hitmarks: HTMLCanvasElement[] = [];

    private grid: Uint8Array = new Uint8Array(0);
    private gridCols: number = 0;
    private gridRows: number = 0;
    private textWidths: Map<string, number> = new Map();

    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "live-overlay";
        this.ctx = this.canvas.getContext("2d")!;
    }

    draw(
        controller: LiveController,
        camera: Camera,
        getGroundY: (e: LiveEntity) => number | undefined,
        maxLevel: number,
    ): void {
        const canvas = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = this.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;

        const { options, world } = controller;
        const loopCycle = world.loopCycle;
        const followed = controller.getFollowed();

        const entities: LiveEntity[] = [];
        if (options.showPlayers) {
            entities.push(...world.players.values());
        }
        if (options.showNpcs) {
            entities.push(...world.npcs.values());
        }

        // 1. What each nearby entity wants drawn, and where.
        const overlays: OverlayEntity[] = [];
        for (const e of entities) {
            if (e.level > maxLevel) {
                continue;
            }
            const dx = e.x / 128 - camera.getPosX();
            const dz = e.z / 128 - camera.getPosZ();
            const isFollowed = e === followed;
            if (!isFollowed && (Math.abs(dx) > LABEL_DISTANCE || Math.abs(dz) > LABEL_DISTANCE)) {
                continue;
            }

            const isPlayer = e instanceof LivePlayer;
            const showName = isFollowed || (isPlayer ? options.showPlayerNames : options.showNpcNames);
            // Same windows as the client: health bar for 300 cycles after a hit, hitmarks 70.
            const combat = options.showCombat && e.combatCycle > loopCycle + 100 && e.totalHealth > 0;
            const chat = options.showChat && e.chatMessage !== null && e.chatTimer > 0;
            const hitmarks = options.showCombat && e.damageCycles.some((cycle) => cycle > loopCycle);
            if (!showName && !combat && !chat && !hitmarks) {
                continue;
            }

            const groundY = getGroundY(e);
            if (groundY === undefined) {
                continue;
            }
            // The client anchors the health bar 15 units above the head and chat at the head.
            const top = this.project(camera, e.x, groundY - e.height - 15, e.z, width, height);
            const head = this.project(camera, e.x, groundY - e.height, e.z, width, height);
            if (!top || !head) {
                continue;
            }

            overlays.push({
                e,
                distance: dx * dx + dz * dz,
                followed: isFollowed,
                top,
                head,
                name: showName ? (isPlayer ? e.getName() : formatNpcName(e as LiveNpc)) : undefined,
                nameColour: isFollowed ? "#ff981f" : isPlayer ? "#ffffff" : "#ffff00",
                nameY: top.y - 8,
                chatY: chat ? head.y : undefined,
                combat,
                hitmarks,
            });
        }

        // 2. Place labels: followed first, then nearest. Chat outranks names.
        overlays.sort((a, b) => (a.followed ? -1 : b.followed ? 1 : a.distance - b.distance));
        this.resetGrid(width, height);
        for (const o of overlays) {
            if (o.chatY === undefined) {
                continue;
            }
            const half = this.measure("bold", o.e.chatMessage ?? "") / 2;
            let placed: number | undefined;
            for (let shift = 0; shift <= CHAT_MAX_SHIFTS && placed === undefined; shift++) {
                const y = o.chatY - shift * CHAT_LINE;
                if (this.occupy(o.head.x - half, y - 13, o.head.x + half, y + 2, o.followed)) {
                    placed = y;
                }
            }
            o.chatY = placed;
        }
        for (const o of overlays) {
            if (!o.name) {
                continue;
            }
            if (o.chatY !== undefined) {
                o.nameY = Math.min(o.nameY, o.chatY - CHAT_LINE);
            }
            const half = this.measure("plain", o.name) / 2;
            if (!this.occupy(o.top.x - half, o.nameY - 12, o.top.x + half, o.nameY + 2, o.followed)) {
                o.name = undefined;
            }
        }

        // 3. Draw back to front: names, health bars, hitmarks, then chat on top like the client.
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = "16px 'OSRS Small', sans-serif";
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.name) {
                this.drawText(o.name, o.top.x, o.nameY, o.nameColour);
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.combat) {
                const e = o.e;
                const fill = Math.min(((e.health * 30) / e.totalHealth) | 0, 30);
                const x = Math.round(o.top.x);
                const y = Math.round(o.top.y);
                ctx.fillStyle = "#00ff00";
                ctx.fillRect(x - 15, y - 3, fill, 5);
                ctx.fillStyle = "#ff0000";
                ctx.fillRect(x - 15 + fill, y - 3, 30 - fill, 5);
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.hitmarks) {
                const groundY = getGroundY(o.e)!;
                const mid = this.project(camera, o.e.x, groundY - o.e.height / 2, o.e.z, width, height);
                if (mid) {
                    this.drawHitmarks(controller, o.e, mid, loopCycle);
                }
            }
        }
        for (let i = overlays.length - 1; i >= 0; i--) {
            const o = overlays[i];
            if (o.chatY !== undefined) {
                this.drawChat(o.e, o.head.x, o.chatY, loopCycle);
            }
        }
    }

    private resetGrid(width: number, height: number): void {
        const cols = Math.ceil(width / GRID_CELL);
        const rows = Math.ceil(height / GRID_CELL);
        if (cols !== this.gridCols || rows !== this.gridRows) {
            this.gridCols = cols;
            this.gridRows = rows;
            this.grid = new Uint8Array(cols * rows);
        } else {
            this.grid.fill(0);
        }
    }

    // Claims the cells under a screen rect; false (claiming nothing) if any are taken, unless forced.
    private occupy(x0: number, y0: number, x1: number, y1: number, force: boolean): boolean {
        const c0 = Math.max(0, Math.floor(x0 / GRID_CELL));
        const c1 = Math.min(this.gridCols - 1, Math.floor(x1 / GRID_CELL));
        const r0 = Math.max(0, Math.floor(y0 / GRID_CELL));
        const r1 = Math.min(this.gridRows - 1, Math.floor(y1 / GRID_CELL));
        if (!force) {
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    if (this.grid[r * this.gridCols + c]) {
                        return false;
                    }
                }
            }
        }
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                this.grid[r * this.gridCols + c] = 1;
            }
        }
        return true;
    }

    private measure(font: "plain" | "bold", text: string): number {
        const key = font + text;
        let width = this.textWidths.get(key);
        if (width === undefined) {
            if (this.textWidths.size > 4096) {
                this.textWidths.clear();
            }
            const ctx = this.ctx;
            const previous = ctx.font;
            ctx.font = font === "bold" ? "16px 'OSRS Bold', sans-serif" : "16px 'OSRS Small', sans-serif";
            width = ctx.measureText(text).width;
            ctx.font = previous;
            this.textWidths.set(key, width);
        }
        return width;
    }

    private drawChat(e: LiveEntity, x: number, y: number, loopCycle: number): void {
        const ctx = this.ctx;
        const text = e.chatMessage ?? "";
        ctx.font = "16px 'OSRS Bold', sans-serif";
        let colour = CHAT_COLOURS[0];
        if (e.chatColour < CHAT_COLOURS.length) {
            colour = CHAT_COLOURS[e.chatColour];
        } else {
            // flash1-3 / glow1-3: cycle through a few colours like the client's animated text.
            const phase = Math.floor(loopCycle / 10) % 3;
            colour = ["#ff0000", "#00ff00", "#00ffff"][phase];
        }

        if (e.chatEffect === 1) {
            // wave: per-character vertical sine, as the client draws it.
            const width = ctx.measureText(text).width;
            let cx = x - width / 2;
            ctx.textAlign = "left";
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const dy = Math.sin(i / 2 + loopCycle / 5) * 2;
                this.drawText(ch, cx, y + dy, colour);
                cx += ctx.measureText(ch).width;
            }
            ctx.textAlign = "center";
            return;
        }
        this.drawText(text, x, y, colour);
    }

    // Client.drawEntityOverlays: sprite at (x - 12, y - 12), damage in the 11px font centred
    // at y + 4 in black, then one pixel up and left in white.
    private drawHitmarks(controller: LiveController, e: LiveEntity, pos: ScreenPos, loopCycle: number): void {
        const ctx = this.ctx;
        ctx.font = "16px 'OSRS Small', sans-serif";
        for (let i = 0; i < 4; i++) {
            if (e.damageCycles[i] <= loopCycle) {
                continue;
            }
            const [ox, oy] = HITMARK_OFFSETS[i];
            const x = Math.round(pos.x) + ox;
            const y = Math.round(pos.y) + oy;
            const sprite = this.getHitmark(controller, e.damageTypes[i]);
            if (sprite) {
                ctx.drawImage(sprite, x - 12, y - 12);
            }
            const value = String(e.damageValues[i]);
            ctx.fillStyle = "#000000";
            ctx.fillText(value, x, y + 4);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(value, x - 1, y + 3);
        }
    }

    private getHitmark(controller: LiveController, type: number): HTMLCanvasElement | undefined {
        if (this.hitmarkSource !== controller.hitmarkSprites) {
            this.hitmarkSource = controller.hitmarkSprites;
            this.hitmarks = controller.hitmarkSprites.map(spriteToCanvas);
        }
        return this.hitmarks[type];
    }

    private drawText(text: string, x: number, y: number, colour: string): void {
        const ctx = this.ctx;
        ctx.fillStyle = "#000000";
        ctx.fillText(text, x + 1, y + 1);
        ctx.fillStyle = colour;
        ctx.fillText(text, x, y);
    }

    private project(camera: Camera, fineX: number, fineY: number, fineZ: number, width: number, height: number): ScreenPos | undefined {
        const clip = this.clip;
        vec4.set(clip, fineX / 128, fineY / 128, fineZ / 128, 1);
        vec4.transformMat4(clip, clip, camera.viewProjMatrix);
        if (clip[3] <= 0.01) {
            return undefined;
        }
        const ndcX = clip[0] / clip[3];
        const ndcY = clip[1] / clip[3];
        if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) {
            return undefined;
        }
        return {
            x: (ndcX * 0.5 + 0.5) * width,
            y: (1 - (ndcY * 0.5 + 0.5)) * height,
        };
    }
}

function formatNpcName(npc: LiveNpc): string {
    const level = npc.getCombatLevel();
    return level > 0 ? `${npc.getName()} (level-${level})` : npc.getName();
}

// Palette sprite -> canvas at its full size, sub-image at its crop offset (index 0 is clear),
// so drawing the canvas at (x, y) matches the client's plotSprite(x, y).
function spriteToCanvas(sprite: IndexedSprite): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(sprite.width, 1);
    canvas.height = Math.max(sprite.height, 1);
    if (sprite.subWidth > 0 && sprite.subHeight > 0) {
        const ctx = canvas.getContext("2d")!;
        const image = ctx.createImageData(sprite.subWidth, sprite.subHeight);
        for (let i = 0; i < sprite.pixels.length; i++) {
            const index = sprite.pixels[i];
            if (index === 0) {
                continue;
            }
            const rgb = sprite.palette[index];
            image.data[i * 4] = (rgb >> 16) & 0xff;
            image.data[i * 4 + 1] = (rgb >> 8) & 0xff;
            image.data[i * 4 + 2] = rgb & 0xff;
            image.data[i * 4 + 3] = 0xff;
        }
        ctx.putImageData(image, sprite.xOffset, sprite.yOffset);
    }
    return canvas;
}
