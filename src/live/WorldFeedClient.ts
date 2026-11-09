import { FeedHello, FeedMessage, FeedRoster, FeedTick } from "./protocol";

export type FeedStatus = "connecting" | "open" | "closed";

export type WorldFeedHandlers = {
    onHello(hello: FeedHello): void;
    onTick(tick: FeedTick): void;
    onRoster(roster: FeedRoster): void;
    onStatus(status: FeedStatus, error?: string): void;
};

type Area = { x: number; z: number; w: number; h: number };

const MAX_RECONNECT_DELAY_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

// Keeps one WebSocket to the engine's /worldfeed open, re-subscribing after reconnects.
export class WorldFeedClient {
    ws?: WebSocket;
    status: FeedStatus = "closed";
    error?: string;
    hello?: FeedHello;

    area?: Area;
    roster: boolean = false;

    bytesReceived: number = 0;
    messagesReceived: number = 0;

    // While the tab is hidden nothing is drawn, so the feed streams nothing (the socket stays
    // open); showing it again resubscribes, and the server starts the area over (reset).
    // Read live: the page can be shown before the listener is added.
    private get hidden(): boolean {
        return typeof document !== "undefined" && document.hidden;
    }

    private reconnectDelay = 1000;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private stopped = false;

    constructor(
        readonly url: string,
        readonly handlers: WorldFeedHandlers,
    ) {}

    connect(): void {
        this.stopped = false;
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
        this.open();
    }

    close(): void {
        if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.onVisibilityChange);
        }
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        this.ws?.close();
        this.ws = undefined;
        this.setStatus("closed");
    }

    reconnect(): void {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.heartbeatTimer);
        const previous = this.ws;
        this.ws = undefined;
        if (previous && previous.readyState < WebSocket.CLOSING) {
            previous.close(1000, "Manual reconnect");
        }
        this.reconnectDelay = 1000;
        this.error = undefined;
        this.stopped = false;
        this.open();
    }

    // Tile rectangle to stream, all levels. Only sent when it changes.
    setArea(x: number, z: number, w: number, h: number): void {
        const area = { x: x | 0, z: z | 0, w: w | 0, h: h | 0 };
        const current = this.area;
        if (
            current &&
            current.x === area.x &&
            current.z === area.z &&
            current.w === area.w &&
            current.h === area.h
        ) {
            return;
        }
        this.area = area;
        this.sendArea();
    }

    setRoster(on: boolean): void {
        if (this.roster === on) {
            return;
        }
        this.roster = on;
        this.sendRoster();
    }

    private onVisibilityChange = (): void => {
        this.sendArea();
        this.sendRoster();
    };

    private open(): void {
        this.setStatus("connecting");
        let ws: WebSocket;
        try {
            ws = new WebSocket(this.url);
        } catch (e) {
            this.setStatus("closed", String(e));
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.reconnectDelay = 1000;
            this.setStatus("open");
            this.sendArea();
            if (this.roster) {
                this.sendRoster();
            }
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = setInterval(() => {
                if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ t: "ping" }));
                }
            }, HEARTBEAT_INTERVAL_MS);
        };

        ws.onmessage = (event) => {
            if (typeof event.data !== "string") {
                return;
            }
            this.bytesReceived += event.data.length;
            this.messagesReceived++;
            let msg: FeedMessage;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            switch (msg.t) {
                case "hello":
                    this.hello = msg;
                    this.handlers.onHello(msg);
                    break;
                case "tick":
                    this.handlers.onTick(msg);
                    break;
                case "roster":
                    this.handlers.onRoster(msg);
                    break;
            }
        };

        ws.onerror = () => {
            this.error = "connection error";
        };

        ws.onclose = (event) => {
            if (this.ws !== ws) {
                return;
            }
            clearInterval(this.heartbeatTimer);
            this.ws = undefined;
            const reason =
                event.reason ||
                this.error ||
                (event.code !== 1000 ? `closed (${event.code})` : undefined);
            this.setStatus("closed", reason);
            this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped) {
            return;
        }
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }

    private sendArea(): void {
        if (this.area) {
            this.send(
                this.hidden ? { t: "sub", x: 0, z: 0, w: 0, h: 0 } : { t: "sub", ...this.area },
            );
        }
    }

    private sendRoster(): void {
        this.send({ t: "roster", on: this.roster && !this.hidden });
    }

    private send(msg: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private setStatus(status: FeedStatus, error?: string): void {
        this.status = status;
        this.error = error;
        this.handlers.onStatus(status, error);
    }
}
