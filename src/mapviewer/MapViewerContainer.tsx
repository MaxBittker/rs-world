import { useCallback, useEffect, useRef, useState } from "react";
import { Joystick } from "react-joystick-component";
import { useSearchParams } from "react-router-dom";

import { RendererCanvas } from "../components/renderer/RendererCanvas";
import { OsrsMenu, OsrsMenuProps } from "../components/rs/menu/OsrsMenu";
import { MinimapContainer } from "../components/rs/minimap/MinimapContainer";
import { WorldMapMarker } from "../components/rs/worldmap/WorldMap";
import { WorldMapModal } from "../components/rs/worldmap/WorldMapModal";
import { InfoPanel } from "../live/InfoPanel";
import { LiveOverlay } from "../live/LiveOverlay";
import { LivePanel } from "../live/LivePanel";
import { RS_TO_DEGREES } from "../rs/MathConstants";
import { isTouchDevice } from "../util/DeviceUtil";
import { MapViewer } from "./MapViewer";
import "./MapViewerContainer.css";
import { MapViewerControls } from "./MapViewerControls";
import { MapViewerRenderer } from "./MapViewerRenderer";

interface MapViewerContainerProps {
    mapViewer: MapViewer;
}

// Hosts the live overlay canvas (names, chat, hitsplats) above the GL canvas, under the HUD.
function LiveOverlayCanvas({ renderer }: { renderer: MapViewerRenderer }): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const overlay: LiveOverlay | undefined = (renderer as { liveOverlay?: LiveOverlay })
            .liveOverlay;
        const container = ref.current;
        if (!overlay || !container) {
            return;
        }
        container.appendChild(overlay.canvas);
        return () => {
            overlay.canvas.remove();
        };
    }, [renderer]);

    return <div ref={ref} className="live-overlay-container" />;
}

