import { useEffect, useMemo, useState } from "react";

import { MapViewer } from "../mapviewer/MapViewer";
import "./LivePanel.css";

const MAX_LISTED_PLAYERS = 250;

function useLiveVersion(mapViewer: MapViewer): void {
    const [, setVersion] = useState(0);
    useEffect(() => {
        // The feed updates every tick; re-render at most 4x a second.
        const id = setInterval(() => setVersion(mapViewer.live?.version ?? 0), 250);
        return () => clearInterval(id);
    }, [mapViewer]);
}

function formatHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

export function LivePanel({ mapViewer }: { mapViewer: MapViewer }): JSX.Element | null {
    useLiveVersion(mapViewer);
    const [search, setSearch] = useState("");
    const [collapsed, setCollapsed] = useState(false);

    const live = mapViewer.live;
    const roster = live?.world.rosterPlayers;
    const rosterTick = live?.world.rosterTick;

    const players = useMemo(() => {
        if (!roster) {
            return [];
        }
        const query = search.trim().toLowerCase();
        return roster
            .filter((p) => !query || p[1].toLowerCase().includes(query))
            .sort((a, b) => a[1].localeCompare(b[1]));
        // rosterTick changes whenever a new roster arrives
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roster, rosterTick, search]);

    if (!live) {
        return null;
    }

    const { world, status, error } = live;
    const followed = live.followName;
    const statusText =
        status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Offline";

    return (
        <div className={"live-panel rs-border rs-background" + (collapsed ? " collapsed" : "")}>
            <div className="live-header" onClick={() => setCollapsed(!collapsed)}>
                <span className={"live-dot " + status} />
                <span className="live-title">{statusText}</span>
                <span className="live-host">{formatHost(live.url)}</span>
                <span className="live-toggle">{collapsed ? "+" : "-"}</span>
            </div>

            {!collapsed && (
                <>
                    {status !== "open" && error && <div className="live-error">{error}</div>}

                    <div className="live-stats">
                        <div>
                            <span className="live-value">{world.rosterPlayers.length}</span> online
                            <span className="live-sep">/</span>
                            <span className="live-value">{world.rosterNpcCount}</span> npcs
                        </div>
                        <div>
                            in view <span className="live-value">{world.players.size}</span>p{" "}
                            <span className="live-value">{world.npcs.size}</span>n
                            <span className="live-sep">/</span>
                            tick <span className="live-value">{world.tick}</span>{" "}
                            <span className="live-dim">{Math.round(world.tickMs)}ms</span>
                        </div>
                    </div>

                    {followed && (
                        <div className="live-follow">
                            Following <span className="live-name">{followed}</span>
                            {!live.getFollowed() && <span className="live-dim"> (finding)</span>}
                            <button className="live-button" onClick={() => live.unfollow()}>
                                Stop
                            </button>
                        </div>
                    )}

                    <input
                        className="live-search"
                        placeholder="Find a player..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && players.length > 0) {
                                live.goToPlayer(players[0][1], mapViewer.camera);
                            }
                        }}
                    />

                    <div className="live-players">
                        {players.slice(0, MAX_LISTED_PLAYERS).map(([slot, name, x, z, level, combat]) => (
                            <div
                                key={slot}
                                className={"live-player" + (name === followed ? " followed" : "")}
                                title={`${x}, ${z}${level > 0 ? `, level ${level}` : ""}`}
                                onClick={() => live.goToPlayer(name, mapViewer.camera)}
                            >
                                <span className="live-name">{name}</span>
                                <span className="live-dim">cb {combat}</span>
                            </div>
                        ))}
                        {players.length > MAX_LISTED_PLAYERS && (
                            <div className="live-dim live-more">
                                +{players.length - MAX_LISTED_PLAYERS} more, refine the search
                            </div>
                        )}
                        {players.length === 0 && (
                            <div className="live-dim live-more">
                                {world.rosterTick === -1 ? "Waiting for roster..." : "No players"}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
