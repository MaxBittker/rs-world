import { Camera } from "../mapviewer/Camera";
import { LiveController } from "./LiveController";
import { FarPlayerLabel } from "./LiveEntityRenderer";
import { LiveOverlay } from "./LiveOverlay";

// Multi-view: up to 16 followed players in a grid, all drawn by the one WebGL renderer. The
// viewer starts as the normal single view; "+ View" in the Live panel splits it, and closing
// panes down to one returns to the single view. Panes share the GL context, the cache, the
// loaded map squares and the baked entity models; each pane has its own camera, its own small
// feed subscription (the feed streams one area per connection) and its own overlay canvas. The
// first pane's feed carries the roster and hands it to the others.

export const MAX_PANES = 16;

export type PaneRect = { x: number; y: number; w: number; h: number };

export type PaneHandlers = {
    rename(pane: MultiPane, name: string): void;
    close(pane: MultiPane): void;
};

export class MultiPane {
    readonly overlay = new LiveOverlay();
    farLabels: FarPlayerLabel[] = [];
    rect: PaneRect = { x: 0, y: 0, w: 1, h: 1 };
    // Max level this pane draws (its player's floor with Follow Level on).
    level?: number;
    readonly frame: HTMLDivElement;
    readonly input: HTMLInputElement;
    readonly status: HTMLSpanElement;

    constructor(
        readonly camera: Camera,
        readonly live: LiveController,
        handlers: PaneHandlers,
    ) {
        this.frame = document.createElement("div");
        this.frame.className = "multi-pane";

        this.overlay.canvas.classList.add("multi-pane-overlay");
        this.frame.appendChild(this.overlay.canvas);

        const label = document.createElement("div");
        label.className = "multi-pane-label";
        this.input = document.createElement("input");
        this.input.placeholder = "player name";
        this.input.spellcheck = false;
        this.input.value = this.getName() ?? "";
        this.input.addEventListener("keydown", (e) => {
            // Keep keys typed here away from the camera controls.
            e.stopPropagation();
            if (e.key === "Enter") {
                handlers.rename(this, this.input.value.trim());
                this.input.blur();
            } else if (e.key === "Escape") {
                this.input.value = this.getName() ?? "";
                this.input.blur();
            }
        });
        this.input.addEventListener("keyup", (e) => e.stopPropagation());

        const close = document.createElement("button");
        close.className = "multi-pane-close";
        close.title = "Close this view";
        close.textContent = "×";
        close.addEventListener("click", (e) => {
            e.stopPropagation();
            handlers.close(this);
        });

        this.status = document.createElement("span");
        this.status.className = "multi-pane-status";
        label.appendChild(close);
        label.appendChild(this.input);
        label.appendChild(this.status);
        this.frame.appendChild(label);
    }

    getName(): string | undefined {
        return this.live.followName ?? this.live.pendingFollow;
    }

    contains(x: number, y: number): boolean {
        const r = this.rect;
        return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }
}

export class MultiView {
    panes: MultiPane[] = [];
    active: number = 0;
    readonly root: HTMLDivElement;
    private width = -1;
    private height = -1;
    private dirty = true;
    private lastStatusAt = 0;
    private canvas?: HTMLCanvasElement;

    // Clicking or scrolling in a pane selects it; keys, drag, wheel, the Live panel and click
    // menus then act on that pane.
    private readonly onSelect = (e: MouseEvent) => {
        if (!this.canvas) {
            return;
        }
        const rect = this.canvas.getBoundingClientRect();
        this.setActive(this.paneAt(e.clientX - rect.left, e.clientY - rect.top));
    };

    constructor() {
        this.root = document.createElement("div");
        this.root.className = "multi-view";
    }

    addPane(pane: MultiPane): void {
        this.panes.push(pane);
        this.root.appendChild(pane.frame);
        this.dirty = true;
    }

