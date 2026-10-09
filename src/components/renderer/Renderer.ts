import { RenderStats } from "./RenderStats";

// Rendered pixels per CSS pixel. 1 keeps hi-dpi screens from rendering 4-6x the pixels, and the
// slightly softer image suits the old models; "Native" in the Render settings uses the full ratio.
export const DEFAULT_RESOLUTION_SCALE = 1;

function resizeCanvas(canvas: HTMLCanvasElement, scale: number) {
    const width = Math.max(Math.round(canvas.offsetWidth * scale), 1);
    const height = Math.max(Math.round(canvas.offsetHeight * scale), 1);

    if (width !== canvas.width || height !== canvas.height) {
        canvas.width = width;
        canvas.height = height;
        return true;
    }

    return false;
}

export abstract class Renderer {
    canvas: HTMLCanvasElement;
    animationId: number | undefined;
    running: boolean = false;

    fpsLimit: number = 999;

    resolutionScale: number = DEFAULT_RESOLUTION_SCALE;

    stats: RenderStats = new RenderStats();

    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";
        this.canvas.tabIndex = 0;
    }

    abstract init(): Promise<void>;

    abstract cleanUp(): void;

    start() {
        this.running = true;
        this.animationId = requestAnimationFrame(this.frameCallback);
    }

    stop() {
        this.running = false;
        if (this.animationId !== undefined) {
            cancelAnimationFrame(this.animationId);
            this.animationId = undefined;
        }
        this.cleanUp();
    }

    onResize(width: number, height: number) {}

    frameCallback = (time: DOMHighResTimeStamp) => {
        try {
            const resized = resizeCanvas(this.canvas, this.resolutionScale);
            if (resized) {
                this.onResize(this.canvas.width, this.canvas.height);
            }

            const deltaTime = this.stats.getDeltaTime(time);

            if (this.fpsLimit && deltaTime > 0) {
                const tolerance = 1;
                if (deltaTime < 1000 / this.fpsLimit - tolerance) {
                    return;
                }
            }

            this.stats.update(time);

            this.render(time, deltaTime, resized);

            this.onFrameEnd();
        } finally {
            if (this.running) {
                this.animationId = requestAnimationFrame(this.frameCallback);
            }
        }
    };

    abstract render(
        time: DOMHighResTimeStamp,
        deltaTime: DOMHighResTimeStamp,
        resized: boolean,
    ): void;

    onFrameEnd() {
        this.stats.onFrameEnd();
    }
}
