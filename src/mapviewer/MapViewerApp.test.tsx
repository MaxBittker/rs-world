import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { loadCacheFiles } from "./Caches";
import MapViewerApp from "./MapViewerApp";
import { WebGLMapViewerRenderer } from "./webgl/WebGLMapViewerRenderer";

jest.mock("threads", () => ({ registerSerializer: jest.fn() }));
jest.mock("webfontloader", () => ({ load: jest.fn() }));
jest.mock("../util/DeviceUtil", () => ({
    isIos: true,
    isTouchDevice: true,
    isSharedMemorySupported: false,
    isWallpaperEngine: false,
}));
jest.mock("./Caches", () => ({
    fetchCacheList: jest.fn().mockResolvedValue({ latest: { name: "test-cache" } }),
    loadCacheFiles: jest.fn(),
}));
jest.mock("./data/npc/NpcSpawn", () => ({
    fetchNpcSpawns: jest.fn().mockResolvedValue([]),
    getNpcSpawnsUrl: jest.fn(),
}));
jest.mock("./worker/RenderDataLoader", () => ({ renderDataLoaderSerializer: {} }));
jest.mock("./worker/RenderDataWorkerPool", () => ({
    RenderDataWorkerPool: { create: jest.fn().mockReturnValue({}) },
}));
jest.mock("./webgl/WebGLMapViewerRenderer", () => ({
    WebGLMapViewerRenderer: { isSupported: jest.fn() },
}));
jest.mock("./MapViewer", () => ({
    MapViewer: class {
        applySearchParams() {}
        init() {}
    },
}));
jest.mock("./MapViewerContainer", () => ({
    MapViewerContainer: () => <div>World loaded</div>,
}));

beforeEach(() => {
    jest.mocked(loadCacheFiles)
        .mockReset()
        .mockResolvedValue({} as any);
    jest.mocked(WebGLMapViewerRenderer.isSupported).mockReturnValue(true);
    Object.defineProperty(window, "caches", {
        configurable: true,
        value: { open: jest.fn().mockResolvedValue({}) },
    });
});

function openViewer() {
    render(
        <MemoryRouter>
            <MapViewerApp />
        </MemoryRouter>,
    );
}

test("loads on iOS when shared memory is unavailable", async () => {
    openViewer();
    expect(await screen.findByText("World loaded")).toBeInTheDocument();
    expect(screen.queryByText("iOS is not supported.")).not.toBeInTheDocument();
});

test("reports missing WebGL2 before downloading the cache", async () => {
    jest.mocked(WebGLMapViewerRenderer.isSupported).mockReturnValue(false);
    openViewer();
    expect(await screen.findByText(/WebGL2 is not supported/)).toBeInTheDocument();
    expect(loadCacheFiles).not.toHaveBeenCalled();
});

test("shows loading failures instead of leaving a blank screen", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
        jest.mocked(loadCacheFiles).mockRejectedValue(new Error("Cache download failed"));
        openViewer();
        expect(await screen.findByText("Cache download failed")).toBeInTheDocument();
    } finally {
        consoleError.mockRestore();
    }
});
