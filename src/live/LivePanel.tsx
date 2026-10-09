import { useEffect, useRef, useState } from "react";

import { MapViewer } from "../mapviewer/MapViewer";
import "./LivePanel.css";

// Players are rendered 50 at a time; scrolling near the end of the list loads the next 50.
const PAGE_SIZE = 50;
const LOAD_MORE_MARGIN = 100;

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
    const [shownCount, setShownCount] = useState(PAGE_SIZE);
    const [collapsed, setCollapsed] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const followedRef = useRef<HTMLDivElement>(null);
    const scrollToFollowed = useRef(false);

    const players = live?.listPlayers() ?? [];
    const followed = live?.followName;
    const followedKey = followed?.toLowerCase();
    const followedIndex = players.findIndex((p) => p[1].toLowerCase() === followedKey);

    const loadMoreNearEnd = () => {
        const list = listRef.current;
        if (
            list &&
            shownCount < players.length &&
            list.scrollTop + list.clientHeight >= list.scrollHeight - LOAD_MORE_MARGIN
        ) {
            setShownCount((count) => count + PAGE_SIZE);
        }
    };

    // When the followed player changes (next/previous, or a click elsewhere), load the list down
    // to them and scroll them into view.
    useEffect(() => {
        if (followedIndex !== -1) {
            setShownCount((count) =>
                Math.max(count, (Math.floor(followedIndex / PAGE_SIZE) + 1) * PAGE_SIZE),
            );
            scrollToFollowed.current = true;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [followed]);

    useEffect(() => {
        if (scrollToFollowed.current && followedRef.current) {
            scrollToFollowed.current = false;
            followedRef.current.scrollIntoView({ block: "nearest" });
        }
        // Also fills a list too short to scroll yet.
        loadMoreNearEnd();
    });

    if (!live) {
        return null;
    }

    const { world, status, error } = live;
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
                            setShownCount(PAGE_SIZE);
                            if (listRef.current) {
                                listRef.current.scrollTop = 0;
                            }
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && players.length > 0) {
                                live.goToPlayer(players[0][1], mapViewer.camera);
                            }
                        }}
                    />

                    <div className="live-players" ref={listRef} onScroll={loadMoreNearEnd}>
                        {players.slice(0, shownCount).map(([slot, name, x, z, level, combat]) => {
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
                </>
            )}
        </div>
    );
}
