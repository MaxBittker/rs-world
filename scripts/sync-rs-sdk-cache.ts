// Installs an rs-sdk game cache (317-style main_file_cache.dat + idx0-4) into caches/ so the
// viewer renders exactly the map, models and anims the live server uses.
//
//   bun scripts/sync-rs-sdk-cache.ts                       # from ../rs-sdk/server/engine/data/pack
//   bun scripts/sync-rs-sdk-cache.ts --pack <dir>          # from another packed engine checkout
//   bun scripts/sync-rs-sdk-cache.ts --server <url>        # from a running server (/crc, jags, /ondemand.zip)
//   ... --name rs-sdk-289                                  # cache name (default rs-sdk-<revision>)
//
// The engine's own .dat only ever grows (repacks append sectors), so this always writes a fresh,
// compact store containing just the live files.
import fs from "fs";
import JSZip from "jszip";
import path from "path";
import { fileURLToPath } from "url";

const SECTOR_SIZE = 520;
const SECTOR_DATA_SIZE = 512;
const INDEX_COUNT = 5;

// idx0 holds the client's jag archives at these file ids.
const JAG_ARCHIVES = [
    "title",
    "config",
    "interface",
    "media",
    "versionlist",
    "textures",
    "wordenc",
    "sounds",
];

type Store = Uint8Array[][];

function parseArgs(): { pack?: string; server?: string; name?: string; revision?: number } {
    const args: Record<string, string> = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            throw new Error(`Unexpected argument: ${arg}`);
        }
        args[arg.slice(2)] = argv[++i];
    }
    return {
        pack: args.pack,
        server: args.server,
        name: args.name,
        revision: args.revision ? parseInt(args.revision) : undefined,
    };
}

function readStore(dir: string): Store {
    const dat = fs.readFileSync(path.join(dir, "main_file_cache.dat"));
    const store: Store = [];
    for (let index = 0; index < INDEX_COUNT; index++) {
        const idx = fs.readFileSync(path.join(dir, `main_file_cache.idx${index}`));
        const files: Uint8Array[] = [];
        const count = (idx.length / 6) | 0;
        for (let file = 0; file < count; file++) {
            const data = readStoreFile(dat, idx, index, file);
            if (data) {
                files[file] = data;
            }
        }
        store[index] = files;
    }
    return store;
}

function readStoreFile(dat: Uint8Array, idx: Uint8Array, index: number, file: number): Uint8Array | undefined {
    const pos = file * 6;
    const size = (idx[pos] << 16) | (idx[pos + 1] << 8) | idx[pos + 2];
    let sector = (idx[pos + 3] << 16) | (idx[pos + 4] << 8) | idx[pos + 5];
    if (size <= 0 || sector <= 0 || sector * SECTOR_SIZE >= dat.length) {
        return undefined;
    }
    const data = new Uint8Array(size);
    let read = 0;
    for (let part = 0; read < size; part++) {
        if (sector === 0) {
            return undefined;
        }
        const offset = sector * SECTOR_SIZE;
        const sectorFile = (dat[offset] << 8) | dat[offset + 1];
        const sectorPart = (dat[offset + 2] << 8) | dat[offset + 3];
        const nextSector = (dat[offset + 4] << 16) | (dat[offset + 5] << 8) | dat[offset + 6];
        const sectorIndex = dat[offset + 7];
        if (sectorFile !== file || sectorPart !== part || sectorIndex !== index + 1) {
            throw new Error(`Corrupt sector chain for ${index}.${file} at part ${part}`);
        }
        const available = Math.min(SECTOR_DATA_SIZE, size - read);
        data.set(dat.subarray(offset + 8, offset + 8 + available), read);
        read += available;
        sector = nextSector;
    }
    return data;
}