    removePane(pane: MultiPane): void {
        const index = this.panes.indexOf(pane);
        if (index === -1) {
            return;
        }
        const activePane = this.panes[this.active];
        this.panes.splice(index, 1);
        pane.frame.remove();
        this.dirty = true;
        const next =
            activePane === pane
                ? Math.min(index, this.panes.length - 1)
                : this.panes.indexOf(activePane);
        this.active = -1;
        this.setActive(Math.max(next, 0));
    }

    attach(canvas: HTMLCanvasElement, container: HTMLElement): void {
        if (this.canvas !== canvas) {
            this.canvas?.removeEventListener("pointerdown", this.onSelect, { capture: true });
            this.canvas?.removeEventListener("wheel", this.onSelect, { capture: true });
            this.canvas = canvas;
            canvas.addEventListener("pointerdown", this.onSelect, { capture: true });
            canvas.addEventListener("wheel", this.onSelect, { capture: true, passive: true });
        }
        if (this.root.parentElement !== container) {
            container.appendChild(this.root);
        }
    }

    // Leaves the panes' controllers running (the last one carries on as the single view).
    detach(): void {
        this.canvas?.removeEventListener("pointerdown", this.onSelect, { capture: true });
        this.canvas?.removeEventListener("wheel", this.onSelect, { capture: true });
        this.canvas = undefined;
        this.root.remove();
    }

    stop(): void {
        for (const pane of this.panes) {
            pane.live.stop();
        }
        this.panes = [];
        this.detach();
    }

    // Grid that keeps panes closest to square. Rects are in CSS pixels.
    layout(width: number, height: number): void {
        const n = this.panes.length;
        if (n === 0 || (!this.dirty && width === this.width && height === this.height)) {
            return;
        }
        this.width = width;
        this.height = height;
        this.dirty = false;

        let cols = Math.ceil(Math.sqrt(n));
        if (width < height) {
            cols = Math.ceil(n / Math.ceil(Math.sqrt(n)));
        }
        const rows = Math.ceil(n / cols);
        const half = 1;
        for (let i = 0; i < n; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x0 = Math.round((col * width) / cols) + (col > 0 ? half : 0);
            const x1 = Math.round(((col + 1) * width) / cols) - (col < cols - 1 ? half : 0);
            const y0 = Math.round((row * height) / rows) + (row > 0 ? half : 0);
            const y1 = Math.round(((row + 1) * height) / rows) - (row < rows - 1 ? half : 0);
            const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            const pane = this.panes[i];
            pane.rect = rect;
            const style = pane.frame.style;
            style.left = `${rect.x}px`;
            style.top = `${rect.y}px`;
            style.width = `${rect.w}px`;
            style.height = `${rect.h}px`;
        }
    }

    paneAt(x: number, y: number): number {
        return this.panes.findIndex((p) => p.contains(x, y));
    }

    setActive(index: number): void {
        if (index === this.active || index < 0 || index >= this.panes.length) {
            return;
        }
        for (const pane of this.panes) {
            pane.frame.classList.remove("active");
        }
        this.active = index;
        this.panes[index].frame.classList.add("active");
    }

    updateStatus(): void {
        const now = performance.now();
        if (now - this.lastStatusAt < 500) {
            return;
        }
        this.lastStatusAt = now;
        for (const pane of this.panes) {
            const name = pane.getName();
            if (document.activeElement !== pane.input && pane.input.value !== (name ?? "")) {
                pane.input.value = name ?? "";
            }
            let text: string;
            const followed = pane.live.getFollowed();
            if (pane.live.status !== "open") {
                text = pane.live.status;
            } else if (!name) {
                text = "";
            } else if (followed) {
                text = `${followed.x >> 7}, ${followed.z >> 7}`;
            } else {
                const lower = name.toLowerCase();
                const entry = pane.live.world.rosterPlayers.find(
                    (r) => r[1].toLowerCase() === lower,
                );
                text = entry ? "finding…" : "offline";
            }
            if (pane.status.textContent !== text) {
                pane.status.textContent = text;
            }
        }
    }
}