export function MapViewerContainer({ mapViewer }: MapViewerContainerProps): JSX.Element {
    const [searchParams, setSearchParams] = useSearchParams();

    const renderer = mapViewer.renderer;

    const [hideUi, setHideUi] = useState(false);
    const [fps, setFps] = useState(0);
    const [cameraYaw, setCameraYaw] = useState(mapViewer.camera.getYaw());
    const [isWorldMapOpen, setWorldMapOpen] = useState<boolean>(false);

    const [menuProps, setMenuProps] = useState<OsrsMenuProps | undefined>(undefined);

    const requestRef = useRef<number | undefined>();

    useEffect(() => {
        if (process.env.NODE_ENV === "development") {
            // Handy for poking at live state from the devtools console. Use the renderer's
            // viewer: in StrictMode the app builds two viewers and the first one renders.
            (window as any).mapViewer = renderer.mapViewer;
        }
    }, [renderer]);

    const animate = (time: DOMHighResTimeStamp) => {
        // Wait for 200ms before updating search params
        if (
            mapViewer.needsSearchParamUpdate &&
            performance.now() - mapViewer.lastTimeSearchParamsUpdated > 200
        ) {
            setSearchParams(mapViewer.getSearchParams(), { replace: true });
            mapViewer.needsSearchParamUpdate = false;
            console.log("Updated search params");
        }

        if (!hideUi) {
            setFps(Math.round(renderer.stats.frameTimeFps));
            setCameraYaw(mapViewer.camera.getYaw());
        }

        if (mapViewer.menuEntries.length > 0 && mapViewer.menuX !== -1 && mapViewer.menuY !== -1) {
            setMenuProps({
                x: mapViewer.menuX,
                y: mapViewer.menuY,
                tooltip: !mapViewer.menuOpen,
                entries: mapViewer.menuEntries,
            });
        } else {
            setMenuProps(undefined);
        }

        requestRef.current = requestAnimationFrame(animate);
    };

    useEffect(() => {
        requestRef.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(requestRef.current!);
    }, [searchParams, hideUi]);

    const resetCameraYaw = useCallback(() => {
        mapViewer.camera.setYaw(0);
    }, [mapViewer]);

    const openWorldMap = useCallback(() => {
        setWorldMapOpen(true);
    }, []);

    const closeWorldMap = useCallback(() => {
        setWorldMapOpen(false);
        renderer.canvas.focus();
    }, [renderer]);

    const onMapClicked = useCallback(
        (x: number, y: number) => {
            mapViewer.live?.unfollow();
            mapViewer.camera.pos[0] = x;
            mapViewer.camera.pos[2] = y;
            mapViewer.camera.updated = true;
            closeWorldMap();
        },
        [mapViewer, closeWorldMap],
    );

    const getMapPosition = useCallback(() => {
        const x = mapViewer.camera.getPosX();
        const y = mapViewer.camera.getPosZ();

        return {
            x,
            y,
        };
    }, [mapViewer]);

    // Live players on the world map: everyone online from the feed's roster, plus the camera.
    const getWorldMapMarkers = useCallback((): WorldMapMarker[] => {
        const markers: WorldMapMarker[] = [];
        const live = mapViewer.live;
        if (live) {
            const followed = live.followName?.toLowerCase();
            for (const [slot, name, x, z, level, combat] of live.world.rosterPlayers) {
                markers.push({
                    key: "p" + slot,
                    x,
                    y: z,
                    label: `${name} (level-${combat})${level > 0 ? `, floor ${level}` : ""}`,
                    color: name.toLowerCase() === followed ? "#ff981f" : "#ffffff",
                });
            }
        }
        markers.push({
            key: "camera",
            x: mapViewer.camera.getPosX(),
            y: mapViewer.camera.getPosZ(),
            label: "Camera",
            color: "#00ffff",
        });
        return markers;
    }, [mapViewer]);

    const onWorldMapMarkerClick = useCallback(
        (marker: WorldMapMarker) => {
            const live = mapViewer.live;
            if (!live || marker.key === "camera") {
                return;
            }
            const entry = live.world.rosterPlayers.find((p) => "p" + p[0] === marker.key);
            if (entry) {
                live.goToPlayer(entry[1], mapViewer.camera);
                closeWorldMap();
            }
        },
        [mapViewer, closeWorldMap],
    );

    const loadMapImageUrl = useCallback(
        (mapX: number, mapY: number) => {
            return mapViewer.getMapImageUrl(mapX, mapY, false);
        },
        [mapViewer],
    );

    const loadMinimapImageUrl = useCallback(
        (mapX: number, mapY: number) => {
            return mapViewer.getMapImageUrl(mapX, mapY, true);
        },
        [mapViewer],
    );

    return (
        <div className="max-height">
            <LiveOverlayCanvas renderer={renderer} />

            {menuProps && <OsrsMenu {...menuProps} />}

            <MapViewerControls renderer={renderer} hideUi={hideUi} setHideUi={setHideUi} />

            {!hideUi && (
                <span>
                    <div className="hud left-top">
                        <MinimapContainer
                            yawDegrees={(2047 - cameraYaw) * RS_TO_DEGREES}
                            onCompassClick={resetCameraYaw}
                            onWorldMapClick={openWorldMap}
                            getPosition={getMapPosition}
                            loadMapImageUrl={loadMinimapImageUrl}
                        />

                        <div className="fps-counter content-text">{fps}</div>
                        <div className="fps-counter content-text">{mapViewer.debugText}</div>
                    </div>
                    <LivePanel mapViewer={mapViewer} />
                    <InfoPanel />
                    <WorldMapModal
                        isOpen={isWorldMapOpen}
                        onRequestClose={closeWorldMap}
                        onDoubleClick={onMapClicked}
                        getPosition={getMapPosition}
                        loadMapImageUrl={loadMapImageUrl}
                        getMarkers={getWorldMapMarkers}
                        onMarkerClick={onWorldMapMarkerClick}
                    />
                </span>
            )}

            {!hideUi && isTouchDevice && (
                <div className="joystick-container left">
                    <Joystick
                        size={75}
                        baseColor="#181C20"
                        stickColor="#007BFF"
                        stickSize={40}
                        move={mapViewer.inputManager.onPositionJoystickMove}
                        stop={mapViewer.inputManager.onPositionJoystickStop}
                    ></Joystick>
                </div>
            )}
            {!hideUi && isTouchDevice && (
                <div className="joystick-container right">
                    <Joystick
                        size={75}
                        baseColor="#181C20"
                        stickColor="#007BFF"
                        stickSize={40}
                        move={mapViewer.inputManager.onCameraJoystickMove}
                        stop={mapViewer.inputManager.onCameraJoystickStop}
                    ></Joystick>
                </div>
            )}

            <RendererCanvas renderer={renderer} />
        </div>
    );
}