function writeStore(dir: string, store: Store): number {
    let sectorCount = 1; // sector 0 is never used
    for (const files of store) {
        for (const data of files) {
            if (data) {
                sectorCount += Math.ceil(data.length / SECTOR_DATA_SIZE);
            }
        }
    }

    const dat = new Uint8Array(sectorCount * SECTOR_SIZE);
    let nextFree = 1;
    for (let index = 0; index < INDEX_COUNT; index++) {
        const files = store[index] ?? [];
        const idx = new Uint8Array(files.length * 6);
        for (let file = 0; file < files.length; file++) {
            const data = files[file];
            if (!data || data.length === 0) {
                continue;
            }
            const firstSector = nextFree;
            idx.set([data.length >> 16, data.length >> 8, data.length, firstSector >> 16, firstSector >> 8, firstSector], file * 6);
            let written = 0;
            for (let part = 0; written < data.length; part++) {
                const sector = nextFree++;
                const chunk = Math.min(SECTOR_DATA_SIZE, data.length - written);
                const next = written + chunk < data.length ? nextFree : 0;
                const offset = sector * SECTOR_SIZE;
                dat.set([file >> 8, file, part >> 8, part, next >> 16, next >> 8, next, index + 1], offset);
                dat.set(data.subarray(written, written + chunk), offset + 8);
                written += chunk;
            }
        }
        fs.writeFileSync(path.join(dir, `main_file_cache.idx${index}`), idx);
    }
    fs.writeFileSync(path.join(dir, "main_file_cache.dat"), dat);
    return dat.length;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`GET ${url} -> ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
}

async function fetchStore(server: string): Promise<Store> {
    const base = server.replace(/\/+$/, "");

    // /crc is 9 big-endian crcs (jag archive ids 0-8) plus a hash; the client requests /name<crc>.
    const crc = await fetchBytes(`${base}/crc`);
    const jags: Uint8Array[] = [];
    for (let id = 1; id <= JAG_ARCHIVES.length; id++) {
        const value = ((crc[id * 4] << 24) | (crc[id * 4 + 1] << 16) | (crc[id * 4 + 2] << 8) | crc[id * 4 + 3]) | 0;
        jags[id] = await fetchBytes(`${base}/${JAG_ARCHIVES[id - 1]}${value}`);
        console.log(`  ${JAG_ARCHIVES[id - 1]}: ${jags[id].length} bytes`);
    }

    console.log("  downloading /ondemand.zip ...");
    const zip = await JSZip.loadAsync(await fetchBytes(`${base}/ondemand.zip`));
    const store: Store = [jags, [], [], [], []];
    for (const name of Object.keys(zip.files)) {
        const match = /^(\d+)\.(\d+)$/.exec(name);
        if (!match) {
            continue;
        }
        const index = parseInt(match[1]);
        const file = parseInt(match[2]);
        if (index >= 1 && index < INDEX_COUNT) {
            store[index][file] = await zip.files[name].async("uint8array");
        }
    }
    return store;
}

async function fetchRevision(server: string): Promise<number | undefined> {
    try {
        const resp = await fetch(server.replace(/\/+$/, "") + "/api/version");
        const json = (await resp.json()) as { revision?: number };
        return json.revision;
    } catch {
        return undefined;
    }
}

function updateCacheList(cachesDir: string, entry: Record<string, unknown>): void {
    const listPath = path.join(cachesDir, "caches.json");
    let caches: Record<string, unknown>[] = [];
    if (fs.existsSync(listPath)) {
        caches = JSON.parse(fs.readFileSync(listPath, "utf8"));
    }
    caches = caches.filter((cache) => cache.name !== entry.name);
    caches.push(entry);
    fs.writeFileSync(listPath, JSON.stringify(caches));
}

async function main() {
    const args = parseArgs();
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    let store: Store;
    let revision = args.revision;
    let source: string;
    if (args.server) {
        source = args.server;
        console.log(`Fetching cache from ${source}`);
        store = await fetchStore(args.server);
        revision ??= await fetchRevision(args.server);
    } else {
        source = path.resolve(args.pack ?? path.join(root, "../rs-sdk/server/engine/data/pack"));
        console.log(`Reading cache from ${source}`);
        store = readStore(source);
    }
    revision ??= 289;

    const counts = store.map((files) => files.filter(Boolean).length);
    console.log(`Files per index: ${counts.join(", ")}`);
    if (!store[0][2] || !store[0][5] || counts[4] === 0) {
        throw new Error("Cache is missing the config/versionlist archives or maps");
    }

    const name = args.name ?? `rs-sdk-${revision}`;
    const cachesDir = path.join(root, "caches");
    const cacheDir = path.join(cachesDir, name);
    fs.mkdirSync(cacheDir, { recursive: true });

    const size = writeStore(cacheDir, store);
    const timestamp = new Date().toISOString();
    const info = { name, game: "runescape", environment: "live", revision, timestamp, size, source };
    fs.writeFileSync(path.join(cacheDir, "info.json"), JSON.stringify(info, null, 2));
    fs.writeFileSync(path.join(cacheDir, "keys.json"), "{}");
    updateCacheList(cachesDir, { name, game: "runescape", environment: "live", revision, timestamp, size });

    console.log(`Wrote ${cacheDir} (${(size / 1024 / 1024).toFixed(1)} MiB, revision ${revision})`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
