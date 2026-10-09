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

    private reconnectDelay = 1000;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private stopped = false;

    constructor(
        readonly url: string,
        readonly handlers: WorldFeedHandlers,
    ) {}

    connect(): void {
        this.stopped = false;
        this.open();
    }

    close(): void {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.ws = undefined;
        this.setStatus("closed");
    }

    // Tile rectangle to stream, all levels. Only sent when it changes.
    setArea(x: number, z: number, w: number, h: number): void {
        const area = { x: x | 0, z: z | 0, w: w | 0, h: h | 0 };
        const current = this.area;
        if (current && current.x === area.x && current.z === area.z && current.w === area.w && current.h === area.h) {
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
        this.send({ t: "roster", on });
    }

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
                this.send({ t: "roster", on: true });
            }
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
            this.ws = undefined;
            const reason = event.reason || this.error || (event.code !== 1000 ? `closed (${event.code})` : undefined);
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
            this.send({ t: "sub", ...this.area });
        }
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
