import { useEffect, useRef, useState } from "react";

import { MapViewer } from "../mapviewer/MapViewer";
import "./LivePanel.css";

const PAGE_SIZE = 50;

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
    const live = mapViewer.live;
    const [search, setSearch] = useState(live?.playerFilter ?? "");
    const [page, setPage] = useState(0);
    const [collapsed, setCollapsed] = useState(false);
    const followedRef = useRef<HTMLDivElement>(null);

    const players = live?.listPlayers() ?? [];
    const followed = live?.followName;
    const followedKey = followed?.toLowerCase();
    const followedIndex = players.findIndex((p) => p[1].toLowerCase() === followedKey);

    // Turn to the followed player's page when they change (next/previous, or a click elsewhere).
    useEffect(() => {
        if (followedIndex !== -1) {
            setPage(Math.floor(followedIndex / PAGE_SIZE));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [followed]);

    useEffect(() => {
        followedRef.current?.scrollIntoView({ block: "nearest" });
    }, [followed, page]);

    if (!live) {
        return null;
    }

    const { world, status, error } = live;
    const statusText =
        status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Offline";

    const pageCount = Math.max(1, Math.ceil(players.length / PAGE_SIZE));
    const shownPage = Math.min(page, pageCount - 1);
    const pageStart = shownPage * PAGE_SIZE;
    const pagePlayers = players.slice(pageStart, pageStart + PAGE_SIZE);

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
                        <span className="live-value">{world.rosterPlayers.length}</span> online
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

                    <div className="live-step">
                        <button
                            className="live-button"
                            title="Previous player ([)"
                            disabled={players.length === 0}
                            onClick={() => live.followAdjacent(-1, mapViewer.camera)}
                        >
                            <span className="live-key">[</span> Prev
                        </button>
                        <button
                            className="live-button"
                            title="Next player (])"
                            disabled={players.length === 0}
                            onClick={() => live.followAdjacent(1, mapViewer.camera)}
                        >
                            Next <span className="live-key">]</span>
                        </button>
                    </div>

                    <input
                        className="live-search"
                        placeholder="Find a player..."
                        value={search}
                        onChange={(e) => {
                            live.playerFilter = e.target.value;
                            setSearch(e.target.value);
                            setPage(0);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && players.length > 0) {
                                live.goToPlayer(players[0][1], mapViewer.camera);
                            }
                        }}
                    />

                    <div className="live-players">
                        {pagePlayers.map(([slot, name, x, z, level, combat]) => {
                            const isFollowed = name.toLowerCase() === followedKey;
                            return (
                                <div
                                    key={slot}
                                    ref={isFollowed ? followedRef : undefined}
                                    className={"live-player" + (isFollowed ? " followed" : "")}
                                    title={`${x}, ${z}${level > 0 ? `, level ${level}` : ""}`}
                                    onClick={() => live.goToPlayer(name, mapViewer.camera)}
                                >
                                    <span className="live-name">{name}</span>
                                    <span className="live-dim">cb {combat}</span>
                                </div>
                            );
                        })}
                        {players.length === 0 && (
                            <div className="live-dim live-more">
                                {world.rosterTick === -1 ? "Waiting for roster..." : "No players"}
                            </div>
                        )}
                    </div>

                    {pageCount > 1 && (
                        <div className="live-pager">
                            <button
                                className="live-button"
                                title="Previous page"
                                disabled={shownPage === 0}
                                onClick={() => setPage(shownPage - 1)}
                            >
                                &lt;
                            </button>
                            <span className="live-dim">
                                {pageStart + 1}-{pageStart + pagePlayers.length} of {players.length}
                            </span>
                            <button
                                className="live-button"
                                title="Next page"
                                disabled={shownPage === pageCount - 1}
                                onClick={() => setPage(shownPage + 1)}
                            >
                                &gt;
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
