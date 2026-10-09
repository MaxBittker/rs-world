import { useEffect, useRef, useState } from "react";

import "./InfoPanel.css";

const UPSTREAM_URL = "https://github.com/dennisdev/rs-map-viewer";
const FORK_URL = "https://github.com/MaxBittker/rs-world";
const RS_SDK_URL = "https://github.com/MaxBittker/rs-sdk";

// Bottom-right "Info" button with a popup crediting the original viewer and linking the repos.
export function InfoPanel(): JSX.Element {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
            }
        };
        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    return (
        <div className="info-panel" ref={ref}>
            {open && (
                <div className="info-popup rs-border rs-background" role="dialog" aria-label="About RS World">
                    <div className="info-title">
                        RS World
                        <span className="info-close" onClick={() => setOpen(false)}>
                            x
                        </span>
                    </div>
                    <p>A live 3D view of the rs-sdk world: every player and npc, as it happens.</p>
                    <p>
                        Built on <a href={UPSTREAM_URL} target="_blank" rel="noreferrer">rs-map-viewer</a> by{" "}
                        <a href="https://github.com/dennisdev" target="_blank" rel="noreferrer">dennisdev</a>,
                        the viewer behind <a href="https://osrs.world" target="_blank" rel="noreferrer">osrs.world</a>.
                        The map renderer and camera are their work.
                    </p>
                    <div className="info-links">
                        <a href={UPSTREAM_URL} target="_blank" rel="noreferrer">
                            <span className="info-label">Original</span> dennisdev/rs-map-viewer
                        </a>
                        <a href={FORK_URL} target="_blank" rel="noreferrer">
                            <span className="info-label">This fork</span> MaxBittker/rs-world
                        </a>
                        <a href={RS_SDK_URL} target="_blank" rel="noreferrer">
                            <span className="info-label">Game + SDK</span> MaxBittker/rs-sdk
                        </a>
                    </div>
                </div>
            )}
            <div className={"info-button rs-border rs-background" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
                Info
            </div>
        </div>
    );
}
